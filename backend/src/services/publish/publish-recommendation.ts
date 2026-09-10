/**
 * M4 原子发布服务
 *
 * 设计要点：
 * - `RecommendationPublish` 是发布的**唯一真源**（原子发布记录）。
 * - `RecommendationSnapshot.isPublished` 保留为**兼容读路径**：发布时同步置位，
 *   不删除旧列，旧读取口径（Dashboard / 日报）仍可工作。
 * - 同日多版本：每次“显式新版本”发布都会递增 `publishVersion`，
 *   并把上一个版本的 `supersededBy` 指向新记录。
 * - 幂等：同 traceId + 同 `auditStatus` + 同 `reason` 的发布不会重复建版本，
 *   直接返回既有的最新版本（`reused: true`）。
 */
import { PrismaClient, Prisma } from '@prisma/client';

export type PublishAuditStatus = 'pass' | 'warn' | 'fail' | 'backfill' | (string & {});

export interface PublishRecommendationInput {
  traceId: string;
  clusterKey: string;
  asOf: Date;
  auditStatus: PublishAuditStatus;
  reason?: string | null;
  /** 显式递增版本（同日重发新版本）。默认false=幂等。 */
  forceNewVersion?: boolean;
}

export interface PublishRecommendationResult {
  id: string;
  traceId: string;
  publishVersion: number;
  publishedAt: Date;
  auditStatus: string;
  reason: string | null;
  /** 被本版本取代的旧版本号（仅在新建版本时非 null）。 */
  supersededVersion: number | null;
  /** true=命中幂等复用，未新建记录。 */
  reused: boolean;
}

const normalizeReason = (reason: string | null | undefined): string | null =>
  reason === undefined ? null : reason;

/**
 * 原子发布：在单个事务内创建 `RecommendationPublish` 记录（版本 = 该 trace 已有最大版本 +1），
 * 并把同一 trace 的 `RecommendationSnapshot.isPublished` 置为 true（兼容读路径）。
 */
export async function publishRecommendation(
  prisma: PrismaClient,
  input: PublishRecommendationInput,
): Promise<PublishRecommendationResult> {
  const reason = normalizeReason(input.reason);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.recommendationPublish.findMany({
      where: { traceId: input.traceId },
      orderBy: { publishVersion: 'desc' },
      take: 1,
    });
    const latest = existing[0];
    const nextVersion = (latest?.publishVersion ?? 0) + 1;

    // 幂等：同一 trace 已有未被取代的发布记录时直接复用，避免 publish_only/daily 等
    // 不同入口因 reason/auditStatus 差异重复生成版本。
    if (!input.forceNewVersion && latest) {
      await tx.recommendationSnapshot.updateMany({
        where: { traceId: input.traceId },
        data: { isPublished: true },
      });
      return {
        id: latest.id,
        traceId: input.traceId,
        publishVersion: latest.publishVersion,
        publishedAt: latest.publishedAt,
        auditStatus: latest.auditStatus,
        reason: latest.reason,
        supersededVersion: null,
        reused: true,
      } satisfies PublishRecommendationResult;
    }

    const created = await tx.recommendationPublish.create({
      data: {
        traceId: input.traceId,
        publishVersion: nextVersion,
        publishedAt: new Date(),
        auditStatus: input.auditStatus,
        reason,
        asOf: input.asOf,
        clusterKey: input.clusterKey,
      },
    });

    // 旧版本 supersededBy 指向新记录。
    if (latest) {
      await tx.recommendationPublish.update({
        where: { id: latest.id },
        data: { supersededBy: created.id },
      });
    }

    // 兼容读路径：置 isPublished=true。
    await tx.recommendationSnapshot.updateMany({
      where: { traceId: input.traceId },
      data: { isPublished: true },
    });

    return {
      id: created.id,
      traceId: input.traceId,
      publishVersion: created.publishVersion,
      publishedAt: created.publishedAt,
      auditStatus: created.auditStatus,
      reason: created.reason,
      supersededVersion: latest?.publishVersion ?? null,
      reused: false,
    } satisfies PublishRecommendationResult;
  });
}

export interface GetLatestPublishOptions {
  clusterKey: string;
  /** 可选：按 asOf 的北京日（东八区 +8h）过滤。 */
  asOf?: Date | string;
}

/**
 * 取某 cluster/asOf 下最新已发布版本（未被取代的版本）。
 * 默认读到“最新已发布版本”。
 */
export async function getLatestPublish(
  prisma: PrismaClient,
  options: GetLatestPublishOptions,
): Promise<{
  id: string;
  traceId: string;
  publishVersion: number;
  publishedAt: Date;
  auditStatus: string;
  reason: string | null;
  asOf: Date;
  clusterKey: string;
} | null> {
  const where: Prisma.RecommendationPublishWhereInput = { supersededBy: null };
  if (options.asOf !== undefined) {
    const asOf = options.asOf instanceof Date ? options.asOf : new Date(options.asOf);
    const start = new Date(asOf.getTime() - 8 * 60 * 60 * 1000);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    where.asOf = { gte: start, lt: end };
  }
  const found = await prisma.recommendationPublish.findFirst({
    where: { ...where, clusterKey: options.clusterKey },
    orderBy: { publishVersion: 'desc' },
  });
  return found;
}

/**
 * 判断某 trace 是否已发布（存在未被取代的发布记录）。
 */
export async function isPublishedTrace(
  prisma: PrismaClient,
  traceId: string,
): Promise<boolean> {
  const count = await prisma.recommendationPublish.count({
    where: { traceId, supersededBy: null },
  });
  return count > 0;
}

/**
 * 取某 cluster/asOf 下所有“已发布 traceId”集合（用于行级过滤）。
 */
export async function getPublishedTraceIds(
  prisma: PrismaClient,
  options: GetLatestPublishOptions,
): Promise<ReadonlySet<string>> {
  const where: Prisma.RecommendationPublishWhereInput = { supersededBy: null };
  if (options.asOf !== undefined) {
    const asOf = options.asOf instanceof Date ? options.asOf : new Date(options.asOf);
    const start = new Date(asOf.getTime() - 8 * 60 * 60 * 1000);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    where.asOf = { gte: start, lt: end };
  }
  const rows = await prisma.recommendationPublish.findMany({
    where: { ...where, clusterKey: options.clusterKey },
    select: { traceId: true },
  });
  return new Set(rows.map((row) => row.traceId));
}
