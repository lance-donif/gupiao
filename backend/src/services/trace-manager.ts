import type { Prisma } from '@prisma/client';

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
    await prisma.runTrace.create({
      data: {
        traceId,
        clusterKey,
        kind,
        asOf,
        status: 'PENDING',
        metrics: {},
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
    await prisma.runTrace.update({
      where: { traceId },
      data: {
        status: 'SUCCESS',
        metrics: metrics as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });
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
    await prisma.pipelineStepTrace.create({
      data: {
        traceId,
        stepName,
        status: 'RUNNING',
        inputSummary: inputSummary as Prisma.InputJsonValue,
        outputSummary: {},
        startedAt: new Date(),
      },
    });
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
