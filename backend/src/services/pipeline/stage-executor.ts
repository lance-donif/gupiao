/**
 * 阶段执行器：在既有 `PipelineStage` 契约上实现「构建输入 → 复用或执行 → 提交不可变产物」。
 *
 * 关键保证：
 *  - 复用：已有**有效**产物（输入指纹 + 全部上游指纹一致 + 分片完整）时直接返回 `reused: true`，
 *    绝不执行 `execute`；
 *  - 失败即抛：`execute` 抛错时不吞错、不返回空结果，并按状态机把阶段标记为 `FAILED` 后原样抛出；
 *  - 状态流转全部走 `stage-status.ts` 的 `assertStageTransition`，非法迁移抛错。
 */
import { AiNeedsAttentionError } from '../ai-scheduling-errors.js';
import { assertLeaseHolder, type LeaseGuard } from '../pipeline-run-lease.js';
import {
  buildArtifactShards,
  commitArtifact,
  invalidatedStages,
  isArtifactValid,
  readLatestArtifact,
} from './artifact-store.js';
import { STAGE_IDS, dependenciesOf, resolveStageOrder, type RunContext, type PipelineStage, type StageId } from './stage-registry.js';
import { assertStageTransition, isStageStatus, type StageStatus } from './stage-status.js';

export interface StageExecutionResult {
  readonly stageId: StageId;
  readonly reused: boolean;
  readonly version: number;
  readonly artifactId: string;
  readonly contentHash: string;
}

export interface StageExecutorDeps {
  /**
   * 声明在本次执行之外已经完成的阶段（`--recompute-from` 语义）。
   * 依赖不在本次执行集合内、也未在此声明时，视为由调用方保证已完成。
   */
  readonly completedStages?: ReadonlySet<StageId>;
  /** 可选租约守卫；提供时，提交前必须证明仍是当前租约持有者。 */
  readonly lease?: LeaseGuard | null;
  /** 可注入时钟，便于确定性测试。 */
  readonly now?: () => Date;
}

interface StageTransitionSummary {
  readonly inputFingerprint?: string;
  readonly artifactId?: string;
  readonly errorMessage?: string;
}

/** 读取某阶段全部上游产物指纹（缺失的上游不纳入，与重算语义一致）。 */
async function collectUpstreamFingerprints(prisma: any, traceId: string, dependencies: readonly StageId[]): Promise<Record<string, string>> {
  const fingerprints: Record<string, string> = {};
  for (const dependency of dependencies) {
    const artifact = await readLatestArtifact(prisma, traceId, dependency);
    if (artifact) fingerprints[dependency] = artifact.contentHash;
  }
  return fingerprints;
}

/**
 * 状态流转：读取当前状态 → `assertStageTransition` → 落库。
 * 相同状态重复进入（如中断后重跑的 `RUNNING -> RUNNING`）按幂等处理，不视为迁移。
 */
async function transitionStage(prisma: any, traceId: string, stageId: StageId, to: StageStatus, summary: StageTransitionSummary): Promise<void> {
  const existing = await prisma.pipelineStepTrace.findFirst({ where: { traceId, stepName: stageId }, orderBy: { startedAt: 'desc' } });
  const from: StageStatus = existing && isStageStatus(String(existing.status)) ? String(existing.status) as StageStatus : 'PENDING';
  if (from !== to) assertStageTransition(from, to);
  const terminal = to === 'SUCCESS' || to === 'FAILED';
  const data = {
    stageId,
    status: to,
    inputSummary: summary.inputFingerprint ? { inputFingerprint: summary.inputFingerprint } : {},
    outputSummary: summary.artifactId
      ? { artifactId: summary.artifactId }
      : summary.errorMessage ? { errorMessage: summary.errorMessage } : {},
    errorMessage: to === 'FAILED' ? (summary.errorMessage ?? null) : null,
    endedAt: terminal ? new Date() : null,
  };
  if (existing) await prisma.pipelineStepTrace.updateMany({ where: { traceId, stepName: stageId }, data });
  else await prisma.pipelineStepTrace.create({ data: { traceId, stepName: stageId, startedAt: new Date(), ...data } });
}

/**
 * 执行单个阶段。
 * @returns 复用或新提交的产物引用；`reused` 标识是否命中既有有效产物。
 */
export async function executeStage<I, O>(
  prisma: any,
  stage: PipelineStage<I, O>,
  context: RunContext,
  deps: StageExecutorDeps = {},
): Promise<StageExecutionResult> {
  const now = deps.now ?? (() => new Date());
  const traceId = context.traceId;
  const input = await stage.buildInput(context);
  const fingerprint = stage.fingerprint(input);
  const upstreamFingerprints = await collectUpstreamFingerprints(prisma, traceId, stage.dependencies);
  const latest = await readLatestArtifact(prisma, traceId, stage.id);

  if (latest && await isArtifactValid(prisma, {
    traceId,
    stageId: stage.id,
    version: latest.version,
    inputFingerprint: fingerprint,
    upstreamFingerprints,
  })) {
    return { stageId: stage.id, reused: true, version: latest.version, artifactId: latest.id, contentHash: latest.contentHash };
  }

  await transitionStage(prisma, traceId, stage.id, 'RUNNING', { inputFingerprint: fingerprint });
  try {
    if (deps.lease) {
      await assertLeaseHolder(prisma, { traceId, owner: deps.lease.owner, generation: deps.lease.generation, now: now() });
    }
    const produced = await stage.execute(context, input);
    const shards = buildArtifactShards(produced.payload, produced.shardCount);
    const version = (latest?.version ?? 0) + 1;
    const committed = await commitArtifact(prisma, {
      traceId,
      stageId: stage.id,
      version,
      inputFingerprint: fingerprint,
      upstreamFingerprints,
      shardCount: produced.shardCount,
      shards,
      lease: deps.lease ?? null,
      now: now(),
    });
    await transitionStage(prisma, traceId, stage.id, 'SUCCESS', { artifactId: committed.id });
    return { stageId: stage.id, reused: false, version: committed.version, artifactId: committed.id, contentHash: committed.contentHash };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 失败标记为尽力而为：绝不用它掩盖原始错误，原始错误始终原样抛出。
    try { await transitionStage(prisma, traceId, stage.id, 'FAILED', { errorMessage: message }); } catch { /* 保留原始错误 */ }
    throw error;
  }
}

/**
 * 按 `resolveStageOrder()` 的相对顺序执行入参提供的阶段子集。
 * 依赖不在本次执行集合内、也未在 `completedStages` 中声明时，按契约视为由调用方保证已完成。
 * 前置未满足时抛错（绝不跳过或返回空结果）。
 */
export async function executePipeline(
  prisma: any,
  stages: readonly PipelineStage<unknown, unknown>[],
  context: RunContext,
  deps: StageExecutorDeps = {},
): Promise<ReadonlyMap<StageId, StageExecutionResult>> {
  const byId = new Map<StageId, PipelineStage<unknown, unknown>>();
  for (const stage of stages) {
    if (byId.has(stage.id)) throw new Error(`重复的阶段定义：${stage.id}`);
    byId.set(stage.id, stage);
  }
  const provided = new Set(byId.keys());
  const satisfied = new Set<StageId>(deps.completedStages ?? []);
  const order = resolveStageOrder().filter(id => provided.has(id));
  const results = new Map<StageId, StageExecutionResult>();

  for (const id of order) {
    const stage = byId.get(id) as PipelineStage<unknown, unknown>;
    for (const dependency of stage.dependencies) {
      if (!provided.has(dependency)) continue; // 不在本次执行集合内 → 视为已完成
      if (!satisfied.has(dependency)) {
        throw new AiNeedsAttentionError(`阶段 ${id} 的前置 ${dependency} 未完成，拒绝执行`);
      }
    }
    const result = await executeStage(prisma, stage, context, deps);
    results.set(id, result);
    satisfied.add(id);
  }
  return results;
}

/**
 * `--recompute-from` 语义：给定起始阶段与「已声明完成」的前置集合，
 * 返回需要重算的阶段集合——即该阶段自身加上沿 `dependentsOf()` 可达的全部下游。
 * 起始阶段的直接依赖必须已声明完成，否则抛错（不允许在未知前置之上重算）。
 */
export function recomputeFrom(stageId: StageId, completed: ReadonlySet<StageId> = new Set()): ReadonlySet<StageId> {
  for (const dependency of dependenciesOf(stageId)) {
    if (!completed.has(dependency)) {
      throw new AiNeedsAttentionError(`无法从 ${stageId} 重算：前置阶段 ${dependency} 未完成`);
    }
  }
  return invalidatedStages(stageId);
}

/** 全部阶段 ID（顺序与 `STAGE_IDS` 一致），供调用方校验入参子集。 */
export const EXECUTABLE_STAGE_IDS: readonly StageId[] = STAGE_IDS;
