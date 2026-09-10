// Requires a migrated test database; every write is isolated in a unique schema.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PipelineRunLease } from '../../src/services/pipeline-run-lease.js';
import { runArtifactStage } from '../../src/services/pipeline-checkpoint.js';
import { TraceManager } from '../../src/services/trace-manager.js';
import { PgDailyReportSnapshotReader } from '../../src/http/daily-report-reader.js';

const connection=process.env.AI_TEST_DATABASE_URL;
describe.skipIf(!connection)('pipeline consistency PostgreSQL integration',()=>{
  const schema='pipeline_test_'+randomUUID().replaceAll('-','');
  let admin:pg.Pool;let prisma:PrismaClient;let url:string;
  const asOf=new Date('2026-09-07T08:00:00Z');
  beforeAll(async()=>{
    admin=new pg.Pool({connectionString:connection!});
    await admin.query(`CREATE SCHEMA "${schema}"`);
    for(const table of ['RunTrace','PipelineStepTrace','PipelineCheckpoint','GraphSnapshot','RecommendationSnapshot']) {
      await admin.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
    }
    const scoped=new URL(connection!);scoped.searchParams.set('options',`-c search_path=${schema}`);url=scoped.toString();
    prisma=new PrismaClient({adapter:new PrismaPg({connectionString:url},{schema})});
  },30000);
  beforeEach(async()=>{
    await prisma.$executeRawUnsafe('TRUNCATE "RunTrace","PipelineStepTrace","PipelineCheckpoint","GraphSnapshot","RecommendationSnapshot"');
    await TraceManager.startRunTrace(prisma,'trace','test','DAILY_RECOMMENDATION',asOf);
  });
  afterAll(async()=>{await prisma?.$disconnect();if(admin){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}},30000);

  it('excludes another process throughout downstream work and releases on close',async()=>{
    const first=new PipelineRunLease(url,'trace');const second=new PipelineRunLease(url,'trace');
    await first.start(60000);
    try {await expect(second.start(60000)).rejects.toThrow('already running');}
    finally {await first.close();}
    const resumed=new PipelineRunLease(url,'trace');await resumed.start(60000);await resumed.close();
  });

  it('aborts a run at its total deadline',async()=>{
    const lease=new PipelineRunLease(url,'trace');await lease.start(10);
    try {await new Promise(resolve=>setTimeout(resolve,20));expect(()=>lease.assertActive()).toThrow('deadline');}
    finally {await lease.close();}
  });

  it('rolls back artifacts when a stage fails and skips only matching committed artifacts',async()=>{
    let calls=0;
    const work=async(tx:any)=>{calls++;await tx.graphSnapshot.create({data:{traceId:'trace',clusterKey:'test',asOf,nodesJson:[],edgesJson:[]}});return {nodeCount:0};};
    await expect(runArtifactStage(prisma,'trace','test','graph',{v:1},['graphSnapshot'],async tx=>{await work(tx);throw new Error('injected failure');})).rejects.toThrow('injected');
    expect(await prisma.graphSnapshot.count()).toBe(0);
    expect((await prisma.pipelineStepTrace.findFirst())?.status).toBe('RUNNING');
    await runArtifactStage(prisma,'trace','test','graph',{v:1},['graphSnapshot'],work);
    await runArtifactStage(prisma,'trace','test','graph',{v:1},['graphSnapshot'],work);
    expect(calls).toBe(2);
    await prisma.graphSnapshot.deleteMany();
    await runArtifactStage(prisma,'trace','test','graph',{v:1},['graphSnapshot'],work);
    expect(calls).toBe(3);
    await runArtifactStage(prisma,'trace','test','graph',{v:2},['graphSnapshot'],work);
    expect(calls).toBe(4);expect(await prisma.graphSnapshot.count()).toBe(1);
  });

  it('publishes recommendations atomically with run success',async()=>{
    await prisma.recommendationSnapshot.create({data:{traceId:'trace',clusterKey:'test',asOf,rank:1,symbol:'600001',stockName:'Test',industry:'Test',finalScore:80,reasons:[],scoreBreakdown:{}}});
    expect((await prisma.recommendationSnapshot.findFirst())?.isPublished).toBe(false);
    await prisma.$executeRawUnsafe(`CREATE FUNCTION fail_success() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='SUCCESS' THEN RAISE EXCEPTION 'injected success failure'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER inject_success_failure BEFORE UPDATE ON "RunTrace" FOR EACH ROW EXECUTE FUNCTION fail_success()');
    try {
      await expect(TraceManager.completeRunTrace(prisma,'trace',{})).rejects.toThrow('injected success failure');
      expect((await prisma.recommendationSnapshot.findFirst())?.isPublished).toBe(false);
    }finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER inject_success_failure ON "RunTrace"');
      await prisma.$executeRawUnsafe('DROP FUNCTION fail_success()');
    }
    await TraceManager.completeRunTrace(prisma,'trace',{});
    expect((await prisma.recommendationSnapshot.findFirst())?.isPublished).toBe(true);
    expect((await prisma.runTrace.findFirst())?.status).toBe('SUCCESS');
  });

  it('does not display snapshots from an unfinished run',async()=>{
    await prisma.recommendationSnapshot.create({data:{traceId:'trace',clusterKey:'test',asOf,rank:1,symbol:'600001',stockName:'Test',industry:'Test',finalScore:80,reasons:[],scoreBreakdown:{}}});
    // The production reader explicitly qualifies public; redirect only that
    // schema to our isolated fixture while executing the actual SQL in PG.
    const reader=new PgDailyReportSnapshotReader({query:async(sql:string,args?:readonly unknown[])=>admin.query(sql.replaceAll('public.',`"${schema}".`),args)} as any);
    expect(await reader.getDailyReport({groupId:'test',displayDate:'2026-09-07'})).toBeNull();
  });
});
