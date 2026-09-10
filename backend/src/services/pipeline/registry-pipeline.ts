/**
 * registry 执行器的日线推荐阶段工厂与产物复用工具。
 *
 * 设计要点：
 *  - 14 个阶段全部实现 `PipelineStage` 契约（`id/version/dependencies/buildInput/fingerprint/execute`），
 *    由 `executePipeline` 驱动，阶段顺序与依赖来自 `stage-registry.ts`；
 *  - 业务实现通过 handler 依赖注入：脚本侧复用既有 helper/service，不在此重写业务逻辑；
 *  - `execute()` 只返回 `ArtifactRef` 形状的载荷（`artifactId/contentHash` 留空），
 *    真正的产物清单/分片与 `contentHash` 由 `stage-executor.ts` 计算并写入 `RunArtifact`；
 *  - `--stop-after`（含 legacy 别名 `dedup`）与 `--recompute-from` 的集合语义在此集中定义：
 *    上游阶段只复用**源 trace 的产物清单/分片与 PipelineCheckpoint**，
 *    任何无法复用的上游状态都必须在脚本侧显式失败，绝不静默全量重算。
 */
import { AiNeedsAttentionError } from '../ai-scheduling-errors.js';
import { inputFingerprint } from '../pipeline-checkpoint.js';
import { PIPELINE_LEASE_STAGE } from '../pipeline-run-lease.js';
import { assertArtifactComplete, computeArtifactContentHash, readLatestArtifact } from './artifact-store.js';
import { recomputeFrom } from './stage-executor.js';
import {
  STAGE_DEPENDENCIES,
  STAGE_IDS,
  resolveStageOrder,
  type ArtifactRef,
  type PipelineStage,
  type RunContext,
  type StageId,
} from './stage-registry.js';

/** 阶段输入 schema 版本：进入输入指纹，结构变化必须递增。 */
export const REGISTRY_INPUT_SCHEMA = 'registry-stage-input-v1';

/** 每个阶段的逻辑版本（进入输入指纹；语义变化时递增即可整体失效旧产物）。 */
export const DEFAULT_STAGE_VERSIONS: Readonly<Record<StageId, string>> = {
  news_fetch: 'news-fetch-v1',
  news_prepare: 'news-prepare-v1',
  exposure_refresh: 'exposure-refresh-v1',
  causal_extract: 'causal-extract-v1',
  graph_snapshot: 'graph-snapshot-v1',
  market_features: 'market-features-v1',
  expectation_gap: 'expectation-gap-v1',
  theme_forecast: 'theme-forecast-v1',
  penalty_refresh: 'penalty-refresh-v1',
  evidence_score: 'evidence-score-v1',
  recommendation_select: 'recommendation-select-v1',
  recommendation_publish: 'recommendation-publish-v1',
  reconciliation: 'reconciliation-v1',
  strategy_evaluation: 'strategy-evaluation-v1',
};

/** handler 入参：阶段身份 + 运行上下文 + 该阶段的确定性输入。 */
export interface StageHandlerInput {
  readonly stageId: StageId;
  readonly context: RunContext;
  readonly input: Readonly<Record<string, unknown>>;
}

/** 注入的业务实现；返回的任意 JSON 载荷即阶段产物内容。 */
export type StageHandler = (input: StageHandlerInput) => Promise<unknown>;

/** 构造阶段列表的依赖注入。 */
export interface CreateDailyPipelineStagesDeps {
  readonly handlers: Readonly<Partial<Record<StageId, StageHandler>>>;
  readonly versions?: Readonly<Partial<Record<StageId, string>>>;
  readonly shardCounts?: Readonly<Partial<Record<StageId, number>>>;
  readonly buildInput?: Readonly<Partial<Record<StageId, (context: RunContext) => Promise<Record<string, unknown>> | Record<string, unknown>>>>;
}

/**
 * 默认阶段输入：运行身份 + 供应商/参数指纹 + 依赖列表。
 * 全部字段都是确定性快照，因此同一 trace 的重复执行会得到相同指纹并命中产物复用。
 */
export function buildStageInput(stageId: StageId, context: RunContext, stageVersion: string): Record<string, unknown> {
  return {
    schema: REGISTRY_INPUT_SCHEMA,
    stageId,
    stageVersion,
    traceId: context.traceId,
    clusterKey: context.clusterKey,
    mode: context.mode,
    asOf: context.asOf,
    recipeVersion: context.recipeVersion,
    businessConfigHash: context.businessConfigHash,
    inputs: { ...context.inputs },
    dependencies: [...STAGE_DEPENDENCIES[stageId]],
  };
}

/** 创建单个阶段；缺少注入 handler 时直接抛错，绝不以空实现执行。 */
export function createDailyPipelineStage(id: StageId, deps: CreateDailyPipelineStagesDeps): PipelineStage<unknown, unknown> {
  const handler = deps.handlers[id];
  if (typeof handler !== 'function') {
    throw new AiNeedsAttentionError(`阶段 ${id} 缺少注入的 handler，拒绝以空实现执行`);
  }
  const version = deps.versions?.[id] ?? DEFAULT_STAGE_VERSIONS[id];
  const shardCount = deps.shardCounts?.[id] ?? 1;
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error(`阶段 ${id} 的 shardCount 非法：${shardCount}`);
  }
  const customBuildInput = deps.buildInput?.[id];

  return {
    id,
    version,
    dependencies: STAGE_DEPENDENCIES[id],
    async buildInput(context: RunContext): Promise<unknown> {
      if (customBuildInput) return await customBuildInput(context);
      return buildStageInput(id, context, version);
    },
    fingerprint(input: unknown): string {
      return inputFingerprint(input);
    },
    async execute(context: RunContext, input: unknown): Promise<ArtifactRef<unknown>> {
      const payload = await handler({
        stageId: id,
        context,
        input: (input ?? {}) as Readonly<Record<string, unknown>>,
      });
      return {
        artifactId: '',
        traceId: context.traceId,
        stageId: id,
        version,
        contentHash: '',
        shardCount,
        payload,
      };
    },
  };
}

/**
 * 创建 14 个日线阶段（顺序与 `STAGE_IDS` 一致）。
 * 先整体校验 handler 覆盖，避免执行到一半才发现缺口。
 */
export function createDailyPipelineStages(deps: CreateDailyPipelineStagesDeps): readonly PipelineStage<unknown, unknown>[] {
  const missing = STAGE_IDS.filter(id => typeof deps.handlers[id] !== 'function');
  if (missing.length > 0) {
    throw new AiNeedsAttentionError(`registry 执行器缺少阶段实现：${missing.join(', ')}`);
  }
  return STAGE_IDS.map(id => createDailyPipelineStage(id, deps));
}

/** `--stop-after` 的确定性前缀：`none` = 全链路；`dedup` = 到 news_prepare 为止。 */
export function resolveStageOrderForStop(stopAfter: 'none' | 'dedup' | StageId): readonly StageId[] {
  const order = resolveStageOrder();
  if (stopAfter === 'none') return order;
  const target: StageId = stopAfter === 'dedup' ? 'news_prepare' : stopAfter;
  const index = order.indexOf(target);
  if (index < 0) throw new Error(`未知的 stop-after 阶段：${stopAfter}`);
  return order.slice(0, index + 1);
}

/** `--recompute-from` 的受影响集合与上游集合（上游 = 需要复用产物的阶段）。 */
export interface RecomputePlan {
  readonly startStage: StageId;
  readonly affected: readonly StageId[];
  readonly upstream: readonly StageId[];
}

/**
 * 计算重算计划：受影响集合 = 起始阶段 + 其全部可达下游（`recomputeFrom` 语义），
 * 上游集合 = 其余阶段，全部要求从源 trace 复用产物。
 */
export function resolveRecomputePlan(startStage: StageId): RecomputePlan {
  const order = resolveStageOrder();
  const upstreamCandidates = new Set<StageId>(order.filter(id => id !== startStage));
  const affectedSet = recomputeFrom(startStage, upstreamCandidates);
  const affected = order.filter(id => affectedSet.has(id));
  const upstream = order.filter(id => !affectedSet.has(id));
  return { startStage, affected, upstream };
}

/** 上游产物复制结果。 */
export interface CopyUpstreamArtifactsResult {
  readonly copied: readonly StageId[];
  readonly skipped: readonly StageId[];
}

/**
 * 把源 trace 的**上游阶段产物**复制到目标 trace（清单 + 全部分片），
 * 并写入 `originTraceId/originArtifactId` 以便追溯来源。
 *
 * 复制前必须通过完整性校验（分片数 == shardCount 且索引恰好覆盖 0..shardCount-1）；
 * 源 trace 缺少某个上游阶段产物时抛错，绝不静默降级为「重新计算上游」。
 */
export async function copyUpstreamArtifacts(
  prisma: any,
  input: {
    readonly sourceTraceId: string;
    readonly targetTraceId: string;
    readonly stages: readonly StageId[];
  },
): Promise<CopyUpstreamArtifactsResult> {
  const copied: StageId[] = [];
  const skipped: StageId[] = [];
  for (const stageId of input.stages) {
    const source = await readLatestArtifact(prisma, input.sourceTraceId, stageId);
    if (!source) {
      throw new AiNeedsAttentionError(
        `无法复用上游产物：源 trace ${input.sourceTraceId} 缺少阶段 ${stageId} 的产物；请改用更早的 --recompute-from 起点`,
      );
    }
    const existing = await readLatestArtifact(prisma, input.targetTraceId, stageId);
    if (existing) {
      // 目标已有同阶段产物：只有内容一致才算幂等复用，否则必须显式失败（不得静默沿用不确定的产物）。
      if (existing.contentHash !== source.contentHash) {
        throw new AiNeedsAttentionError(
          `目标 trace ${input.targetTraceId} 已存在阶段 ${stageId} 的不同内容产物（target=${existing.contentHash} source=${source.contentHash}）；请使用新的 --trace-id`,
        );
      }
      skipped.push(stageId);
      continue;
    }
    await assertArtifactComplete(prisma, source.id);
    const shardRows = await prisma.runArtifactShard.findMany({
      where: { artifactId: source.id },
      orderBy: { shardIndex: 'asc' },
    });
    const shards = shardRows.map((row: any) => ({
      shardIndex: Number(row.shardIndex),
      contentHash: String(row.contentHash),
      byteSize: row.byteSize === null || row.byteSize === undefined ? null : Number(row.byteSize),
    }));
    const contentHash = computeArtifactContentHash(shards);
    if (contentHash !== source.contentHash) {
      throw new AiNeedsAttentionError(
        `源产物内容哈希不一致：trace=${input.sourceTraceId} stage=${stageId} version=${source.version}`,
      );
    }
    await prisma.$transaction(async (tx: any) => {
      const created = await tx.runArtifact.create({
        data: {
          traceId: input.targetTraceId,
          stageId,
          version: source.version,
          inputFingerprint: source.inputFingerprint,
          upstreamFingerprints: { ...source.upstreamFingerprints },
          shardCount: source.shardCount,
          contentHash,
          originTraceId: input.sourceTraceId,
          originArtifactId: source.id,
        },
      });
      await tx.runArtifactShard.createMany({
        data: shards.map((shard: { shardIndex: number; contentHash: string; byteSize: number | null }) => ({
          artifactId: created.id,
          shardIndex: shard.shardIndex,
          contentHash: shard.contentHash,
          byteSize: shard.byteSize,
        })),
      });
      return created;
    });
    copied.push(stageId);
  }
  return { copied, skipped };
}

/** 上游 PipelineCheckpoint 复制结果。 */
export interface CopyCheckpointsResult {
  readonly copied: readonly string[];
  readonly skipped: readonly string[];
  readonly missing: readonly string[];
}

/**
 * 把源 trace 的 `PipelineCheckpoint` 行原样复制到目标 trace。
 * `input` 指纹一并复制，因此目标 trace 读取时仍会做指纹校验：
 * 只有输入完全一致（同 asOf / 同 cluster / 同版本）才会命中，否则 `checkpointWork` 会抛错。
 * 租约保留槽位 `__pipeline_run_lease__` 永不复制。
 */
export async function copyReusableCheckpoints(
  prisma: any,
  input: {
    readonly sourceTraceId: string;
    readonly targetTraceId: string;
    readonly stages: readonly string[];
  },
): Promise<CopyCheckpointsResult> {
  const copied: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];
  for (const stage of input.stages) {
    if (stage === PIPELINE_LEASE_STAGE) continue;
    const existing = await prisma.pipelineCheckpoint.findFirst({
      where: { traceId: input.targetTraceId, stage },
    });
    if (existing) {
      skipped.push(stage);
      continue;
    }
    const row = await prisma.pipelineCheckpoint.findFirst({
      where: { traceId: input.sourceTraceId, stage },
    });
    if (!row) {
      missing.push(stage);
      continue;
    }
    await prisma.pipelineCheckpoint.create({
      data: {
        traceId: input.targetTraceId,
        stage,
        input: row.input,
        result: row.result,
      },
    });
    copied.push(stage);
  }
  return { copied, skipped, missing };
}

/**
 * 阶段 → 供重算复用的 PipelineCheckpoint 名称。
 * 只有这些检查点承载「复算下游所需的确定性输入」，其余阶段没有可移植状态。
 */
export const STAGE_CHECKPOINT_NAMES: Readonly<Partial<Record<StageId, readonly string[]>>> = {
  news_fetch: ['news_input'],
  news_prepare: ['registry_prepare'],
  exposure_refresh: ['aktools_exposure', 'tickflow_exposure'],
};

/** 支持跨 trace 复用的「按 traceId 归属」数据库状态。 */
export const TRACE_STATE_CARRY_OVER_STAGES: readonly StageId[] = ['causal_extract', 'graph_snapshot'];

/** 按 traceId 归属的状态行复制结果。 */
export interface CarryOverTraceStateResult {
  readonly copied: readonly string[];
  readonly skipped: readonly StageId[];
  /** 目标 trace 已存在的行数（按表名），用于确认幂等重跑时复用了既有状态。 */
  readonly existingRows: Readonly<Record<string, number>>;
}

/**
 * 复制「按 traceId 归属」的上游状态行：因果信号候选与图谱快照。
 * 二者是评分阶段唯一无法从产物清单复原的输入；SQL 与既有 from-forecast 复用路径逐字一致。
 * 其余阶段（对账/主题/证据/推荐）的 trace 归属状态不在本函数覆盖范围内，
 * 缺失时由对应 handler 显式抛错要求更早起点。
 */
export async function carryOverTraceScopedState(
  prisma: any,
  input: {
    readonly sourceTraceId: string;
    readonly targetTraceId: string;
    readonly stages: readonly StageId[];
  },
): Promise<CarryOverTraceStateResult> {
  const copied: string[] = [];
  const skipped: StageId[] = [];
  const existingRows: Record<string, number> = {};
  for (const stage of input.stages) {
    if (stage === 'causal_extract') {
      const targetRows = await prisma.causalSignalCandidate.count({ where: { traceId: input.targetTraceId } });
      existingRows.CausalSignalCandidate = targetRows;
      if (targetRows > 0) {
        skipped.push(stage);
        continue;
      }
      await prisma.$executeRawUnsafe(
        [
          'INSERT INTO "CausalSignalCandidate" (',
          '  id, "traceId", "asOf", "clusterKey", "newsId", event, "businessVariable",',
          '  "assetOrThemeKeyword", direction, confidence, "evidenceText",',
          '  "evidenceOffsetStart", "evidenceOffsetEnd", "extractorType", "modelVersion",',
          '  "promptVersion", "inputFingerprint", status, "failureReason", "createdAt", "updatedAt"',
          ')',
          'SELECT',
          '  gen_random_uuid(), $1, "asOf", "clusterKey", "newsId", event, "businessVariable",',
          '  "assetOrThemeKeyword", direction, confidence, "evidenceText",',
          '  "evidenceOffsetStart", "evidenceOffsetEnd", "extractorType", "modelVersion",',
          '  "promptVersion", "inputFingerprint", status, "failureReason", NOW(), NOW()',
          'FROM "CausalSignalCandidate"',
          "WHERE \"traceId\" = $2 AND status = 'candidate'",
          'ON CONFLICT DO NOTHING',
        ].join(' '),
        input.targetTraceId,
        input.sourceTraceId,
      );
      copied.push('CausalSignalCandidate');
      continue;
    }
    if (stage === 'graph_snapshot') {
      const targetRows = await prisma.graphSnapshot.count({ where: { traceId: input.targetTraceId } });
      existingRows.GraphSnapshot = targetRows;
      if (targetRows > 0) {
        skipped.push(stage);
        continue;
      }
      await prisma.$executeRawUnsafe(
        [
          'INSERT INTO "GraphSnapshot" ("id","traceId","asOf","clusterKey","nodesJson","edgesJson","createdAt")',
          'SELECT gen_random_uuid(), $1, "asOf", "clusterKey", "nodesJson", "edgesJson", NOW()',
          'FROM "GraphSnapshot" WHERE "traceId" = $2',
          'ON CONFLICT ("traceId") DO NOTHING',
        ].join(' '),
        input.targetTraceId,
        input.sourceTraceId,
      );
      copied.push('GraphSnapshot');
      continue;
    }
    skipped.push(stage);
  }
  return { copied, skipped, existingRows };
}
