// Explicit dependency: AI_TEST_DATABASE_URL. Creates and drops only a unique test schema.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { AiWorkflowSession,DurableCausalExtractionService,readAiCheckpoint,type AiPipelineCheckpoint } from '../../src/services/ai-causal-workflow.js';
import { PostgresAiSchedulerStore } from '../../src/services/ai-scheduler-store.js';
import { AiAdaptiveScheduler } from '../../src/services/ai-adaptive-scheduler.js';
import { aiRequestContext } from '../../src/services/ai-request-context.js';
import { AiNeedsAttentionError,AiSplitRequiredError } from '../../src/services/ai-scheduling-errors.js';
import { withAiSource } from '../../src/services/ai-chat-client.js';
import type { ICausalSignalExtractor,ICausalSignalExtractionInput } from '../../src/services/causal-signal-extraction-service.js';

const connection=process.env.AI_TEST_DATABASE_URL;
describe.skipIf(!connection)('durable AI workflow PostgreSQL integration',()=>{
  const schema='ai_test_'+randomUUID().replaceAll('-','');
  const asOf=new Date('2026-09-07T08:00:00Z');
  let admin:pg.Pool;let prisma:PrismaClient;let store:PostgresAiSchedulerStore;let url:string;
  const config={scheduling:{globalConcurrency:2,initialBatchSize:1,maxAttempts:24},providers:[{id:'test',baseUrl:'https://test.invalid',apiKey:'not-a-real-key',limits:{minSpacingMs:1},models:[{id:'m',limits:{minSpacingMs:1}}]}]};
  const news=(id:string)=>({id,title:'白银库存下降',content:'白银库存下降，供给不足。',source:'test',publishedAt:asOf});
  const input=(traceId:string):ICausalSignalExtractionInput=>({traceId,asOf,clusterKey:'test',news:[news('a'),news('b'),news('c')]});
  const checkpoint:AiPipelineCheckpoint={asOf:asOf.toISOString(),clusterKey:'test',limit:30,maxPerIndustry:3,newsInput:{sourceMode:'test',sourceSummary:{}},articleCount:3,normalizedCount:3,visibleCandidates:[news('a'),news('b'),news('c')],newsQualityResult:{},aktoolsExposureResult:{},tickflowExposureResult:{},exposureResult:{factCount:500,symbolCount:100},stepTimings:{}};
  const extractor=(call:ICausalSignalExtractor['extract']):ICausalSignalExtractor=>({extractorType:'llm',modelVersion:'test',promptVersion:'test',extract:async input=>{
    const result=await call(input);
    return result.completedNewsIds ? result : withAiSource(result,{providerId:'test',model:'m',modelVersion:'test'},{completedNewsIds:input.news.map(news=>news.id)});
  }});
  beforeAll(async()=>{
    admin=new pg.Pool({connectionString:connection!});
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped=new URL(connection!);scoped.searchParams.set('options',`-c search_path=${schema}`);url=scoped.toString();
    store=new PostgresAiSchedulerStore(url);
    await store.pool.query(readFileSync('prisma/migrations/20260908000000_ai_scheduler/migration.sql','utf8'));
    await store.pool.query('CREATE TABLE "CausalSignalCandidate" (LIKE public."CausalSignalCandidate" INCLUDING ALL); ALTER TABLE "CausalSignalCandidate" ADD COLUMN IF NOT EXISTS "inputFingerprint" TEXT; CREATE TABLE "DataRefreshLedger" (LIKE public."DataRefreshLedger" INCLUDING ALL)');
    prisma=new PrismaClient({adapter:new PrismaPg({connectionString:url},{schema})});
  },30000);
  beforeEach(async()=>{await store.pool.query('TRUNCATE "AiWorkItem","AiWorkflow","AiAttempt","AiSchedulerState","CausalSignalCandidate","DataRefreshLedger" CASCADE');});
  afterAll(async()=>{await prisma?.$disconnect();await store?.pool.end();if(admin){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}},30000);
  it('resumes remaining inputs without repeating successful empty responses',async()=>{
    const trace='resume';const session=new AiWorkflowSession(prisma,trace,Date.now()+60000);await session.start(checkpoint);
    const called:string[]=[];
    await expect(new DurableCausalExtractionService(extractor(async item=>{called.push(item.news[0].id);if(item.news[0].id==='b')throw new AiNeedsAttentionError('temporary credentials issue');return [];}),session,config).execute(prisma,input(trace))).rejects.toBeInstanceOf(AiNeedsAttentionError);
    await session.close('NEEDS_ATTENTION');expect(called.sort()).toEqual(['a','b','c']);
    // A persisted long cooldown must not make a resumed task disappear from the manifest.
    await store.pool.query('UPDATE "AiWorkItem" SET "nextAttemptAt"=now()+interval \'1 hour\' WHERE status=\'NEEDS_ATTENTION\'');
    const cp=await readAiCheckpoint(prisma,trace);expect(cp.asOf).toBe(checkpoint.asOf);
    const resume=new AiWorkflowSession(prisma,trace,Date.now()+60000);await resume.start(cp);
    const retried:string[]=[];await new DurableCausalExtractionService(extractor(async item=>{retried.push(item.news[0].id);return [];}),resume,config).execute(prisma,input(trace));
    await resume.close('SUCCESS');expect(retried).toEqual(['b']);
  },30000);
  it('allows only one process to own a recommendation',async()=>{
    const first=new AiWorkflowSession(prisma,'owned',Date.now()+60000);await first.start(checkpoint);
    const second=new AiWorkflowSession(prisma,'owned',Date.now()+60000);
    await expect(second.start(checkpoint)).rejects.toBeInstanceOf(AiNeedsAttentionError);
    await first.close('PAUSED');
  });
  it('resumes the AI_COMPLETE crash boundary without another model request',async()=>{
    const session=new AiWorkflowSession(prisma,'complete-boundary',Date.now()+60000);
    await session.start(checkpoint);
    let calls=0;
    const empty=extractor(async()=>{calls++;return [];});
    await new DurableCausalExtractionService(empty,session,config).execute(prisma,input('complete-boundary'));
    // Model the durable state left when the process exits before the step trace
    // is marked successful. No PipelineStepTrace is required to recover it.
    await session.close('AI_COMPLETE');
    const before=calls;
    const resumed=new AiWorkflowSession(prisma,'complete-boundary',Date.now()+60000);
    await resumed.start(await readAiCheckpoint(prisma,'complete-boundary'));
    try {await new DurableCausalExtractionService(empty,resumed,config).execute(prisma,input('complete-boundary'));expect(calls).toBe(before);}
    finally {await resumed.close('AI_COMPLETE');}
  });
  it('recovers a crashed owner without losing its unfinished task',async()=>{
    const session=new AiWorkflowSession(prisma,'crash',Date.now()+60000);await session.start(checkpoint);
    await store.pool.query('INSERT INTO "AiWorkItem"(id,"rootId","traceId",input,status,owner,"leaseUntil") VALUES($1,$1,$2,$3,$4,$5,now()-interval \'1 second\')',['crashed','crash',JSON.stringify([news('a')]),'RUNNING','dead-process']);
    const called:string[]=[];
    await new DurableCausalExtractionService(extractor(async item=>{called.push(item.news[0].id);return [];}),session,config).execute(prisma,{...input('crash'),news:[news('a')]});
    expect(called).toEqual(['a']);await session.close('SUCCESS');
  });
  it('pauses immediately if a database failure occurs while claiming work',async()=>{
    const session=new AiWorkflowSession(prisma,'db-failure',Date.now()+60000);await session.start(checkpoint);
    let transactions=0;
    const broken=new Proxy(prisma,{get(target,key){
      if(key==='$transaction')return (...args:any[])=>{if(++transactions>1)throw new Error('connection lost');return (target.$transaction as Function)(...args);};
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    let calls=0;
    try {
      await expect(new DurableCausalExtractionService(extractor(async()=>{calls++;return [];}),session,config).execute(broken,input('db-failure'))).rejects.toThrow('interrupted');
      expect(calls).toBe(0);expect(session.controller.signal.aborted).toBe(true);
    }finally {await session.close('PAUSED');}
  });
  it('pauses at its deadline without consuming a new request budget',async()=>{
    const session=new AiWorkflowSession(prisma,'deadline',Date.now()-1);await session.start(checkpoint);
    await expect(new DurableCausalExtractionService(extractor(async()=>[]),session,config).execute(prisma,input('deadline'))).rejects.toThrow('deadline');
    await session.close('PAUSED');
    const rows=await store.pool.query('SELECT sum("requestCount")::int AS count FROM "AiWorkItem"');expect(rows.rows[0].count).toBe(0);
    expect((await readAiCheckpoint(prisma,'deadline')).asOf).toBe(checkpoint.asOf);
  });
  it('rejects future news before calling AI',async()=>{
    const session=new AiWorkflowSession(prisma,'future',Date.now()+60000);await session.start(checkpoint);let calls=0;
    try {await expect(new DurableCausalExtractionService(extractor(async()=>{calls++;return [];}),session,config).execute(prisma,{...input('future'),news:[{...news('future'),publishedAt:new Date(asOf.getTime()+1)}]})).rejects.toThrow('time boundary');expect(calls).toBe(0);}
    finally {await session.close('NEEDS_ATTENTION');}
  });
  it('counts attempts transactionally across schedulers and retains the budget',async()=>{
    const session=new AiWorkflowSession(prisma,'budget',Date.now()+60000);await session.start(checkpoint);
    await store.pool.query('INSERT INTO "AiWorkItem"(id,"rootId","traceId",input,status,owner,"leaseUntil") VALUES($1,$1,$2,$3,$4,$5,now()+interval \'60 seconds\')',['root','budget','[]','RUNNING',session.owner]);
    const second=new PostgresAiSchedulerStore(url);
    try {
      const candidates=config.providers.flatMap(provider=>provider.models.map(model=>({provider,model,serialized:'{}'})));
      const context={rootId:'root',taskId:'root',owner:session.owner,maxAttempts:1,deadline:Date.now()+60000,signal:session.controller.signal};
      const a=new AiAdaptiveScheduler(config,store);const b=new AiAdaptiveScheduler(config,second);
      const slot=await aiRequestContext.run(context,()=>a.acquire(candidates));await a.finish(slot.candidate!,slot.lease!);
      await new Promise(resolve=>setTimeout(resolve,5));
      await expect(aiRequestContext.run(context,()=>b.acquire(candidates))).rejects.toThrow('budget exhausted');
      const rows=await store.pool.query('SELECT "requestCount" FROM "AiWorkItem" WHERE id=\'root\'');expect(rows.rows[0].requestCount).toBe(1);
    }finally{await second.pool.end();await session.close('PAUSED');}
  });
  it('splits bad batches while children retain their original budget root',async()=>{
    const session=new AiWorkflowSession(prisma,'split',Date.now()+60000);await session.start(checkpoint);
    const seen:number[]=[];
    await new DurableCausalExtractionService(extractor(async item=>{seen.push(item.news.length);if(item.news.length>1)throw new AiSplitRequiredError('length');return [];}),session,{...config,scheduling:{...config.scheduling,initialBatchSize:3}}).execute(prisma,input('split'));
    const rows=await store.pool.query('SELECT count(DISTINCT "rootId")::int AS roots,count(*) FILTER(WHERE status=\'SUCCESS\')::int AS success FROM "AiWorkItem"');
    expect(rows.rows[0]).toEqual({roots:1,success:3});expect(seen[0]).toBe(3);await session.close('SUCCESS');
  },30000);
  it('reuses a content-matched signal in another trace without an AI request',async()=>{
    const firstTrace='content-source';
    const first=new AiWorkflowSession(prisma,firstTrace,Date.now()+60000);await first.start(checkpoint);
    let calls=0;
    const emit=extractor(async item=>{
      calls++;
      const article=item.news[0]!;
      return [{traceId:item.traceId,asOf:item.asOf,clusterKey:item.clusterKey,newsId:article.id,event:'库存下降',businessVariable:'供给不足',assetOrThemeKeyword:'白银',direction:'positive',confidence:0.9,evidenceText:'白银库存下降',extractorType:'llm',modelVersion:'test',promptVersion:'test',status:'candidate'}];
    });
    await new DurableCausalExtractionService(emit,first,config).execute(prisma,{...input(firstTrace),news:[news('source-id')]});
    await first.close('AI_COMPLETE');

    const secondTrace='content-syndicated';
    const second=new AiWorkflowSession(prisma,secondTrace,Date.now()+60000);await second.start(checkpoint);
    const result=await new DurableCausalExtractionService(emit,second,config).execute(prisma,{...input(secondTrace),news:[news('new-source-id')]});
    expect(calls).toBe(1);
    expect(result).toMatchObject({candidateCount:1,acceptedCount:1});
    const candidate=await prisma.causalSignalCandidate.findFirst({where:{traceId:secondTrace}});
    expect(candidate?.newsId).toBe('new-source-id');
    await second.close('AI_COMPLETE');
  },30000);
  it('repacks unattempted work on resume without repeating success or resetting paid budgets',async()=>{
    const trace='repack';const first=new AiWorkflowSession(prisma,trace,Date.now()+60000);await first.start(checkpoint);
    // Prepare one successful and eleven unfinished singleton tasks, as an earlier algorithm would.
    const items=Array.from({length:12},(_,i)=>news('n'+i));
    await store.pool.query('INSERT INTO "AiWorkItem"(id,"rootId","traceId",input,status,"requestCount") SELECT item->>\'id\',item->>\'id\',$1,item->\'input\',item->>\'status\',(item->>\'requests\')::int FROM jsonb_array_elements($2::jsonb) item',[trace,JSON.stringify(items.map((n,i)=>({id:n.id,input:[n],status:i===0?'SUCCESS':'PENDING',requests:i===0?1:i===1?7:0})))]);
    await first.close('PAUSED');const resumed=new AiWorkflowSession(prisma,trace,Date.now()+60000);await resumed.start(await readAiCheckpoint(prisma,trace));
    const called:string[][]=[];
    const adaptive={...config,batching:{},scheduling:{globalConcurrency:1}};
    await new DurableCausalExtractionService(extractor(async item=>{called.push(item.news.map(x=>x.id));return [];}),resumed,adaptive).execute(prisma,{...input(trace),news:items});
    expect(called.flat().sort()).toEqual(items.slice(1).map(x=>x.id).sort());
    expect(called.some(batch=>batch.length>5)).toBe(true);
    const counts=await store.pool.query('SELECT "requestCount" FROM "AiWorkItem" WHERE id=\'n1\'');expect(counts.rows[0].requestCount).toBe(7);
    await resumed.close('SUCCESS');
  },30000);
  it('rolls back candidates if task completion fails',async()=>{
    const session=new AiWorkflowSession(prisma,'rollback',Date.now()+60000);await session.start(checkpoint);
    await store.pool.query("CREATE FUNCTION fail_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='SUCCESS' THEN RAISE EXCEPTION 'injected commit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER inject_failure BEFORE UPDATE ON \"AiWorkItem\" FOR EACH ROW EXECUTE FUNCTION fail_completion()");
    const emit=extractor(async item=>[{traceId:item.traceId,asOf:item.asOf,clusterKey:item.clusterKey,newsId:item.news[0].id,event:'库存下降',businessVariable:'供给不足',assetOrThemeKeyword:'白银',direction:'positive',confidence:0.9,evidenceText:'白银库存下降',extractorType:'llm',modelVersion:'test',promptVersion:'test',status:'candidate'}]);
    try {await expect(new DurableCausalExtractionService(emit,session,config).execute(prisma,input('rollback'))).rejects.toThrow();expect(await prisma.causalSignalCandidate.count()).toBe(0);}
    finally {await store.pool.query('DROP TRIGGER inject_failure ON "AiWorkItem"; DROP FUNCTION fail_completion()');await session.close('PAUSED');}
  },30000);
});
