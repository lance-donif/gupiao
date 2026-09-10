import type { Prisma } from '@prisma/client';
import { evaluateArtifactCompleteness, type ArtifactShardLike } from './pipeline/artifact-completeness.js';

export class TraceManager {
  /**
   * 启动全局 RunTrace 记录
   */
  public static async startRunTrace(
    prisma: any,
    traceId: string,
    clusterKey: string,
    kind: string,
    asOf: Date,
  ): Promise<void> {
    const existing = await prisma.runTrace.findUnique?.({ where: { traceId } });
    if (existing && (existing.clusterKey !== clusterKey || existing.kind !== kind || new Date(existing.asOf).getTime() !== asOf.getTime())) {
      throw new Error('Trace identity is immutable; use a new trace for changed asOf, cluster or kind');
    }
    if (existing?.status === 'SUCCESS') return;
    // The same immutable trace ID is the resume key.  Clearing only terminal
    // run state lets callers replay unfinished stages while their individual
    // PipelineStepTrace rows decide which durable artifacts are reusable.
    await prisma.runTrace.upsert({
      where: { traceId },
      create: {
        traceId,
        clusterKey,
        kind,
        asOf,
        status: 'PENDING',
        metrics: {},
      },
      update: {
        status: 'PENDING',
        errorMessage: null,
        completedAt: null,
      },
    });
  }

  /**
   * 完成全局 RunTrace 记录并保存汇总 metrics
   */
  public static async completeRunTrace(
    prisma: any,
    traceId: string,
    metrics: Record<string, any>,
  ): Promise<void> {
    const commit = async (tx: any): Promise<void> => {
    const trace = await tx.runTrace.findUnique?.({ where: { traceId } });
    if (trace?.kind === 'DAILY_RECOMMENDATION') {
      await tx.recommendationSnapshot.updateMany({ where: { traceId }, data: { isPublished: true } });
    }
    await tx.runTrace.update({
      where: { traceId },
      data: {
        status: 'SUCCESS',
        metrics: metrics as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });
    };
    await prisma.$transaction(commit);
  }

  /**
   * 标记全局 RunTrace 为失败并记录错误信息
   */
  public static async failRunTrace(
    prisma: any,
    traceId: string,
    errorMessage: string,
  ): Promise<void> {
    await prisma.runTrace.update({
      where: { traceId },
      data: {
        status: 'FAILED',
        errorMessage,
        completedAt: new Date(),
      },
    });
  }

  /**
   * 启动单个 Pipeline 步骤追踪
   */
  public static async startStepTrace(
    prisma: any,
    traceId: string,
    stepName: string,
    inputSummary: Record<string, any>,
  ): Promise<void> {
    // A run may be resumed after a process or dependency failure.  Reusing the
    // same row keeps the trace identity stable and clears only the state owned
    // by the step that is about to be retried.
    await prisma.pipelineStepTrace.upsert({
      where: {
        traceId_stepName: { traceId, stepName },
      },
      create: {
        traceId,
        stepName,
        status: 'RUNNING',
        inputSummary: inputSummary as Prisma.InputJsonValue,
        outputSummary: {},
        startedAt: new Date(),
      },
      update: {
        status: 'RUNNING',
        inputSummary: inputSummary as Prisma.InputJsonValue,
        outputSummary: {},
        errorMessage: null,
        startedAt: new Date(),
        endedAt: null,
      },
    });
  }

  /**
   * Returns only durable, successfully committed stage outputs.  Callers must
   * still verify the concrete artifact before treating a stage as reusable.
   */
  public static async getSuccessfulStepOutputs(
    prisma: any,
    traceId: string,
  ): Promise<ReadonlyMap<string, Record<string, unknown>>> {
    if (!prisma.pipelineStepTrace?.findMany) {
      return new Map();
    }
    const rows = await prisma.pipelineStepTrace.findMany({
      where: { traceId, status: 'SUCCESS' },
      select: { stepName: true, outputSummary: true },
    });
    return new Map(rows.map((row: { stepName: string; outputSummary: unknown }) => [
      String(row.stepName),
      row.outputSummary && typeof row.outputSummary === 'object' && !Array.isArray(row.outputSummary)
        ? row.outputSummary as Record<string, unknown>
        : {},
    ]));
  }

  /**
   * 按**实际产物**判定阶段是否完成：必须存在该 `(traceId, stageId)` 的产物清单，
   * 且分片数等于 `shardCount`、索引恰好覆盖 `0..shardCount-1`。
   * 绝不依据 `PipelineStepTrace.status === 'SUCCESS'` 单独判定（状态可能早于/脱离产物）。
   */
  public static async isStageComplete(
    prisma: any,
    input: { traceId: string; stageId: string },
  ): Promise<boolean> {
    if (!prisma.runArtifact?.findFirst) return false;
    const artifact = await prisma.runArtifact.findFirst({
      where: { traceId: input.traceId, stageId: input.stageId },
      orderBy: { version: 'desc' },
    });
    if (!artifact) return false;
    const shards: ArtifactShardLike[] = await prisma.runArtifactShard.findMany({ where: { artifactId: artifact.id } });
    return evaluateArtifactCompleteness(artifact, shards).complete;
  }

  /**
   * 完成单个 Pipeline 步骤追踪
   */
  public static async completeStepTrace(
    prisma: any,
    traceId: string,
    stepName: string,
    outputSummary: Record<string, any>,
  ): Promise<void> {
    await prisma.pipelineStepTrace.update({
      where: {
        traceId_stepName: {
          traceId,
          stepName,
        },
      },
      data: {
        status: 'SUCCESS',
        outputSummary: outputSummary as Prisma.InputJsonValue,
        endedAt: new Date(),
      },
    });
  }

  /**
   * 标记单个 Pipeline 步骤追踪为失败
   */
  public static async failStepTrace(
    prisma: any,
    traceId: string,
    stepName: string,
    errorMessage: string,
  ): Promise<void> {
    await prisma.pipelineStepTrace.update({
      where: {
        traceId_stepName: {
          traceId,
          stepName,
        },
      },
      data: {
        status: 'FAILED',
        errorMessage,
        endedAt: new Date(),
      },
    });
  }
}
