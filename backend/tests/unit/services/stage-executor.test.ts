import { describe, expect, it } from 'vitest';
import { MemoryPrisma } from '../fixtures/pipeline-fixtures.js';
import {
  assertArtifactComplete,
  buildArtifactShards,
  commitArtifact,
  invalidateDependents,
  isArtifactComplete,
  isStageInvalidated,
} from '../../../src/services/pipeline/artifact-store.js';
import { PIPELINE_LEASE_STAGE, isLeaseHolder } from '../../../src/services/pipeline-run-lease.js';
import { recomputeFrom } from '../../../src/services/pipeline/stage-executor.js';
import type { StageId } from '../../../src/services/pipeline/stage-registry.js';

const newPrisma = (): any => new MemoryPrisma();

describe('recomputeFrom', () => {
  const upstream: StageId[] = ['news_fetch', 'news_prepare', 'exposure_refresh', 'market_features', 'penalty_refresh'];

  it('包含目标阶段及其全部下游，且不含无关阶段', () => {
    const affected = recomputeFrom('causal_extract', new Set(upstream));
    expect([...affected].sort()).toEqual([
      'causal_extract', 'graph_snapshot', 'expectation_gap', 'theme_forecast',
      'evidence_score', 'recommendation_select', 'recommendation_publish',
      'reconciliation', 'strategy_evaluation',
    ].sort());
    for (const unrelated of upstream) expect(affected.has(unrelated)).toBe(false);
  });

  it('根阶段（无依赖）不要求任何前置', () => {
    expect(recomputeFrom('news_fetch', new Set())).toEqual(new Set<StageId>(['news_fetch', 'news_prepare', 'causal_extract', 'graph_snapshot', 'expectation_gap', 'theme_forecast', 'evidence_score', 'recommendation_select', 'recommendation_publish', 'reconciliation', 'strategy_evaluation']));
  });

  it('前置未完成时抛错', () => {
    expect(() => recomputeFrom('causal_extract', new Set())).toThrow(/前置阶段 news_prepare/);
  });
});

describe('invalidateDependents / isStageInvalidated', () => {
  it('沿 dependentsOf 传递且不含自身', () => {
    const downstream = invalidateDependents('causal_extract');
    expect(downstream).not.toContain('causal_extract');
    expect(downstream).toContain('graph_snapshot');
    expect(downstream).not.toContain('news_fetch');
    expect(isStageInvalidated('causal_extract', 'recommendation_publish')).toBe(true);
    expect(isStageInvalidated('causal_extract', 'market_features')).toBe(false);
    expect(isStageInvalidated('causal_extract', 'causal_extract')).toBe(true);
  });
});

describe('isLeaseHolder', () => {
  const seed = async (prisma: any, record: Record<string, unknown>): Promise<void> => {
    await prisma.pipelineCheckpoint.create({ data: { traceId: 'trace', stage: PIPELINE_LEASE_STAGE, input: 'lease', result: record } });
  };

  it('owner、generation、租约未过期三者全中才为真', async () => {
    const prisma = newPrisma();
    await seed(prisma, { owner: 'alice', leaseUntil: new Date(Date.now() + 60000).toISOString(), generation: 3 });
    expect(await isLeaseHolder(prisma, { traceId: 'trace', owner: 'alice', generation: 3 })).toBe(true);
  });

  it('owner 不匹配为假', async () => {
    const prisma = newPrisma();
    await seed(prisma, { owner: 'alice', leaseUntil: new Date(Date.now() + 60000).toISOString(), generation: 3 });
    expect(await isLeaseHolder(prisma, { traceId: 'trace', owner: 'bob', generation: 3 })).toBe(false);
  });

  it('generation 不匹配为假', async () => {
    const prisma = newPrisma();
    await seed(prisma, { owner: 'alice', leaseUntil: new Date(Date.now() + 60000).toISOString(), generation: 3 });
    expect(await isLeaseHolder(prisma, { traceId: 'trace', owner: 'alice', generation: 2 })).toBe(false);
  });

  it('租约到期为假', async () => {
    const prisma = newPrisma();
    const past = new Date(Date.now() - 1000).toISOString();
    await seed(prisma, { owner: 'alice', leaseUntil: past, generation: 3 });
    expect(await isLeaseHolder(prisma, { traceId: 'trace', owner: 'alice', generation: 3 })).toBe(false);
  });

  it('无租约记录为假', async () => {
    expect(await isLeaseHolder(newPrisma(), { traceId: 'trace', owner: 'alice', generation: 1 })).toBe(false);
  });
});

describe('assertArtifactComplete 边界', () => {
  const seedArtifact = async (prisma: any, shardCount: number, indices: number[]): Promise<string> => {
    const artifact = await prisma.runArtifact.create({
      data: { traceId: 'trace', stageId: 'graph_snapshot', version: 1, inputFingerprint: 'fp', upstreamFingerprints: {}, shardCount, contentHash: 'h' },
    });
    await prisma.runArtifactShard.createMany({
      data: indices.map((shardIndex) => ({ artifactId: artifact.id, shardIndex, contentHash: `h${shardIndex}`, byteSize: 1 })),
    });
    return artifact.id as string;
  };

  it('完整分片通过', async () => {
    const prisma = newPrisma();
    const id = await seedArtifact(prisma, 2, [0, 1]);
    await expect(assertArtifactComplete(prisma, id)).resolves.toBeUndefined();
    expect(await isArtifactComplete(prisma, id)).toBe(true);
  });

  it('分片数少于 shardCount 抛错', async () => {
    const prisma = newPrisma();
    const id = await seedArtifact(prisma, 3, [0, 1]);
    await expect(assertArtifactComplete(prisma, id)).rejects.toThrow(/分片不完整/);
  });

  it('分片索引缺失（重复索引）抛错', async () => {
    const prisma = newPrisma();
    const id = await seedArtifact(prisma, 2, [0, 0]);
    await expect(assertArtifactComplete(prisma, id)).rejects.toThrow(/重复|覆盖不完整/);
  });

  it('产物清单不存在抛错', async () => {
    await expect(assertArtifactComplete(newPrisma(), 'missing')).rejects.toThrow(/产物不存在/);
  });

  it('分片记录数大于零但为空内容哈希仍判为不完整', async () => {
    const prisma = newPrisma();
    const artifact = await prisma.runArtifact.create({
      data: { traceId: 'trace', stageId: 'graph_snapshot', version: 1, inputFingerprint: 'fp', upstreamFingerprints: {}, shardCount: 1, contentHash: 'h' },
    });
    await prisma.runArtifactShard.create({ data: { artifactId: artifact.id, shardIndex: 0, contentHash: '', byteSize: 0 } });
    expect(await isArtifactComplete(prisma, artifact.id)).toBe(false);
  });
});

describe('commitArtifact 幂等（MemoryPrisma）', () => {
  it('同版同内容返回既有产物且不重复写入', async () => {
    const prisma = newPrisma();
    const shards = buildArtifactShards({ value: 1 }, 2);
    const input = {
      traceId: 'trace', stageId: 'news_fetch' as StageId, version: 1,
      inputFingerprint: 'fp', upstreamFingerprints: {}, shardCount: 2, shards,
    } as const;
    const first = await commitArtifact(prisma, input);
    const second = await commitArtifact(prisma, input);
    expect(second.id).toBe(first.id);
    expect(prisma.runArtifact.rows).toHaveLength(1);
    expect(prisma.runArtifactShard.rows).toHaveLength(2);
  });

  it('同版不同内容抛冲突', async () => {
    const prisma = newPrisma();
    const base = { traceId: 'trace', stageId: 'news_fetch' as StageId, version: 1, inputFingerprint: 'fp', upstreamFingerprints: {}, shardCount: 1 };
    await commitArtifact(prisma, { ...base, shards: buildArtifactShards({ value: 1 }, 1) });
    await expect(commitArtifact(prisma, { ...base, shards: buildArtifactShards({ value: 2 }, 1) })).rejects.toThrow(/不可变产物冲突/);
  });

  it('分片布局非法直接抛错', async () => {
    const prisma = newPrisma();
    await expect(commitArtifact(prisma, {
      traceId: 'trace', stageId: 'news_fetch' as StageId, version: 1,
      inputFingerprint: 'fp', upstreamFingerprints: {}, shardCount: 3,
      shards: buildArtifactShards({ value: 1 }, 2),
    })).rejects.toThrow(/分片数量/);
  });
});
