import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { planAiBatch, type AiBatchSample } from './ai-batch-planner.js';
import { aiRequestContext } from './ai-request-context.js';
import { AiNeedsAttentionError, AiPausedError, AiSplitRequiredError } from './ai-scheduling-errors.js';
import { AiInputError, AiRequestTooLargeError, type AiSourcedArray } from './ai-chat-client.js';
import { loadAiProviderConfig, type IAiProviderConfig } from './ai-provider-config.js';
import { DataRefreshLedgerService } from './data-refresh-ledger-service.js';
import { createCausalSignalInputFingerprint, validateCausalSignalCandidate, type ICausalSignalExtractor, type ICausalSignalExtractionInput, type ICausalSignalCandidateRecord, type ICausalSignalExtractionResult } from './causal-signal-extraction-service.js';
import {
  CONTENT_CACHE_STATUS_CLAIMED,
  CONTENT_CACHE_STATUS_NO_SIGNAL,
  CONTENT_CACHE_STATUS_SUCCESS,
  buildCausalCacheKey,
  claimCacheEntry,
  commitCacheEntry,
  readCommittedCacheEntries,
  releaseCacheLease,
  waitForCommittedCacheEntry,
  type CausalCacheKey,
} from './causal-cache-store.js';
import { TraceManager } from './trace-manager.js';
import { CAUSAL_PROTOCOL_VERSION, CAUSAL_PROTOCOL_VERSION_ITEMS, EXTRACTION_SEMANTIC_VERSION, PROMPT_SCHEMA_VERSION } from '../version.js';

export const AI_WORKFLOW_VERSION = 'causal-workflow-v2';
/** 缓存领取租约时长；心跳周期为其 1/6，远小于租约。 */
const CACHE_LEASE_TTL_MS = 60000;
/** 等待并发持有者提交同键结果的上限；超时抛错而不是重复付费。 */
const CACHE_WAIT_TIMEOUT_MS = 60000;
const durablePromptVersion = (extractor: ICausalSignalExtractor): string => extractor.promptVersion;
const durableProtocolVersion = (extractor: ICausalSignalExtractor): number => extractor.protocolVersion ?? CAUSAL_PROTOCOL_VERSION;
const DURABLE_CACHE_EXPIRES_AT = new Date('2099-12-31T23:59:59.999Z');
/** 只有 v2/v3 协议产出的 ledger artifact 才是可复用缓存。 */
const isSupportedProtocolVersion = (value: unknown): boolean =>
  value === CAUSAL_PROTOCOL_VERSION || value === CAUSAL_PROTOCOL_VERSION_ITEMS;
const isCausalDirection = (value: unknown): value is ICausalSignalCandidateRecord['direction'] =>
  value === 'positive' || value === 'negative' || value === 'mixed' || value === 'neutral';
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

const durableCacheSource = (extractor: ICausalSignalExtractor): string => {
  const base = [
    extractor.extractorType,
    extractor.modelVersion,
    durablePromptVersion(extractor),
  ].join(':');
  const protocol = durableProtocolVersion(extractor);
  return protocol === CAUSAL_PROTOCOL_VERSION ? base : `${base}:protocol-${protocol}`;
};

/**
 * 旧版 trace 的显式判定结果。
 * - `compatible`：版本相符，走新链路（ContentCacheEntry 跨日期缓存）。
 * - `legacy`：版本不符（旧版），交给兼容执行器在旧协议下跑完原 trace。
 * - `unusable`：无 checkpoint 或语义冲突，必须报错而不是静默续跑。
 */
export type ClassifyCheckpointResult =
  | { readonly kind: 'compatible'; readonly workflowVersion: string }
  | { readonly kind: 'legacy'; readonly workflowVersion: string }
  | { readonly kind: 'unusable'; readonly reason: string };

/**
 * 显式判定 checkpoint 是否为当前版本，供执行器选择新链路或兼容执行器。
 * `expected` 传入实际输入的 asOf/clusterKey 时，用于检测语义冲突（必须报错）。
 */
export async function classifyAiCheckpoint(
  prisma: any,
  traceId: string,
  expected?: { readonly asOf?: Date; readonly clusterKey?: string },
): Promise<ClassifyCheckpointResult> {
  const rows = await prisma.$queryRawUnsafe('SELECT version,"clusterKey","leaseUntil",checkpoint->>\'asOf\' AS "checkpointAsOf" FROM "AiWorkflow" WHERE "traceId"=$1', traceId);
  const row = rows[0];
  if (!row) {
    const saved = await prisma.$queryRawUnsafe('SELECT result FROM "PipelineCheckpoint" WHERE "traceId"=$1 AND stage IN (\'prepared\',\'identity\') ORDER BY CASE WHEN stage=\'prepared\' THEN 0 ELSE 1 END LIMIT 1', traceId);
    return saved.length ? { kind: 'compatible', workflowVersion: AI_WORKFLOW_VERSION } : { kind: 'unusable', reason: 'No pipeline checkpoint; start a new trace' };
  }
  if (row.leaseUntil && new Date(row.leaseUntil).getTime() > Date.now()) {
    return { kind: 'unusable', reason: 'This recommendation is already running' };
  }
  // checkpoint.asOf 以 UTC ISO 字符串持久化，避免 TIMESTAMP 列时区解释差异导致的假冲突。
  if (expected?.asOf && new Date(String(row.checkpointAsOf)).getTime() !== expected.asOf.getTime()) {
    return { kind: 'unusable', reason: 'Resume must retain the checkpoint asOf' };
  }
  if (expected?.clusterKey && String(row.clusterKey) !== expected.clusterKey) {
    return { kind: 'unusable', reason: 'Resume must retain the checkpoint cluster' };
  }
  const version = String(row.version);
  return version === AI_WORKFLOW_VERSION
    ? { kind: 'compatible', workflowVersion: version }
    : { kind: 'legacy', workflowVersion: version };
}

export async function readAiCheckpoint(prisma:any, traceId:string):Promise<AiPipelineCheckpoint> {
  const rows=await prisma.$queryRawUnsafe('SELECT * FROM "AiWorkflow" WHERE "traceId"=$1',traceId);
  const row=rows[0];
  if(!row) {
    const saved=await prisma.$queryRawUnsafe('SELECT result FROM "PipelineCheckpoint" WHERE "traceId"=$1 AND stage IN (\'prepared\',\'identity\') ORDER BY CASE WHEN stage=\'prepared\' THEN 0 ELSE 1 END LIMIT 1',traceId);
    if(saved.length)return saved[0].result;
    throw new AiNeedsAttentionError('No pipeline checkpoint; start a new trace');
  }
  if(row.leaseUntil && new Date(row.leaseUntil).getTime()>Date.now())throw new AiNeedsAttentionError('This recommendation is already running');
  // 版本不符不再直接 throw：旧版 checkpoint 原样返回，由 AiWorkflowSession 记录其
  // 真实版本，DurableCausalExtractionService 据此走兼容执行器在旧协议下续跑。
  return row.checkpoint;
}

/**
 * 下游恢复按**实际产物**判定因果抽取阶段是否完成：必须存在 `(traceId,'causal_extract')`
 * 的完整分片产物。绝不再依据 `PipelineStepTrace.status === 'SUCCESS'` 之类的状态位。
 */
export async function isCausalExtractionStageComplete(prisma:any, traceId:string):Promise<boolean> {
  return TraceManager.isStageComplete(prisma,{traceId,stageId:'causal_extract'});
}

/** A completed AI phase is a valid checkpoint for resuming downstream stages. */
export async function readAiWorkflowStatus(prisma:any, traceId:string):Promise<string | null> {
  const rows=await prisma.$queryRawUnsafe('SELECT status FROM "AiWorkflow" WHERE "traceId"=$1',traceId);
  return rows[0]?.status == null ? null : String(rows[0].status);
}

export class AiWorkflowSession {
  public readonly owner=randomUUID();
  public readonly controller=new AbortController();
  /** 该 trace 实际使用的 workflow 版本；start() 时按既有行确定，旧版 trace 保持其原值。 */
  public workflowVersion:string=AI_WORKFLOW_VERSION;
  /** 累计成功领取次数；每 10 次允许规划器安排一次健康模型探测（不发额外探针请求）。 */
  public successfulClaims=0;
  private heartbeat?:ReturnType<typeof setInterval>;
  private deadlineTimer?:ReturnType<typeof setTimeout>;
  private heartbeatRunning=false;
  public constructor(private readonly prisma:any,public readonly traceId:string,public readonly deadline:number) {}
  public async start(checkpoint:AiPipelineCheckpoint):Promise<void> {
    const existing=await this.prisma.$queryRawUnsafe('SELECT version FROM "AiWorkflow" WHERE "traceId"=$1',this.traceId);
    this.workflowVersion=existing.length?String(existing[0].version):AI_WORKFLOW_VERSION;
    await this.prisma.$executeRawUnsafe('INSERT INTO "AiWorkflow"("traceId","asOf","clusterKey",version,checkpoint) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT("traceId") DO NOTHING',this.traceId,new Date(checkpoint.asOf),checkpoint.clusterKey,this.workflowVersion,JSON.stringify(checkpoint));
    const claimed=await this.prisma.$executeRawUnsafe('UPDATE "AiWorkflow" SET status=$2,owner=$3,"leaseUntil"=now()+interval \'60 seconds\',"updatedAt"=now() WHERE "traceId"=$1 AND version=$4 AND status IN (\'PENDING\',\'RUNNING\',\'PAUSED\',\'NEEDS_ATTENTION\',\'AI_COMPLETE\',\'FAILED\') AND (owner IS NULL OR "leaseUntil"<now())',this.traceId,'RUNNING',this.owner,this.workflowVersion);
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
      // 同步续租本 owner 持有的内容缓存领取租约，避免长任务中途被他人接管。
      await this.prisma.$executeRawUnsafe('UPDATE "ContentCacheEntry" SET "leaseUntil"=now()+interval \'60 seconds\' WHERE "leaseOwner"=$1 AND status=$2',this.owner,CONTENT_CACHE_STATUS_CLAIMED);
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
  /**
   * 本次运行中由本 session 自己提交过的缓存条目 id。
   * 这些条目的内容在同一运行内再次出现时不再当作缓存命中，保证每条输入新闻都有独立结果；
   * 跨运行/跨 session 的已提交结果仍然命中（不重复付费）。
   */
  private readonly sessionCommittedEntryIds=new Set<string>();
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
      if(!isSupportedProtocolVersion(artifact.protocolVersion) || !Array.isArray(artifact.signals) || artifact.promptVersion!==durablePromptVersion(this.extractor))continue;
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
          protocolVersion:durableProtocolVersion(this.extractor),
          signals,
          outcome:signals.length?'signals':'no_signal',
          signalCount:signals.length,
          modelVersion:source?.modelVersion ?? this.extractor.modelVersion,
          promptVersion:durablePromptVersion(this.extractor),
        },
      });
    }
  }

  /** 当前抽取器的协议版本（旧实现默认 v2）。 */
  private get protocolVersion():number { return durableProtocolVersion(this.extractor); }
  /** 旧版 trace：只允许原运行续跑，不做跨日期缓存，也不写 ContentCacheEntry。 */
  private isLegacyWorkflow():boolean { return this.session.workflowVersion !== AI_WORKFLOW_VERSION; }

  /**
   * 缓存键：只含抽取语义版本 + prompt/schema 版本 + 协议版本 + 有效输入哈希。
   * 不含 newsId/traceId/批次划分，也不含调度配置（并发/超时/供应商/凭证）。
   */
  private cacheKeyFor(news:ICausalSignalExtractionInput['news'][number]):CausalCacheKey {
    return buildCausalCacheKey({
      inputFingerprint:createCausalSignalInputFingerprint(news),
      promptVersion:durablePromptVersion(this.extractor),
      protocolVersion:this.protocolVersion,
      extractionSemanticVersion:EXTRACTION_SEMANTIC_VERSION,
      schemaVersion:PROMPT_SCHEMA_VERSION,
    });
  }

  /** 原文持久化：写入实际参与抽取的完整新闻字段。 */
  private serializeNews(news:ICausalSignalExtractionInput['news'][number]):string {
    return JSON.stringify({
      id:news.id,
      title:news.title,
      content:news.content,
      source:news.source,
      publishedAt:new Date(news.publishedAt).toISOString(),
      reprintWeight:news.reprintWeight ?? null,
    });
  }

  private cacheResultToCandidates(
    resultJson:unknown,
    input:ICausalSignalExtractionInput,
    news:ICausalSignalExtractionInput['news'][number],
    newsById:ReadonlyMap<string,ICausalSignalExtractionInput['news'][number]>,
  ):ICausalSignalCandidateRecord[] {
    if(!Array.isArray(resultJson))return [];
    const records:ICausalSignalCandidateRecord[]=[];
    for(const raw of resultJson) {
      if(!raw || typeof raw!=='object' || Array.isArray(raw))continue;
      const signal=raw as Record<string,unknown>;
      if(typeof signal.event!=='string'
        || typeof signal.businessVariable!=='string'
        || typeof signal.assetOrThemeKeyword!=='string'
        || !isCausalDirection(signal.direction)
        || typeof signal.confidence!=='number'
        || !Number.isFinite(signal.confidence)
        || typeof signal.evidenceText!=='string')continue;
      records.push(validateCausalSignalCandidate({
        traceId:input.traceId,
        asOf:input.asOf,
        clusterKey:input.clusterKey,
        newsId:news.id,
        event:signal.event,
        businessVariable:signal.businessVariable,
        assetOrThemeKeyword:signal.assetOrThemeKeyword,
        direction:signal.direction,
        confidence:signal.confidence,
        evidenceText:signal.evidenceText,
        evidenceOffsetStart:typeof signal.evidenceOffsetStart==='number'?signal.evidenceOffsetStart:null,
        evidenceOffsetEnd:typeof signal.evidenceOffsetEnd==='number'?signal.evidenceOffsetEnd:null,
        extractorType:this.extractor.extractorType,
        modelVersion:this.extractor.modelVersion,
        promptVersion:durablePromptVersion(this.extractor),
        status:signal.status==='rejected'?'rejected':'candidate',
        failureReason:typeof signal.failureReason==='string'?signal.failureReason:null,
      },newsById));
    }
    return records;
  }

  /** 从 ContentCacheEntry 读取已提交结果并批量落库（跨日期/跨 trace 复用，零 AI 调用）。 */
  private async seedCommittedContentCache(tx:any,input:ICausalSignalExtractionInput):Promise<ReadonlySet<string>> {
    const completed=new Set<string>();
    if(this.isLegacyWorkflow() || input.news.length===0)return completed;
    const newsById=new Map(input.news.map(news=>[news.id,news]));
    const keyed=input.news.map(news=>({news,key:this.cacheKeyFor(news)}));
    const rows=await readCommittedCacheEntries(tx,keyed.map(item=>item.key));
    const byPair=new Map(rows.map(row=>[`${row.cacheKey}:${row.contentVersion}`,row]));
    for(const {news,key} of keyed) {
      const hit=byPair.get(`${key.cacheKey}:${key.contentVersion}`);
      if(!hit)continue;
      const candidates=this.cacheResultToCandidates(hit.resultJson,input,news,newsById);
      if(candidates.length)await tx.causalSignalCandidate.createMany({data:candidates.map(candidate=>({...candidate,confidence:new Prisma.Decimal(candidate.confidence),inputFingerprint:createCausalSignalInputFingerprint(news)})),skipDuplicates:true});
      completed.add(news.id);
    }
    return completed;
  }

  /**
   * 按缓存键领取租约。已被他人持有时等待其提交（绝不重复付费）；超时抛错停止流程。
   */
  private async resolveTaskCache(prisma:any,input:ICausalSignalExtractionInput,task:WorkItem):Promise<{
    readonly claimed:readonly {news:ICausalSignalExtractionInput['news'][number];id:string}[];
    readonly cached:readonly ICausalSignalCandidateRecord[];
    readonly completedNewsIds:ReadonlySet<string>;
  }> {
    if(this.isLegacyWorkflow()) {
      return {claimed:task.input.map(news=>({news,id:''})),cached:[],completedNewsIds:new Set<string>()};
    }
    const newsById=new Map(input.news.map(news=>[news.id,news]));
    const claimed:{news:ICausalSignalExtractionInput['news'][number];id:string}[]=[];
    const cached:ICausalSignalCandidateRecord[]=[];
    const completed=new Set<string>();
    for(const news of task.input) {
      const key=this.cacheKeyFor(news);
      let result=await claimCacheEntry(prisma,{
        ...key,
        promptVersion:durablePromptVersion(this.extractor),
        extractionSemanticVersion:EXTRACTION_SEMANTIC_VERSION,
        schemaVersion:PROMPT_SCHEMA_VERSION,
        rawText:this.serializeNews(news),
      },this.session.owner,CACHE_LEASE_TTL_MS);
      if(result.kind==='busy') {
        if(result.leaseOwner===this.session.owner) {
          // 同一运行内、同一内容已由本 session 领取（同一批次的重复内容）：独立抽取，不重复写缓存。
          claimed.push({news,id:''});
          continue;
        }
        const committed=await waitForCommittedCacheEntry(prisma,key,CACHE_WAIT_TIMEOUT_MS);
        if(!committed)throw new AiNeedsAttentionError('Content cache entry is leased by another run and did not commit in time');
        result={kind:'committed',id:committed.id,status:committed.status,resultJson:committed.resultJson,sourceModel:committed.sourceModel};
      }
      if(result.kind==='committed') {
        if(this.sessionCommittedEntryIds.has(result.id)) {
          // 本 session 本次运行刚提交的同内容条目：为当前新闻独立抽取，保证逐条结果。
          claimed.push({news,id:''});
          continue;
        }
        completed.add(news.id);
        cached.push(...this.cacheResultToCandidates(result.resultJson,input,news,newsById));
      } else {
        claimed.push({news,id:result.id});
      }
    }
    return {claimed,cached,completedNewsIds:completed};
  }

  /** 提交本任务领取到的缓存条目并释放租约。 */
  private async commitClaimedContentCache(
    tx:any,
    claimed:readonly {news:ICausalSignalExtractionInput['news'][number];id:string}[],
    candidates:readonly ICausalSignalCandidateRecord[],
    source?:{readonly providerId:string;readonly model:string;readonly modelVersion:string},
  ):Promise<void> {
    for(const {news,id} of claimed) {
      if(!id)continue; // 运行内重复内容：独立抽取但不重复写缓存。
      const signals=candidates.filter(candidate=>candidate.newsId===news.id);
      const committed=await commitCacheEntry(tx,{
        id,
        status:signals.length?CONTENT_CACHE_STATUS_SUCCESS:CONTENT_CACHE_STATUS_NO_SIGNAL,
        resultJson:signals.map(candidate=>({
          event:candidate.event,
          businessVariable:candidate.businessVariable,
          assetOrThemeKeyword:candidate.assetOrThemeKeyword,
          direction:candidate.direction,
          confidence:candidate.confidence,
          evidenceText:candidate.evidenceText,
          evidenceOffsetStart:candidate.evidenceOffsetStart ?? null,
          evidenceOffsetEnd:candidate.evidenceOffsetEnd ?? null,
          status:candidate.status,
          failureReason:candidate.failureReason ?? null,
        })),
        evidenceOffsetsJson:signals.map(candidate=>({start:candidate.evidenceOffsetStart ?? null,end:candidate.evidenceOffsetEnd ?? null})),
        sourceModel:source?.modelVersion ?? this.extractor.modelVersion,
      },this.session.owner);
      if(!committed)throw new AiPausedError('Content cache lease expired before commit');
      this.sessionCommittedEntryIds.add(id);
    }
  }

  private async run(prisma:any,input:ICausalSignalExtractionInput):Promise<ICausalSignalExtractionResult> {
    if(input.news.some(news=>!Number.isFinite(new Date(news.publishedAt).getTime()) || new Date(news.publishedAt)>input.asOf) || new Set(input.news.map(news=>news.id)).size!==input.news.length) throw new AiNeedsAttentionError('AI input violates the historical time boundary or contains duplicate news IDs');
    if(this.isLegacyWorkflow()) {
      // 语义冲突必须报错：旧版 trace 只允许在原有 asOf/clusterKey 下续跑，绝不静默按新配置继续。
      const legacyRow=await prisma.$queryRawUnsafe('SELECT checkpoint->>\'asOf\' AS "checkpointAsOf","clusterKey" FROM "AiWorkflow" WHERE "traceId"=$1',input.traceId);
      if(!legacyRow.length)throw new AiNeedsAttentionError('No AI workflow row for legacy resume');
      if(new Date(String(legacyRow[0].checkpointAsOf)).getTime()!==input.asOf.getTime() || String(legacyRow[0].clusterKey)!==input.clusterKey)throw new AiNeedsAttentionError('AI input changed; start a new trace');
    }
    const manifestVersion=createHash('sha256').update(JSON.stringify({version:this.session.workflowVersion,prompt:durablePromptVersion(this.extractor),asOf:input.asOf,news:input.news})).digest('hex');
    await prisma.$transaction(async(tx:any)=>{
      const existing=await tx.$queryRawUnsafe('SELECT checkpoint->>\'aiManifestVersion\' AS version FROM "AiWorkflow" WHERE "traceId"=$1 FOR UPDATE',input.traceId);
      if(existing[0]?.version && existing[0].version!==manifestVersion)throw new AiNeedsAttentionError('AI input or prompt changed; start a new trace');
      const count=await tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM "AiWorkItem" WHERE "traceId"=$1',input.traceId);
      if(count[0].count===0) {
        // 新链路以 ContentCacheEntry 为准；ledger 路径保留可用作为兜底。旧版 trace 不读任何跨日期缓存。
        const cachedNewsIds:Set<string>=this.isLegacyWorkflow()?new Set<string>():new Set(await this.seedCommittedContentCache(tx,input));
        if(!this.isLegacyWorkflow()) {
          for(const newsId of await this.seedContentCache(tx,input))cachedNewsIds.add(newsId);
        }
        const unresolvedNews=input.news.filter(news=>!cachedNewsIds.has(news.id));
        const tasks:{id:string;input:ICausalSignalExtractionInput['news']}[]=[];
        // 按规划器返回的桶内稳定前缀切批；已计入批次的新闻从待办中移除，保证不漏不重。
        // plan.count<=0 意味着没有任何模型能容纳剩余新闻，必须显式失败而不是原地打转。
        let pending:[...typeof unresolvedNews]=[...unresolvedNews];
        while(pending.length>0) {
          const plan=planAiBatch(pending,this.config,[],{now:Date.now(),extractionVersion:EXTRACTION_SEMANTIC_VERSION});
          if(!Number.isFinite(plan.count) || plan.count<=0) {
            throw new AiNeedsAttentionError(`批次规划无法容纳剩余新闻（剩余 ${pending.length} 条，reason=${plan.reason}）`);
          }
          const plannedIds=new Set(plan.newsIds ?? []);
          const batch=plannedIds.size>0
            ? pending.filter(news=>plannedIds.has(news.id))
            : pending.slice(0,plan.count);
          if(batch.length===0) {
            throw new AiNeedsAttentionError(`批次规划返回空批次（reason=${plan.reason}）`);
          }
          tasks.push({id:randomUUID(),input:batch});
          const plannedSet=new Set(batch.map(news=>news.id));
          pending=pending.filter(news=>!plannedSet.has(news.id));
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
          const history=await tx.$queryRawUnsafe('SELECT input,result,"updatedAt" FROM "AiWorkItem" WHERE "traceId"=$1 AND status=\'SUCCESS\' ORDER BY "updatedAt" DESC LIMIT 20',input.traceId);
          const samples:AiBatchSample[]=history.flatMap((item:any)=>item.result?.source?.performance?[{newsCount:item.input.length,providerId:item.result.source.providerId,model:item.result.source.model,observedAt:item.updatedAt,extractionVersion:EXTRACTION_SEMANTIC_VERSION,...item.result.source.performance}]:[]).reverse();
          const planOptions={now:Date.now(),extractionVersion:EXTRACTION_SEMANTIC_VERSION,successfulClaims:this.session.successfulClaims};
          // Repack only roots which have never made a paid request; attempted roots retain their budget and identity.
          if(row.id===row.rootId && row.requestCount===0) {
            const others=await tx.$queryRawUnsafe('SELECT * FROM "AiWorkItem" WHERE "traceId"=$1 AND id<>$2 AND id="rootId" AND status=\'PENDING\' AND owner IS NULL AND "requestCount"=0 ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT 64',input.traceId,row.id);
            const combined=[...row.input,...others.flatMap((item:any)=>item.input)];
            const plan=planAiBatch(combined,this.config,samples,planOptions);
            const originalCount=row.input.length;
            // 重打包只是优化：规划不出批次时保持原样，绝不把已准备好的批次清空。
            if(plan.count>0 && plan.count>=originalCount) {
              row.input=combined.slice(0,plan.count);
              let consumed=plan.count-originalCount;
              for(const other of others) {
                if(consumed===0)break;
                const take=Math.min(consumed,other.input.length);consumed-=take;
                const rest=other.input.slice(take);
                if(rest.length)await tx.$executeRawUnsafe('UPDATE "AiWorkItem" SET input=$2::jsonb WHERE id=$1',other.id,JSON.stringify(rest));
                else await tx.$executeRawUnsafe('DELETE FROM "AiWorkItem" WHERE id=$1',other.id);
              }
            } else if(plan.count>0) {
              // Latency/output feedback can shrink even a never-attempted prepared batch.
              const rest=row.input.slice(plan.count);row.input=row.input.slice(0,plan.count);
              const id=randomUUID();
              await tx.$executeRawUnsafe('INSERT INTO "AiWorkItem"(id,"rootId","traceId",input) VALUES($1,$1,$2,$3::jsonb)',id,input.traceId,JSON.stringify(rest));
            }
            await tx.$executeRawUnsafe('UPDATE "AiWorkItem" SET input=$2::jsonb WHERE id=$1',row.id,JSON.stringify(row.input));
          }
          const plan=planAiBatch(row.input,this.config,samples,planOptions);
          if(!Number.isFinite(plan.outputBudget) || plan.outputBudget<=0 || !plan.providerId || !plan.model) {
            // 规划不出可付费的请求就必须停下，不能带着 0 预算或空候选继续跑。
            throw new AiNeedsAttentionError(`批次规划无法为该任务生成可执行请求（reason=${plan.reason}，news=${row.input.length}）`);
          }
          row.outputBudget=plan.outputBudget;
          row.minimumOutputTokens=Math.min(plan.outputBudget,Math.ceil(plan.outputTokens*1.25));
          row.preferredCandidate=JSON.stringify([plan.providerId,plan.model]);
          await tx.$executeRawUnsafe('UPDATE "AiWorkItem" SET status=\'RUNNING\',owner=$2,"leaseUntil"=now()+interval \'60 seconds\',"updatedAt"=now() WHERE id=$1',row.id,this.session.owner);
          return row;
        },{timeout:15000});
        if(!task)break;
        const started=Date.now();
        console.log(`[ai-batch] news=${task.input.length} outputBudget=${task.outputBudget} task=${task.id}`);
        let resolution:{readonly claimed:readonly {news:ICausalSignalExtractionInput['news'][number];id:string}[];readonly cached:readonly ICausalSignalCandidateRecord[];readonly completedNewsIds:ReadonlySet<string>}|undefined;
        try {
          // 领取缓存租约：只有真正拿到租约的新闻才发付费请求，其余消费已提交结果。
          resolution=await this.resolveTaskCache(prisma,input,task);
          const claimedNews=resolution.claimed.map(item=>item.news);
          let fresh:AiSourcedArray<ICausalSignalCandidateRecord>=[];
          if(claimedNews.length>0) {
            fresh=await aiRequestContext.run({rootId:task.rootId,taskId:task.id,owner:this.session.owner,deadline:this.session.deadline,maxAttempts:this.config.scheduling?.maxAttempts ?? 24,signal:this.session.controller.signal,outputTokenBudget:task.outputBudget,minimumOutputTokens:task.minimumOutputTokens,preferredCandidate:task.preferredCandidate},()=>this.extractor.extract({...input,news:claimedNews.map(news=>({...news,publishedAt:new Date(news.publishedAt)}))}));
            this.session.controller.signal.throwIfAborted();
            if(this.extractor.extractorType==='llm' && (!fresh.completedNewsIds
              || fresh.completedNewsIds.length!==claimedNews.length
              || new Set(fresh.completedNewsIds).size!==claimedNews.length
              || claimedNews.some(news=>!fresh.completedNewsIds!.includes(news.id)))) {
              throw new AiInputError('LLM extraction response did not provide an outcome for every input news item');
            }
          }
          const freshCandidates=claimedNews.length===0?[]:fresh.map(candidate=>validateCausalSignalCandidate({...candidate,promptVersion:durablePromptVersion(this.extractor)},newsById));
          const batch=[...resolution.cached,...freshCandidates];
          await prisma.$transaction(async(tx:any)=>{
            const owned=await tx.$queryRawUnsafe('SELECT id FROM "AiWorkItem" WHERE id=$1 AND owner=$2 AND status=\'RUNNING\' AND "leaseUntil">now() FOR UPDATE',task.id,this.session.owner);
            if(!owned.length)throw new AiPausedError('AI task lease expired before commit');
            if(batch.length)await tx.causalSignalCandidate.createMany({data:batch.map(candidate=>({...candidate,confidence:new Prisma.Decimal(candidate.confidence),inputFingerprint:createCausalSignalInputFingerprint(newsById.get(candidate.newsId)!)})),skipDuplicates:true});
            if(!this.isLegacyWorkflow()) {
              await this.commitClaimedContentCache(tx,resolution!.claimed,batch,fresh.aiSource);
              if(claimedNews.length>0)await this.recordContentCache(tx,input,claimedNews,batch,fresh.aiSource);
            }
            await tx.$executeRawUnsafe('UPDATE "AiWorkItem" SET status=\'SUCCESS\',result=$2::jsonb,owner=NULL,"leaseUntil"=NULL,error=NULL,"updatedAt"=now() WHERE id=$1',task.id,JSON.stringify({signals:batch,source:fresh.aiSource}));
          },{timeout:30000});
          completed++;
          this.session.successfulClaims++;
          console.log(`[ai-workflow] completed=${completed} task=${task.id} news=${task.input.length} signals=${batch.length} source=${fresh.aiSource?.providerId}/${fresh.aiSource?.model} elapsedMs=${Date.now()-started}`);
        }catch(error) {
          if(resolution && !this.isLegacyWorkflow() && resolution.claimed.length>0)await releaseCacheLease(prisma,resolution.claimed.map(item=>item.id),this.session.owner).catch(()=>undefined);
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
