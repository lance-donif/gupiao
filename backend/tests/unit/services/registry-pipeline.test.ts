import { describe, expect, it } from 'vitest';
import { MemoryPrisma } from '../fixtures/pipeline-fixtures.js';
import {
  DEFAULT_STAGE_VERSIONS,
  carryOverTraceScopedState,
  copyReusableCheckpoints,
  copyUpstreamArtifacts,
  createDailyPipelineStages,
  resolveRecomputePlan,
  resolveStageOrderForStop,
  type StageHandler,
} from '../../../src/services/pipeline/registry-pipeline.js';
import { buildArtifactShards, commitArtifact } from '../../../src/services/pipeline/artifact-store.js';
import { executePipeline } from '../../../src/services/pipeline/stage-executor.js';
import { TraceManager } from '../../../src/services/trace-manager.js';
import {
  STAGE_DEPENDENCIES,
  STAGE_IDS,
  resolveStageOrder,
  type StageId,
} from '../../../src/services/pipeline/stage-registry.js';
import {
  buildRegistryRunContext,
  resolveRunExecutor,
  resolveRunScoringRecipe,
  summarizeStrategyResult,
} from '../../../scripts/run-daily-recommendation.js';

const asOf = new Date('2026-09-07T08:00:00.000Z');

const createHandlers = (onCall?: (stageId: StageId) => void): Record<StageId, StageHandler> =>
  Object.fromEntries(STAGE_IDS.map(id => [
    id,
    async () => {
      onCall?.(id);
      return { stage: id };
    },
  ])) as unknown as Record<StageId, StageHandler>;

const context = () => buildRegistryRunContext({
  traceId: 'trace-registry',
  clusterKey: 'main',
  asOf,
  mode: 'daily',
  stopAfter: 'none',
  scoringRecipe: 'event-v2',
});

const seedArtifact = async (
  prisma: any,
  traceId: string,
  stageId: StageId,
  payload: unknown,
  version = 1,
): Promise<any> => commitArtifact(prisma, {
  traceId,
  stageId,
  version,
  inputFingerprint: 'fp',
  upstreamFingerprints: {},
  shardCount: 2,
  shards: buildArtifactShards(payload, 2),
});

describe('createDailyPipelineStages', () => {
  it('覆盖全部 14 个阶段，依赖与版本来自阶段注册表', () => {
    const stages = createDailyPipelineStages({ handlers: createHandlers() });

    expect(stages).toHaveLength(14);
    expect(stages.map(stage => stage.id)).toEqual([...STAGE_IDS]);
    for (const stage of stages) {
      expect(stage.dependencies).toEqual(STAGE_DEPENDENCIES[stage.id]);
      expect(stage.version).toBe(DEFAULT_STAGE_VERSIONS[stage.id]);
    }
  });

  it('缺少任一阶段实现时整体抛错，不执行半条链路', () => {
    const handlers = createHandlers();
    delete (handlers as Record<string, unknown>).recommendation_publish;

    expect(() => createDailyPipelineStages({ handlers })).toThrow(/缺少阶段实现：recommendation_publish/);
  });

  it('execute 返回 ArtifactRef 形状载荷，artifactId/contentHash 由执行器填充', async () => {
    const stages = createDailyPipelineStages({ handlers: createHandlers() });
    const stage = stages.find(candidate => candidate.id === 'news_fetch');
    expect(stage).toBeDefined();

    const runContext = context();
    const input = await (stage as NonNullable<typeof stage>).buildInput(runContext);
    const fingerprint = (stage as NonNullable<typeof stage>).fingerprint(input);
    expect(fingerprint).toBe((stage as NonNullable<typeof stage>).fingerprint(input));

    const ref = await (stage as NonNullable<typeof stage>).execute(runContext, input);
    expect(ref).toMatchObject({
      artifactId: '',
      traceId: 'trace-registry',
      stageId: 'news_fetch',
      version: DEFAULT_STAGE_VERSIONS.news_fetch,
      contentHash: '',
      shardCount: 1,
    });
    expect(ref.payload).toEqual({ stage: 'news_fetch' });
  });

  it('阶段版本进入输入指纹：版本变化即失效旧产物', async () => {
    const runContext = context();
    const base = createDailyPipelineStages({ handlers: createHandlers() })
      .find(stage => stage.id === 'causal_extract') as NonNullable<ReturnType<typeof createDailyPipelineStages>[number]>;
    const bumped = createDailyPipelineStages({
      handlers: createHandlers(),
      versions: { causal_extract: 'causal-extract-v2' },
    }).find(stage => stage.id === 'causal_extract') as typeof base;

    expect(bumped.version).toBe('causal-extract-v2');
    expect(bumped.fingerprint(await bumped.buildInput(runContext)))
      .not.toBe(base.fingerprint(await base.buildInput(runContext)));
  });

  it('handler 抛错时原样抛出，不吞错、不返回空结果', async () => {
    const stages = createDailyPipelineStages({
      handlers: {
        ...createHandlers(),
        causal_extract: async () => { throw new Error('llm 超时'); },
      },
    });
    const stage = stages.find(candidate => candidate.id === 'causal_extract') as NonNullable<typeof stages[number]>;
    const runContext = context();

    await expect(stage.execute(runContext, await stage.buildInput(runContext))).rejects.toThrow('llm 超时');
  });
});

describe('executePipeline 驱动 registry 全链路', () => {
  it('按拓扑顺序执行 14 个阶段并提交 14 份产物与 SUCCESS 步骤轨迹', async () => {
    const prisma = new MemoryPrisma();
    await TraceManager.startRunTrace(prisma, 'trace-registry', 'main', 'DAILY_RECOMMENDATION', asOf);
    const calls: StageId[] = [];

    const results = await executePipeline(
      prisma,
      createDailyPipelineStages({ handlers: createHandlers(stageId => calls.push(stageId)) }),
      context(),
    );

    expect(calls).toEqual([...resolveStageOrder()]);
    expect(results.size).toBe(14);
    expect(await prisma.runArtifact.count({ where: { traceId: 'trace-registry' } })).toBe(14);
    expect(await prisma.pipelineStepTrace.count({ where: { traceId: 'trace-registry', status: 'SUCCESS' } })).toBe(14);
  });

  it('同一 trace 重复执行命中产物复用，不再调用 handler', async () => {
    const prisma = new MemoryPrisma();
    await TraceManager.startRunTrace(prisma, 'trace-registry', 'main', 'DAILY_RECOMMENDATION', asOf);
    const calls: StageId[] = [];
    const stages = createDailyPipelineStages({ handlers: createHandlers(stageId => calls.push(stageId)) });

    await executePipeline(prisma, stages, context());
    const callsAfterFirstRun = [...calls];
    const second = await executePipeline(prisma, stages, context());

    expect(calls).toEqual(callsAfterFirstRun);
    expect([...second.values()].every(result => result.reused)).toBe(true);
    expect(await prisma.runArtifact.count({ where: { traceId: 'trace-registry' } })).toBe(14);
  });
});

describe('resolveStageOrderForStop', () => {
  it("'none' 返回全链路且顺序与 resolveStageOrder() 一致", () => {
    expect([...resolveStageOrderForStop('none')]).toEqual([...resolveStageOrder()]);
  });

  it("'dedup' 是 news_prepare 的 legacy 别名，停在去重之后", () => {
    expect([...resolveStageOrderForStop('dedup')]).toEqual(['news_fetch', 'news_prepare']);
  });

  it('StageId 取确定性前缀：停在 evidence_score 之前不会包含选股/发布', () => {
    const prefix = resolveStageOrderForStop('evidence_score');

    expect(prefix).toContain('news_fetch');
    expect(prefix).toContain('evidence_score');
    expect(prefix).not.toContain('recommendation_select');
    expect(prefix).not.toContain('recommendation_publish');
    expect(prefix).not.toContain('reconciliation');
    expect(prefix).not.toContain('strategy_evaluation');
  });

  it('unknown 前缀抛错', () => {
    expect(() => resolveStageOrderForStop('unknown_stage' as StageId)).toThrow(/未知的 stop-after/);
  });
});

describe('resolveRecomputePlan', () => {
  it('causal_extract：受影响集合为自身加全部可达下游，独立阶段留在上游', () => {
    const plan = resolveRecomputePlan('causal_extract');

    expect(plan.affected[0]).toBe('causal_extract');
    expect(plan.affected).toContain('graph_snapshot');
    expect(plan.affected).toContain('expectation_gap');
    expect(plan.affected).toContain('theme_forecast');
    expect(plan.affected).toContain('evidence_score');
    expect(plan.affected).toContain('recommendation_publish');
    expect(plan.affected).not.toContain('news_prepare');
    expect(plan.affected).not.toContain('market_features');
    expect(plan.affected).not.toContain('penalty_refresh');
    expect(plan.affected).not.toContain('exposure_refresh');

    expect(plan.upstream).toEqual(['news_fetch', 'news_prepare', 'exposure_refresh', 'market_features', 'penalty_refresh']);
    for (const dependency of STAGE_DEPENDENCIES[plan.startStage]) {
      expect(plan.upstream).toContain(dependency);
    }
  });

  it('news_fetch：根阶段，受影响集合覆盖全部下游且上游只剩独立阶段', () => {
    const plan = resolveRecomputePlan('news_fetch');

    expect(plan.affected).toContain('news_fetch');
    expect(plan.affected).toContain('causal_extract');
    expect(plan.affected).toContain('recommendation_publish');
    expect(plan.upstream).toEqual(['exposure_refresh', 'market_features', 'penalty_refresh']);
  });

  it('affected 与 upstream 恰好划分全部阶段且互不重叠', () => {
    for (const stageId of STAGE_IDS) {
      const plan = resolveRecomputePlan(stageId);
      expect([...plan.affected, ...plan.upstream].sort()).toEqual([...STAGE_IDS].sort());
      expect(plan.affected.filter(id => plan.upstream.includes(id))).toEqual([]);
      expect(plan.upstream.length + plan.affected.length).toBe(STAGE_IDS.length);
    }
  });
});

describe('上游复用：产物与检查点', () => {
  it('复制上游产物清单与全部分片，并记录 origin 追溯信息', async () => {
    const prisma = new MemoryPrisma();
    const source = await seedArtifact(prisma, 'source-trace', 'news_fetch', { articles: 3 });

    const result = await copyUpstreamArtifacts(prisma, {
      sourceTraceId: 'source-trace',
      targetTraceId: 'target-trace',
      stages: ['news_fetch'],
    });

    expect(result.copied).toEqual(['news_fetch']);
    const copy = await prisma.runArtifact.findFirst({ where: { traceId: 'target-trace', stageId: 'news_fetch' } });
    expect(copy.contentHash).toBe(source.contentHash);
    expect(copy.inputFingerprint).toBe(source.inputFingerprint);
    expect(copy.originTraceId).toBe('source-trace');
    expect(copy.originArtifactId).toBe(source.id);
    expect(await prisma.runArtifactShard.count({ where: { artifactId: copy.id } })).toBe(2);
  });

  it('目标 trace 已有产物时跳过复制（幂等重跑）', async () => {
    const prisma = new MemoryPrisma();
    await seedArtifact(prisma, 'source-trace', 'news_fetch', { articles: 3 });
    await seedArtifact(prisma, 'target-trace', 'news_fetch', { articles: 3 });

    const result = await copyUpstreamArtifacts(prisma, {
      sourceTraceId: 'source-trace',
      targetTraceId: 'target-trace',
      stages: ['news_fetch'],
    });

    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual(['news_fetch']);
    expect(await prisma.runArtifact.count({ where: { traceId: 'target-trace', stageId: 'news_fetch' } })).toBe(1);
  });

  it('目标 trace 已有同阶段但内容不同的产物时显式抛错', async () => {
    const prisma = new MemoryPrisma();
    await seedArtifact(prisma, 'source-trace', 'news_fetch', { articles: 3 });
    await seedArtifact(prisma, 'target-trace', 'news_fetch', { articles: 99 });

    await expect(copyUpstreamArtifacts(prisma, {
      sourceTraceId: 'source-trace',
      targetTraceId: 'target-trace',
      stages: ['news_fetch'],
    })).rejects.toThrow(/不同内容产物/);
  });

  it('源 trace 缺少上游产物时显式抛错，绝不静默重算上游', async () => {
    const prisma = new MemoryPrisma();

    await expect(copyUpstreamArtifacts(prisma, {
      sourceTraceId: 'source-trace',
      targetTraceId: 'target-trace',
      stages: ['graph_snapshot'],
    })).rejects.toThrow(/无法复用上游产物/);
    expect(await prisma.runArtifact.count({ where: { traceId: 'target-trace' } })).toBe(0);
  });

  it('复制上游检查点、跳过租约槽位，并报告源缺失项', async () => {
    const prisma = new MemoryPrisma();
    await prisma.pipelineCheckpoint.create({
      data: { traceId: 'source-trace', stage: 'news_input', input: 'fp-1', result: { articles: [] } },
    });
    await prisma.pipelineCheckpoint.create({
      data: { traceId: 'source-trace', stage: '__pipeline_run_lease__', input: 'lease', result: { owner: 'a', generation: 1 } },
    });

    const result = await copyReusableCheckpoints(prisma, {
      sourceTraceId: 'source-trace',
      targetTraceId: 'target-trace',
      stages: ['news_input', '__pipeline_run_lease__', 'registry_prepare'],
    });

    expect(result.copied).toEqual(['news_input']);
    expect(result.missing).toEqual(['registry_prepare']);
    expect(await prisma.pipelineCheckpoint.count({ where: { traceId: 'target-trace' } })).toBe(1);
    const copied = await prisma.pipelineCheckpoint.findFirst({ where: { traceId: 'target-trace', stage: 'news_input' } });
    expect(copied.input).toBe('fp-1');
    expect(await prisma.pipelineCheckpoint.count({ where: { traceId: 'target-trace', stage: '__pipeline_run_lease__' } })).toBe(0);
  });

  it('按 traceId 归属状态：目标已有行时跳过，缺失时按阶段复制', async () => {
    const prisma = new MemoryPrisma();
    await prisma.causalSignalCandidate.create({ data: { traceId: 'target-trace', status: 'candidate' } });

    const skipped = await carryOverTraceScopedState(prisma, {
      sourceTraceId: 'source-trace',
      targetTraceId: 'target-trace',
      stages: ['causal_extract'],
    });
    expect(skipped.skipped).toEqual(['causal_extract']);
    expect(skipped.copied).toEqual([]);
    expect(skipped.existingRows).toEqual({ CausalSignalCandidate: 1 });

    const copied = await carryOverTraceScopedState(prisma, {
      sourceTraceId: 'source-trace',
      targetTraceId: 'target-trace',
      stages: ['graph_snapshot'],
    });
    expect(copied.copied).toEqual(['GraphSnapshot']);
    expect(copied.skipped).toEqual([]);
  });

  it('不支持的阶段进入 skipped，不做任何写入', async () => {
    const prisma = new MemoryPrisma();

    const result = await carryOverTraceScopedState(prisma, {
      sourceTraceId: 'source-trace',
      targetTraceId: 'target-trace',
      stages: ['theme_forecast'],
    });

    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual(['theme_forecast']);
  });
});

describe('执行器与配方选择', () => {
  it('未配置时默认 registry；env=legacy 时选 legacy', () => {
    expect(resolveRunExecutor({}, {})).toBe('registry');
    expect(resolveRunExecutor({}, { PIPELINE_STAGE_EXECUTOR: 'legacy' })).toBe('legacy');
    expect(resolveRunExecutor({}, { PIPELINE_STAGE_EXECUTOR: 'registry' })).toBe('registry');
  });

  it('CLI --stage-executor 覆盖环境变量，非法值直接抛错', () => {
    expect(resolveRunExecutor({ 'stage-executor': 'legacy' }, { PIPELINE_STAGE_EXECUTOR: 'registry' })).toBe('legacy');
    expect(resolveRunExecutor({ 'stage-executor': 'registry' }, { PIPELINE_STAGE_EXECUTOR: 'legacy' })).toBe('registry');
    expect(() => resolveRunExecutor({ 'stage-executor': 'nope' }, {})).toThrow(/Invalid PIPELINE_STAGE_EXECUTOR/);
  });

  it('评分配方默认 event-v2，可被 CLI 覆盖，非法值抛错', () => {
    expect(resolveRunScoringRecipe({}, {})).toBe('event-v2');
    expect(resolveRunScoringRecipe({ 'scoring-recipe': 'baseline-v1' }, {})).toBe('baseline-v1');
    expect(() => resolveRunScoringRecipe({ 'scoring-recipe': 'nope' }, {})).toThrow(/Invalid SCORING_RECIPE/);
  });

  it('RunContext 固化运行键与确定性输入', () => {
    const runContext = buildRegistryRunContext({
      traceId: 'trace-1',
      clusterKey: 'main',
      asOf,
      mode: 'daily',
      stopAfter: 'none',
      scoringRecipe: 'event-v2',
      recomputeFrom: 'causal_extract',
      sourceTraceId: 'source-1',
      inputs: { limit: '30' },
    });

    expect(runContext.traceId).toBe('trace-1');
    expect(runContext.asOf).toBe('2026-09-07T08:00:00.000Z');
    expect(runContext.recipeVersion).toBeTruthy();
    expect(runContext.businessConfigHash).toBeTruthy();
    expect(runContext.inputs).toMatchObject({
      scoringRecipe: 'event-v2',
      stopAfter: 'none',
      recomputeFrom: 'causal_extract',
      sourceTraceId: 'source-1',
      limit: '30',
    });
  });

  it('策略摘要只保留计数，便于写入 RunTrace.metrics', () => {
    expect(summarizeStrategyResult({
      strategyCount: 3,
      enabledStrategyCount: 2,
      successCount: 2,
      failureCount: 0,
      recommendationCount: 7,
      runs: [{ big: 'payload' }],
    })).toEqual({
      strategyCount: 3,
      enabledStrategyCount: 2,
      successCount: 2,
      failureCount: 0,
      recommendationCount: 7,
    });
  });
});
