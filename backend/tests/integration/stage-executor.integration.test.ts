// 真实 PostgreSQL 集成测试：每个用例写入独立 schema，结束后整体 DROP。
// 仅使用 AI_TEST_DATABASE_URL（gupiao_test），绝不连接生产库。
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inputFingerprint } from '../../src/services/pipeline-checkpoint.js';
import { PipelineRunLease, isLeaseHolder } from '../../src/services/pipeline-run-lease.js';
import { TraceManager } from '../../src/services/trace-manager.js';
import {
  assertArtifactComplete,
  buildArtifactShards,
  commitArtifact,
  isArtifactComplete,
} from '../../src/services/pipeline/artifact-store.js';
import { executeStage, recomputeFrom } from '../../src/services/pipeline/stage-executor.js';
import {
  STAGE_DEPENDENCIES,
  type ArtifactRef,
  type PipelineStage,
  type RunContext,
  type StageId,
} from '../../src/services/pipeline/stage-registry.js';

const connection = process.env.AI_TEST_DATABASE_URL;

interface StageOptions {
  readonly dependencies?: readonly StageId[];
  readonly shardCount?: number;
  readonly calls: { n: number };
  readonly output?: unknown;
}

function makeStage(id: StageId, options: StageOptions): PipelineStage<{ seed: string }, unknown> {
  const payload = options.output ?? { stage: id, value: 42 };
  return {
    id,
    version: '1.0.0',
    dependencies: options.dependencies ?? STAGE_DEPENDENCIES[id],
    async buildInput() { return { seed: `seed:${id}` }; },
    fingerprint(input) { return inputFingerprint(input); },
    async execute(): Promise<ArtifactRef<unknown>> {
      options.calls.n += 1;
      return {
        artifactId: '',
        traceId: '',
        stageId: id,
        version: '1.0.0',
        contentHash: '',
        shardCount: options.shardCount ?? 2,
        payload,
      };
    },
  };
}

function makeContext(traceId: string): RunContext {
  return {
    traceId,
    clusterKey: 'test',
    mode: 'test',
    asOf: '2026-09-07T08:00:00.000Z',
    recipeVersion: 'recipe-1',
    businessConfigHash: 'config-1',
    inputs: {},
    businessConfig: {},
  };
}

describe.skipIf(!connection)('stage executor PostgreSQL integration', () => {
  const schema = 'stage_exec_test_' + randomUUID().replaceAll('-', '');
  let admin: pg.Pool;
  let prisma: PrismaClient;
  let url: string;
  const asOf = new Date('2026-09-07T08:00:00Z');

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: connection! });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    for (const table of ['RunTrace', 'PipelineStepTrace', 'PipelineCheckpoint', 'RunArtifact', 'RunArtifactShard']) {
      await admin.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
    }
    const scoped = new URL(connection!);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    url = scoped.toString();
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }, { schema }) });
  }, 30000);

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "RunArtifactShard","RunArtifact","PipelineStepTrace","PipelineCheckpoint","RunTrace"');
    await TraceManager.startRunTrace(prisma, 'trace', 'test', 'DAILY_RECOMMENDATION', asOf);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
  }, 30000);

  it('阶段连续执行两次：第二次复用且不重复写产物', async () => {
    const calls = { n: 0 };
    const stage = makeStage('news_fetch', { calls, output: { stage: 'news_fetch', value: 7 } });
    const context = makeContext('trace');

    const first = await executeStage(prisma, stage, context);
    expect(first.reused).toBe(false);
    expect(calls.n).toBe(1);
    expect(await prisma.runArtifact.count()).toBe(1);
    const shardCount = await prisma.runArtifactShard.count();
    expect(shardCount).toBe(2);

    const second = await executeStage(prisma, stage, context);
    expect(second.reused).toBe(true);
    expect(second.artifactId).toBe(first.artifactId);
    expect(second.contentHash).toBe(first.contentHash);
    expect(calls.n).toBe(1); // execute 未被再次调用
    expect(await prisma.runArtifact.count()).toBe(1);
    expect(await prisma.runArtifactShard.count()).toBe(shardCount);
  });

  it('分片缺一片：assertArtifactComplete 抛错，isStageComplete 仍需为 false（即便 status=SUCCESS）', async () => {
    const shards = buildArtifactShards({ nodes: [1, 2, 3] }, 3);
    const artifact = await commitArtifact(prisma, {
      traceId: 'trace', stageId: 'graph_snapshot', version: 1,
      inputFingerprint: 'fp', upstreamFingerprints: {}, shardCount: 3, shards,
    });
    expect(await isArtifactComplete(prisma, artifact.id)).toBe(true);
    await expect(assertArtifactComplete(prisma, artifact.id)).resolves.toBeUndefined();

    // 步骤状态先被标为 SUCCESS，随后删掉一片。
    await TraceManager.startStepTrace(prisma, 'trace', 'graph_snapshot', {});
    await TraceManager.completeStepTrace(prisma, 'trace', 'graph_snapshot', { artifactId: artifact.id });
    expect((await prisma.pipelineStepTrace.findFirst({ where: { stepName: 'graph_snapshot' } }))?.status).toBe('SUCCESS');

    await prisma.runArtifactShard.deleteMany({ where: { artifactId: artifact.id, shardIndex: 2 } });
    await expect(assertArtifactComplete(prisma, artifact.id)).rejects.toThrow(/分片不完整/);
    expect(await isArtifactComplete(prisma, artifact.id)).toBe(false);
    expect(await TraceManager.isStageComplete(prisma, { traceId: 'trace', stageId: 'graph_snapshot' })).toBe(false);

    // 缺失产物清单本身的边界
    expect(await TraceManager.isStageComplete(prisma, { traceId: 'trace', stageId: 'theme_forecast' })).toBe(false);
  });

  it('过期执行者：代次被接管后旧 execution 提交产物被拒绝', async () => {
    const leaseA = new PipelineRunLease(url, 'trace');
    await leaseA.start(60000);
    const ownerA = leaseA.owner;
    const generationA = leaseA.currentGeneration();
    await leaseA.close();

    const leaseB = new PipelineRunLease(url, 'trace');
    await leaseB.start(60000);
    const generationB = leaseB.currentGeneration();
    try {
      expect(generationB).toBe(generationA + 1);
      expect(await isLeaseHolder(prisma, { traceId: 'trace', owner: ownerA, generation: generationA })).toBe(false);
      expect(await isLeaseHolder(prisma, { traceId: 'trace', owner: leaseB.owner, generation: generationB })).toBe(true);

      // 旧执行者直接提产物：拒绝。
      const shards = buildArtifactShards({ stale: true }, 1);
      await expect(commitArtifact(prisma, {
        traceId: 'trace', stageId: 'graph_snapshot', version: 1,
        inputFingerprint: 'fp', upstreamFingerprints: {}, shardCount: 1, shards,
        lease: { owner: ownerA, generation: generationA },
      })).rejects.toThrow(/lease lost/i);
      expect(await prisma.runArtifact.count()).toBe(0);

      // 旧执行者经执行器提交：同样拒绝，且不留产物。
      const calls = { n: 0 };
      await expect(executeStage(prisma, makeStage('news_fetch', { calls }), makeContext('trace'), {
        lease: { owner: ownerA, generation: generationA },
      })).rejects.toThrow(/lease lost/i);
      expect(calls.n).toBe(0);
      expect(await prisma.runArtifact.count()).toBe(0);
    } finally {
      await leaseB.close();
    }
  });

  it('失效传播：recomputeFrom 恰好覆盖目标阶段及其全部下游', async () => {
    const completed = new Set<StageId>(['news_fetch', 'news_prepare', 'exposure_refresh', 'market_features', 'penalty_refresh']);
    const affected = recomputeFrom('causal_extract', completed);
    const expected: StageId[] = [
      'causal_extract', 'graph_snapshot', 'expectation_gap', 'theme_forecast',
      'evidence_score', 'recommendation_select', 'recommendation_publish',
      'reconciliation', 'strategy_evaluation',
    ];
    expect([...affected].sort()).toEqual([...expected].sort());
    for (const unrelated of ['news_fetch', 'news_prepare', 'exposure_refresh', 'market_features', 'penalty_refresh'] as StageId[]) {
      expect(affected.has(unrelated)).toBe(false);
    }
    expect(() => recomputeFrom('causal_extract', new Set())).toThrow(/前置阶段/);
  });

  it('中断恢复等价性：提交前中断后重跑，产物与连续执行一致', async () => {
    const context = makeContext('trace');
    const interruptedCalls = { n: 0 };
    const stage = makeStage('news_fetch', { calls: interruptedCalls, output: { stage: 'news_fetch', values: [1, 2, 3, 4] } });

    // 模拟上一进程在「提交前」中断：步骤状态停留在 RUNNING，且无任何产物。
    await TraceManager.startStepTrace(prisma, 'trace', 'news_fetch', { inputFingerprint: 'unknown' });
    expect(await prisma.runArtifact.count()).toBe(0);

    const resumed = await executeStage(prisma, stage, context);
    expect(resumed.reused).toBe(false);
    expect(interruptedCalls.n).toBe(1);

    // 另一条干净 trace 连续执行同一阶段。
    await TraceManager.startRunTrace(prisma, 'trace-clean', 'test', 'DAILY_RECOMMENDATION', asOf);
    const cleanCalls = { n: 0 };
    const clean = await executeStage(prisma, makeStage('news_fetch', { calls: cleanCalls, output: { stage: 'news_fetch', values: [1, 2, 3, 4] } }), makeContext('trace-clean'));

    expect(resumed.contentHash).toBe(clean.contentHash);
    const resumedShards = await prisma.runArtifactShard.findMany({ where: { artifactId: resumed.artifactId }, orderBy: { shardIndex: 'asc' } });
    const cleanShards = await prisma.runArtifactShard.findMany({ where: { artifactId: clean.artifactId }, orderBy: { shardIndex: 'asc' } });
    expect(resumedShards.map((s: any) => s.contentHash)).toEqual(cleanShards.map((s: any) => s.contentHash));
  });

  it('commitArtifact 幂等：同 (traceId, stageId, version) 同内容不重复写入', async () => {
    const shards = buildArtifactShards({ same: true }, 2);
    const input = {
      traceId: 'trace', stageId: 'market_features', version: 5,
      inputFingerprint: 'fp', upstreamFingerprints: {}, shardCount: 2, shards,
    } as const;
    const first = await commitArtifact(prisma, input);
    const second = await commitArtifact(prisma, input);
    expect(second.id).toBe(first.id);
    expect(await prisma.runArtifact.count()).toBe(1);
    expect(await prisma.runArtifactShard.count()).toBe(2);
  });
});
