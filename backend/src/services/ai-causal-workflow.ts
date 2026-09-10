import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { planAiBatch, type AiBatchSample } from './ai-batch-planner.js';
import { aiRequestContext } from './ai-request-context.js';
import { AiNeedsAttentionError, AiPausedError, AiSplitRequiredError } from './ai-scheduling-errors.js';
import { AiInputError, AiRequestTooLargeError } from './ai-chat-client.js';
import { loadAiProviderConfig, type IAiProviderConfig } from './ai-provider-config.js';
import { DataRefreshLedgerService } from './data-refresh-ledger-service.js';
import { createCausalSignalInputFingerprint, validateCausalSignalCandidate, type ICausalSignalExtractor, type ICausalSignalExtractionInput, type ICausalSignalCandidateRecord, type ICausalSignalExtractionResult } from './causal-signal-extraction-service.js';

export const AI_WORKFLOW_VERSION = 'causal-workflow-v2';
const durablePromptVersion = (extractor: ICausalSignalExtractor): string => extractor.promptVersion;
const DURABLE_CACHE_EXPIRES_AT = new Date('2099-12-31T23:59:59.999Z');
export interface AiPipelineCheckpoint {
  asOf: string;
  clusterKey: string;
  limit: number;
  maxPerIndustry: number;
  newsInput: { sourceMode: string; sourceSummary: unknown };
  articleCount: number;
  normalizedCount: number;
  visibleCandidates: any[];
  newsQualityResult: unknown;
  aktoolsExposureResult: unknown;
  tickflowExposureResult: unknown;
  exposureResult: ICheckpointExposure;
  stepTimings: Record<string,number>;
}
interface ICheckpointExposure { factCount: number; symbolCount: number; [key:string]:unknown; }
interface WorkItem { id: string; rootId: string; input: ICausalSignalExtractionInput['news']; status: string; requestCount: number; outputBudget?: number; minimumOutputTokens?:number; preferredCandidate?:string; }

const durableCacheSource = (extractor: ICausalSignalExtractor): string => [
  extractor.extractorType,
  extractor.modelVersion,
  durablePromptVersion(extractor),
].join(':');

export async function readAiCheckpoint(prisma:any, traceId:string):Promise<AiPipelineCheckpoint> {
  const rows=await prisma.$queryRawUnsafe('SELECT * FROM "AiWorkflow" WHERE "traceId"=$1',traceId);
  const row=rows[0];
  if(!row) {
    const saved=await prisma.$queryRawUnsafe('SELECT result FROM "PipelineCheckpoint" WHERE "traceId"=$1 AND stage IN (\'prepared\',\'identity\') ORDER BY CASE WHEN stage=\'prepared\' THEN 0 ELSE 1 END LIMIT 1',traceId);
    if(saved.length)return saved[0].result;
    throw new AiNeedsAttentionError('No pipeline checkpoint; start a new trace');
  }
  if(row.version!==AI_WORKFLOW_VERSION)throw new AiNeedsAttentionError('No compatible AI checkpoint; start a new trace');
  if(row.leaseUntil && new Date(row.leaseUntil).getTime()>Date.now())throw new AiNeedsAttentionError('This recommendation is already running');
  return row.checkpoint;
}

/** A completed AI phase is a valid checkpoint for resuming downstream stages. */
export async function readAiWorkflowStatus(prisma:any, traceId:string):Promise<string | null> {
  const rows=await prisma.$queryRawUnsafe('SELECT status FROM "AiWorkflow" WHERE "traceId"=$1',traceId);
  return rows[0]?.status == null ? null : String(rows[0].status);
}

export class AiWorkflowSession {
  public readonly owner=randomUUID();
  public readonly controller=new AbortController();
  private heartbeat?:ReturnType<typeof setInterval>;
  private deadlineTimer?:ReturnType<typeof setTimeout>;
  private heartbeatRunning=false;
  public constructor(private readonly prisma:any,public readonly traceId:string,public readonly deadline:number) {}
  public async start(checkpoint:AiPipelineCheckpoint):Promise<void> {
    await this.prisma.$executeRawUnsafe('INSERT INTO "AiWorkflow"("traceId","asOf","clusterKey",version,checkpoint) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT("traceId") DO NOTHING',this.traceId,new Date(checkpoint.asOf),checkpoint.clusterKey,AI_WORKFLOW_VERSION,JSON.stringify(checkpoint));
    const claimed=await this.prisma.$executeRawUnsafe('UPDATE "AiWorkflow" SET status=$2,owner=$3,"leaseUntil"=now()+interval \'60 seconds\',"updatedAt"=now() WHERE "traceId"=$1 AND version=$4 AND status IN (\'PENDING\',\'RUNNING\',\'PAUSED\',\'NEEDS_ATTENTION\',\'AI_COMPLETE\',\'FAILED\') AND (owner IS NULL OR "leaseUntil"<now())',this.traceId,'RUNNING',this.owner,AI_WORKFLOW_VERSION);
    if(!claimed)throw new AiNeedsAttentionError('AI workflow is already owned or cannot resume');
    this.deadlineTimer=setTimeout(()=>this.controller.abort(new AiPausedError('One-hour run deadline reached')),Math.max(1,this.deadline-Date.now()));
    this.heartbeat=setInterval(()=>{void this.renew();},10000);
  }
  private async renew():Promise<void> {
    if(this.heartbeatRunning)return;
    this.heartbeatRunning=true;
    try {
      const renewed=await this.prisma.$executeRawUnsafe('UPDATE "AiWorkflow" SET "leaseUntil"=now()+interval \'60 seconds\' WHERE "traceId"=$1 AND owner=$2',this.traceId,this.owner);
      if(!renewed)throw new Error('lease lost');
      await this.prisma.$executeRawUnsafe('UPDATE "AiWorkItem" SET "leaseUntil"=now()+interval \'60 seconds\' WHERE "traceId"=$1 AND owner=$2 AND status IN (\'RUNNING\',\'WAITING\')',this.traceId,this.owner);
    }catch {this.controller.abort(new AiPausedError('Database connection or AI workflow lease lost'));}
    finally {this.heartbeatRunning=false;}
  }
  public async close(status:string):Promise<void> {
    clearInterval(this.heartbeat);clearTimeout(this.deadlineTimer);
    this.controller.abort(new AiPausedError('AI workflow stopped'));
    await this.prisma.$executeRawUnsafe('UPDATE "AiWorkItem" SET status=\'PAUSED\',owner=NULL,"leaseUntil"=NULL,"updatedAt"=now() WHERE "traceId"=$1 AND owner=$2 AND status IN (\'RUNNING\',\'WAITING\')',this.traceId,this.owner);
    await this.prisma.$executeRawUnsafe('UPDATE "AiWorkflow" SET status=$3,owner=NULL,"leaseUntil"=NULL,"updatedAt"=now() WHERE "traceId"=$1 AND owner=$2',this.traceId,this.owner,status);
  }
}

export class DurableCausalExtractionService {
  public constructor(private readonly extractor:ICausalSignalExtractor,private readonly session:AiWorkflowSession,private readonly config:IAiProviderConfig=loadAiProviderConfig()) {}
  public async execute(prisma:any,input:ICausalSignalExtractionInput):Promise<ICausalSignalExtractionResult> {
    try { return await this.run(prisma,input); }
    catch(error) {
      if(error instanceof AiNeedsAttentionError || error instanceof AiPausedError)throw error;
      this.session.controller.abort(new AiPausedError('AI workflow interrupted before completion; resume saved tasks'));
      throw this.session.controller.signal.reason;
    }
  }

  /**
   * Reuse only records whose full LLM input fingerprint, prompt version, and
   * eligible model-chain version match.  Source-local news IDs are never a
   * cache key: syndicated news routinely receives a new ID on the next day.
   */
  private async seedContentCache(tx:any,input:ICausalSignalExtractionInput):Promise<ReadonlySet<string>> {
    const fingerprintToNews=new Map<string,ICausalSignalExtractionInput['news'][number][]>();
    const newsById=new Map(input.news.map(news=>[news.id,news]));
    for(const news of input.news) {
      const fingerprint=createCausalSignalInputFingerprint(news);
      const matching=fingerprintToNews.get(fingerprint) ?? [];
      matching.push(news);
      fingerprintToNews.set(fingerprint,matching);
    }
    const completed=new Set<string>();
    // The ledger is the complete extraction artifact, including zero signals.
    // Individual candidate rows cannot prove that all signals were committed.
    const ledgerRows=await tx.$queryRawUnsafe(
      'SELECT "bucketKey", summary FROM "DataRefreshLedger" WHERE "dataKind"=$1 AND source=$2 AND "clusterKey"=$3 AND "bucketKey"=ANY($4::text[]) AND status=$5 AND "expiresAt">$6 AND "fetchedAt"<=$6',
      'causal_signal_extraction',durableCacheSource(this.extractor),input.clusterKey,[...fingerprintToNews.keys()],'success',input.asOf,
    ) as readonly {bucketKey:string;summary:unknown}[];
    for(const row of ledgerRows) {
      const matching=fingerprintToNews.get(String(row.bucketKey));
      if(!matching)continue;
      let summary:unknown=row.summary;
      if(typeof summary==='string') {
        try {summary=JSON.parse(summary);} catch {continue;}
      }
      if(!summary || typeof summary!=='object' || Array.isArray(summary))continue;
      const artifact=summary as {protocolVersion?:number;signals?:ICausalSignalCandidateRecord[];promptVersion?:string;modelVersion?:string};
      if(artifact.protocolVersion!==2 || !Array.isArray(artifact.signals) || artifact.promptVersion!==durablePromptVersion(this.extractor))continue;
      for(const news of matching) {
        const signals=artifact.signals.map(candidate=>validateCausalSignalCandidate({...candidate,extractorType:this.extractor.extractorType,modelVersion:artifact.modelVersion ?? this.extractor.modelVersion,promptVersion:durablePromptVersion(this.extractor),traceId:input.traceId,asOf:input.asOf,clusterKey:input.clusterKey,newsId:news.id},newsById));
        if(signals.length)await tx.causalSignalCandidate.createMany({data:signals.map(candidate=>({...candidate,confidence:new Prisma.Decimal(candidate.confidence),inputFingerprint:createCausalSignalInputFingerprint(news)})),skipDuplicates:true});
        completed.add(news.id);
      }
    }
    return completed;
  }

  private async recordContentCache(
    tx:any,
    input:ICausalSignalExtractionInput,
    news:readonly ICausalSignalExtractionInput['news'][number][],
    candidates:readonly ICausalSignalCandidateRecord[],
    source?:{readonly providerId:string;readonly model:string;readonly modelVersion:string},
  ):Promise<void> {
    const ledger=new DataRefreshLedgerService();
    for(const item of news) {
      const signals=candidates.filter(candidate=>candidate.newsId===item.id);
      await ledger.recordSuccess(tx,{
        dataKind:'causal_signal_extraction',
        source:durableCacheSource(this.extractor),
        clusterKey:input.clusterKey,
        bucketKey:createCausalSignalInputFingerprint(item),
        fetchedAt:input.asOf,
        expiresAt:DURABLE_CACHE_EXPIRES_AT,
        traceId:input.traceId,
        summary:{
          protocolVersion:2,
          signals,
          outcome:signals.length?'signals':'no_signal',
          signalCount:signals.length,
          modelVersion:source?.modelVersion ?? this.extractor.modelVersion,
          promptVersion:durablePromptVersion(this.extractor),
        },
      });
    }
  }

  private async run(prisma:any,input:ICausalSignalExtractionInput):Promise<ICausalSignalExtractionResult> {
    if(input.news.some(news=>!Number.isFinite(new Date(news.publishedAt).getTime()) || new Date(news.publishedAt)>input.asOf) || new Set(input.news.map(news=>news.id)).size!==input.news.length) throw new AiNeedsAttentionError('AI input violates the historical time boundary or contains duplicate news IDs');
    const manifestVersion=createHash('sha256').update(JSON.stringify({version:AI_WORKFLOW_VERSION,prompt:durablePromptVersion(this.extractor),asOf:input.asOf,news:input.news})).digest('hex');
    await prisma.$transaction(async(tx:any)=>{
      const existing=await tx.$queryRawUnsafe('SELECT checkpoint->>\'aiManifestVersion\' AS version FROM "AiWorkflow" WHERE "traceId"=$1 FOR UPDATE',input.traceId);
      if(existing[0]?.version && existing[0].version!==manifestVersion)throw new AiNeedsAttentionError('AI input or prompt changed; start a new trace');
      const count=await tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM "AiWorkItem" WHERE "traceId"=$1',input.traceId);
      if(count[0].count===0) {
        const cachedNewsIds=await this.seedContentCache(tx,input);
        const unresolvedNews=input.news.filter(news=>!cachedNewsIds.has(news.id));
        const tasks:{id:string;input:ICausalSignalExtractionInput['news']}[]=[];
        let cursor=0;
        while(cursor<unresolvedNews.length) {
          const plan=planAiBatch(unresolvedNews.slice(cursor),this.config);
          tasks.push({id:randomUUID(),input:unresolvedNews.slice(cursor,cursor+plan.count)});
          cursor+=plan.count;
        }
        if(tasks.length)await tx.$executeRawUnsafe('INSERT INTO "AiWorkItem"(id,"rootId","traceId",input) SELECT task->>\'id\',task->>\'id\',$2,task->\'input\' FROM jsonb_array_elements($1::jsonb) AS task',JSON.stringify(tasks),input.traceId);
      }
      await tx.$executeRawUnsafe('UPDATE "AiWorkflow" SET checkpoint=checkpoint || jsonb_build_object(\'aiManifestVersion\',$2::text) WHERE "traceId"=$1',input.traceId,manifestVersion);
      await tx.$executeRawUnsafe('UPDATE "AiWorkItem" SET status=\'PENDING\',owner=NULL,"leaseUntil"=NULL,"nextAttemptAt"=now() WHERE "traceId"=$1 AND (status IN (\'PAUSED\',\'WAITING\',\'NEEDS_ATTENTION\') OR (status=\'RUNNING\' AND "leaseUntil"<now()))',input.traceId);
    },{timeout:30000});
    const before=await prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM "AiWorkItem" WHERE "traceId"=$1 AND status=\'SUCCESS\'',input.traceId);
    let completed=before[0].count;
    const newsById=new Map(input.news.map(news=>[news.id,news]));
    const worker=async()=>{
      while(!this.session.controller.signal.aborted) {
        const task:WorkItem|undefined=await prisma.$transaction(async(tx:any)=>{
          const rows=await tx.$queryRawUnsafe('SELECT * FROM "AiWorkItem" WHERE "traceId"=$1 AND status IN (\'PENDING\',\'WAITING\') AND owner IS NULL AND "nextAttemptAt"<=now() ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT 1',input.traceId);
          const row=rows[0];
          if(!row)return undefined;
          const history=await tx.$queryRawUnsafe('SELECT input,result FROM "AiWorkItem" WHERE "traceId"=$1 AND status=\'SUCCESS\' ORDER BY "updatedAt" DESC LIMIT 20',input.traceId);
          const samples:AiBatchSample[]=history.flatMap((item:any)=>item.result?.source?.performance?[{newsCount:item.input.length,providerId:item.result.source.providerId,model:item.result.source.model,...item.result.source.performance}]:[]).reverse();
          // Repack only roots which have never made a paid request; attempted roots retain their budget and identity.
          if(row.id===row.rootId && row.requestCount===0) {
            const others=await tx.$queryRawUnsafe('SELECT * FROM "AiWorkItem" WHERE "traceId"=$1 AND id<>$2 AND id="rootId" AND status=\'PENDING\' AND owner IS NULL AND "requestCount"=0 ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT 64',input.traceId,row.id);
            const combined=[...row.input,...others.flatMap((item:any)=>item.input)];
            const plan=planAiBatch(combined,this.config,samples);
            const originalCount=row.input.length;
            if(plan.count>=originalCount) {
              row.input=combined.slice(0,plan.count);
              let consumed=plan.count-originalCount;
              for(const other of others) {
                if(consumed===0)break;
                const take=Math.min(consumed,other.input.length);consumed-=take;
                const rest=other.input.slice(take);
                if(rest.length)await tx.$executeRawUnsafe('UPDATE "AiWorkItem" SET input=$2::jsonb WHERE id=$1',other.id,JSON.stringify(rest));
                else await tx.$executeRawUnsafe('DELETE FROM "AiWorkItem" WHERE id=$1',other.id);
              }
            } else {
              // Latency/output feedback can shrink even a never-attempted prepared batch.
              const rest=row.input.slice(plan.count);row.input=row.input.slice(0,plan.count);
              const id=randomUUID();
              await tx.$executeRawUnsafe('INSERT INTO "AiWorkItem"(id,"rootId","traceId",input) VALUES($1,$1,$2,$3::jsonb)',id,input.traceId,JSON.stringify(rest));
            }
            await tx.$executeRawUnsafe('UPDATE "AiWorkItem" SET input=$2::jsonb WHERE id=$1',row.id,JSON.stringify(row.input));
          }
          const plan=planAiBatch(row.input,this.config,samples);row.outputBudget=plan.outputBudget;
          row.minimumOutputTokens=Math.min(plan.outputBudget,Math.ceil(plan.outputTokens*1.25));
          row.preferredCandidate=JSON.stringify([plan.providerId,plan.model]);
          await tx.$executeRawUnsafe('UPDATE "AiWorkItem" SET status=\'RUNNING\',owner=$2,"leaseUntil"=now()+interval \'60 seconds\',"updatedAt"=now() WHERE id=$1',row.id,this.session.owner);
          return row;
        },{timeout:15000});
        if(!task)break;
        const started=Date.now();
        console.log(`[ai-batch] news=${task.input.length} outputBudget=${task.outputBudget} task=${task.id}`);
        try {
          const fresh=await aiRequestContext.run({rootId:task.rootId,taskId:task.id,owner:this.session.owner,deadline:this.session.deadline,maxAttempts:this.config.scheduling?.maxAttempts ?? 24,signal:this.session.controller.signal,outputTokenBudget:task.outputBudget,minimumOutputTokens:task.minimumOutputTokens,preferredCandidate:task.preferredCandidate},()=>this.extractor.extract({...input,news:task.input.map(news=>({...news,publishedAt:new Date(news.publishedAt)}))}));
          this.session.controller.signal.throwIfAborted();
          if(this.extractor.extractorType==='llm' && (!fresh.completedNewsIds
            || fresh.completedNewsIds.length!==task.input.length
            || new Set(fresh.completedNewsIds).size!==task.input.length
            || task.input.some(news=>!fresh.completedNewsIds!.includes(news.id)))) {
            throw new AiInputError('LLM extraction response did not provide an outcome for every input news item');
          }
          const batch=fresh.map(candidate=>validateCausalSignalCandidate({...candidate,promptVersion:durablePromptVersion(this.extractor)},newsById));
          await prisma.$transaction(async(tx:any)=>{
            const owned=await tx.$queryRawUnsafe('SELECT id FROM "AiWorkItem" WHERE id=$1 AND owner=$2 AND status=\'RUNNING\' AND "leaseUntil">now() FOR UPDATE',task.id,this.session.owner);
            if(!owned.length)throw new AiPausedError('AI task lease expired before commit');
            if(batch.length)await tx.causalSignalCandidate.createMany({data:batch.map(candidate=>({...candidate,confidence:new Prisma.Decimal(candidate.confidence),inputFingerprint:createCausalSignalInputFingerprint(newsById.get(candidate.newsId)!)})),skipDuplicates:true});
            await this.recordContentCache(tx,input,task.input,batch,fresh.aiSource);
            await tx.$executeRawUnsafe('UPDATE "AiWorkItem" SET status=\'SUCCESS\',result=$2::jsonb,owner=NULL,"leaseUntil"=NULL,error=NULL,"updatedAt"=now() WHERE id=$1',task.id,JSON.stringify({signals:batch,source:fresh.aiSource}));
          },{timeout:30000});
          completed++;
          console.log(`[ai-workflow] completed=${completed} task=${task.id} news=${task.input.length} signals=${batch.length} source=${fresh.aiSource?.providerId}/${fresh.aiSource?.model} elapsedMs=${Date.now()-started}`);
        }catch(error) {
          if(this.session.controller.signal.aborted)throw this.session.controller.signal.reason;
          if((error instanceof AiSplitRequiredError || error instanceof AiRequestTooLargeError) && task.input.length>1) {
            await prisma.$transaction(async(tx:any)=>{
              const updated=await tx.$executeRawUnsafe('UPDATE "AiWorkItem" SET status=\'SPLIT\',owner=NULL,"leaseUntil"=NULL WHERE id=$1 AND owner=$2',task.id,this.session.owner);
              if(!updated)throw new AiPausedError('AI task lease lost during split');
              const mid=Math.ceil(task.input.length/2);
              for(const news of [task.input.slice(0,mid),task.input.slice(mid)])await tx.$executeRawUnsafe('INSERT INTO "AiWorkItem"(id,"rootId","traceId",input) VALUES($1,$2,$3,$4::jsonb)',randomUUID(),task.rootId,input.traceId,JSON.stringify(news));
            });
          }else if(error instanceof AiNeedsAttentionError || error instanceof AiSplitRequiredError || error instanceof AiInputError) {
            await prisma.$executeRawUnsafe('UPDATE "AiWorkItem" SET status=\'NEEDS_ATTENTION\',error=$2,owner=NULL,"leaseUntil"=NULL WHERE id=$1 AND owner=$3',task.id,error.message,this.session.owner);
          }else { this.session.controller.abort(error instanceof AiPausedError?error:new AiPausedError('AI execution interrupted; saved tasks can be resumed')); throw error; }
        }
      }
    };
    const outcomes=await Promise.allSettled(Array.from({length:this.config.scheduling?.globalConcurrency ?? 10},async()=>{
      try { await worker(); }
      catch(error) {
        // This also covers database errors while claiming, before the per-task try block.
        this.session.controller.abort(error instanceof AiPausedError?error:new AiPausedError('AI worker interrupted; resume saved tasks'));
        throw error;
      }
    }));
    if(this.session.controller.signal.aborted)throw this.session.controller.signal.reason;
    const failed=outcomes.find(item=>item.status==='rejected');
    if(failed?.status==='rejected')throw failed.reason;
    const pending=await prisma.$queryRawUnsafe('SELECT status,count(*)::int AS count FROM "AiWorkItem" WHERE "traceId"=$1 AND status NOT IN (\'SUCCESS\',\'SPLIT\') GROUP BY status',input.traceId);
    if(pending.length)throw new AiNeedsAttentionError('AI tasks require attention: '+JSON.stringify(pending));
    const candidates:ICausalSignalCandidateRecord[]=await prisma.causalSignalCandidate.findMany({where:{traceId:input.traceId}});
    await prisma.$executeRawUnsafe('UPDATE "AiWorkflow" SET status=\'AI_COMPLETE\' WHERE "traceId"=$1 AND owner=$2',input.traceId,this.session.owner);
    return {candidateCount:candidates.length,acceptedCount:candidates.filter(x=>x.status==='candidate').length,rejectedCount:candidates.filter(x=>x.status==='rejected').length,cacheHitCount:before[0].count,insertedCount:candidates.length,extractorType:'llm',failures:[],sample:candidates.slice(0,10).map(x=>({newsId:x.newsId,status:x.status,modelVersion:x.modelVersion}))};
  }
}
