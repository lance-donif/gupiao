/**
 * M4 发布记录回填
 *
 * 仅对“存在对应成功 trace 且通过完整性检查”的残留快照补建发布记录。
 * 失败 trace 的残留快照**不得**发布。
 */
import { PrismaClient } from '@prisma/client';
import { publishRecommendation } from './publish-recommendation.js';
import { isPublishedTrace } from './publish-recommendation.js';

export interface BackfillOptions {
  /** 指定 trace 回填；省略则扫描整个 clusterKey。 */
  traceId?: string;
  clusterKey?: string;
  auditStatus?: string;
}

export interface BackfillReport {
  scanned: number;
  skippedAlreadyPublished: number;
  skippedFailedTrace: number;
  skippedNoSnapshot: number;
  published: number;
  publishedTraceIds: string[];
  errors: Array<{ traceId: string; message: string }>;
}

const isSuccessTrace = (status: string | null | undefined): boolean => status === 'SUCCESS';

/**
 * 为单个 trace 执行回填（幂等）。返回 null 表示跳过（未发布）。
 */
export async function backfillPublishForTrace(
  prisma: PrismaClient,
  traceId: string,
  auditStatus = 'backfill',
): Promise<{ id: string; publishVersion: number } | null> {
  const trace = await prisma.runTrace.findUnique({ where: { traceId } });
  if (!trace) {
    return null;
  }
  // 失败 trace 的残留快照不得发布。
  if (!isSuccessTrace(trace.status)) {
    return null;
  }
  // 完整性检查：必须存在快照。
  const snapshotCount = await prisma.recommendationSnapshot.count({ where: { traceId } });
  if (snapshotCount === 0) {
    return null;
  }
  // 已发布则跳过。
  if (await isPublishedTrace(prisma, traceId)) {
    return null;
  }
  const result = await publishRecommendation(prisma, {
    traceId,
    clusterKey: trace.clusterKey,
    asOf: trace.asOf,
    auditStatus,
    reason: 'legacy_backfill',
  });
  return { id: result.id, publishVersion: result.publishVersion };
}

export async function backfillPublish(
  prisma: PrismaClient,
  options: BackfillOptions = {},
): Promise<BackfillReport> {
  const report: BackfillReport = {
    scanned: 0,
    skippedAlreadyPublished: 0,
    skippedFailedTrace: 0,
    skippedNoSnapshot: 0,
    published: 0,
    publishedTraceIds: [],
    errors: [],
  };

  const where: Record<string, unknown> = {};
  if (options.clusterKey) {
    where.clusterKey = options.clusterKey;
  }
  if (options.traceId) {
    where.traceId = options.traceId;
  }

  const traces = await prisma.runTrace.findMany({ where });
  report.scanned = traces.length;
  for (const trace of traces) {
    try {
      if (!isSuccessTrace(trace.status)) {
        report.skippedFailedTrace += 1;
        continue;
      }
      if (await isPublishedTrace(prisma, trace.traceId)) {
        report.skippedAlreadyPublished += 1;
        continue;
      }
      const snapshotCount = await prisma.recommendationSnapshot.count({ where: { traceId: trace.traceId } });
      if (snapshotCount === 0) {
        report.skippedNoSnapshot += 1;
        continue;
      }
      const result = await publishRecommendation(prisma, {
        traceId: trace.traceId,
        clusterKey: trace.clusterKey,
        asOf: trace.asOf,
        auditStatus: options.auditStatus ?? 'backfill',
        reason: 'legacy_backfill',
      });
      if (!result.reused) {
        report.published += 1;
        report.publishedTraceIds.push(trace.traceId);
      }
    }
    catch (error) {
      report.errors.push({
        traceId: trace.traceId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}
