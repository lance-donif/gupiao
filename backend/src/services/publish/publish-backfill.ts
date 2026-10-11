/**
 * M4 发布记录回填
 *
 * 仅对“存在对应成功 trace 且通过完整性检查”的残留快照补建发布记录。
 * 失败 trace 的残留快照**不得**发布。
 */
import { PrismaClient } from '@prisma/client';
import { publishRecommendation } from './publish-recommendation.js';
import { isPublishedTrace } from './publish-recommendation.js';

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
