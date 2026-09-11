/**
 * backfill-yield-records.ts —— 历史推荐收益对账（定时任务用）
 *
 * 为已存在的 RecommendationSnapshot 回填 1/3/5 日收益元数据：
 *  - 复用 backtest-engine 的 `buildYieldRecordDrafts`，成熟度/可见时间口径与推荐链路一致；
 *  - 只使用 asOf 之后的可见 K 线，5 日不足时保持 immature，绝不用 1/3 日填充；
 *  - 缺交易状态标记 coverage_gap，不默认成交。
 *
 * 用法：
 *   DATABASE_URL=... bun dist/scripts/backfill-yield-records.js [--cluster global] [--limit 2000]
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  buildRecommendationSnapshotYieldUpdate,
  buildYieldRecordDrafts,
  YIELD_COMPUTE_VERSION,
} from '../src/services/backtest-engine.js';

const parseArgs = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i += 1) {
    const token = process.argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = process.argv[i + 1];
    out[key] = next && !next.startsWith('--') ? process.argv[++i] : 'true';
  }
  return out;
};

const main = async (): Promise<void> => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const args = parseArgs();
  const clusterKey = args.cluster ?? process.env.CLUSTER_KEY ?? 'global';
  const limit = Number(args.limit ?? 2000);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error(`Invalid --limit: ${args.limit}`);

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    const snapshots = await prisma.recommendationSnapshot.findMany({
      // 未收口 + 5 日未走完的都要扫：前者首次回填，后者补齐 3/5 日收益；
      // 5 日已可见的行不再碰（终态），全 gap 的行每次重扫（有界，旧行会滑出窗口）。
      where: { clusterKey, OR: [{ isReconciled: false }, { yield5DayVisibleAt: null }] },
      orderBy: { asOf: 'desc' },
      take: limit,
    });
    const maturityReferenceTime = new Date();
    let scanned = 0;
    let upserted = 0;
    let immature = 0;
    let coverageGap = 0;
    let snapshotsUpdated = 0;
    let snapshotsReconciled = 0;

    for (const snap of snapshots) {
      scanned += 1;
      const stock = await prisma.stock.findFirst({
        where: { clusterKey, symbol: snap.symbol },
        select: { id: true },
      });
      if (!stock) {
        coverageGap += 1;
        continue;
      }
      const asOf = snap.asOf instanceof Date ? snap.asOf : new Date(snap.asOf);
      const [baseCandle, futureCandles] = await Promise.all([
        prisma.candle.findFirst({
          where: { stockId: stock.id, tradingDay: { lte: asOf } },
          orderBy: { tradingDay: 'desc' },
        }),
        prisma.candle.findMany({
          where: { stockId: stock.id, tradingDay: { gt: asOf } },
          orderBy: { tradingDay: 'asc' },
          take: 5,
        }),
      ]);
      const p0 = Number(baseCandle?.close ?? 0);
      if (!Number.isFinite(p0) || p0 <= 0) {
        coverageGap += 1;
        continue;
      }

      const drafts = buildYieldRecordDrafts({
        snapshotId: snap.id,
        symbol: snap.symbol,
        p0,
        futureCandles,
        computeVersion: YIELD_COMPUTE_VERSION,
        maturityReferenceTime,
      });
      for (const draft of drafts) {
        if (draft.status === 'immature') immature += 1;
        if (draft.status === 'coverage_gap') coverageGap += 1;
        await prisma.yieldRecord.upsert({
          where: {
            snapshotId_symbol_horizon_computeVersion: {
              snapshotId: draft.snapshotId,
              symbol: draft.symbol,
              horizon: draft.horizon,
              computeVersion: draft.computeVersion,
            },
          },
          create: {
            snapshotId: draft.snapshotId,
            symbol: draft.symbol,
            horizon: draft.horizon,
            value: draft.value,
            status: draft.status,
            plannedExitDay: draft.plannedExitDay,
            actualExitDay: draft.actualExitDay,
            maturityAt: draft.maturityAt,
            computeVersion: draft.computeVersion,
          },
          update: {
            value: draft.value,
            status: draft.status,
            plannedExitDay: draft.plannedExitDay,
            actualExitDay: draft.actualExitDay,
            maturityAt: draft.maturityAt,
          },
        });
        upserted += 1;
      }

      // 同步回填 RecommendationSnapshot：惩罚只读快照表，不读 YieldRecord，
      // 缺这一步则关键词惩罚永远看到 0 条已对账推荐。
      const snapshotUpdate = buildRecommendationSnapshotYieldUpdate({ p0, futureCandles, drafts, maturityReferenceTime });
      if (snapshotUpdate !== null) {
        await prisma.recommendationSnapshot.update({
          where: { id: snap.id },
          data: {
            realizedPrice: new Prisma.Decimal(snapshotUpdate.realizedPrice),
            realizedPriceTarget: new Prisma.Decimal(snapshotUpdate.realizedPriceTarget),
            yield1Day: snapshotUpdate.yield1Day !== null ? new Prisma.Decimal(snapshotUpdate.yield1Day) : null,
            yield3Day: snapshotUpdate.yield3Day !== null ? new Prisma.Decimal(snapshotUpdate.yield3Day) : null,
            yield5Day: snapshotUpdate.yield5Day !== null ? new Prisma.Decimal(snapshotUpdate.yield5Day) : null,
            yield1DayVisibleAt: snapshotUpdate.yield1DayVisibleAt,
            yield3DayVisibleAt: snapshotUpdate.yield3DayVisibleAt,
            yield5DayVisibleAt: snapshotUpdate.yield5DayVisibleAt,
            isReconciled: snapshotUpdate.isReconciled,
          },
        });
        snapshotsUpdated += 1;
        if (snapshotUpdate.isReconciled) snapshotsReconciled += 1;
      }
    }

    console.log(JSON.stringify({
      clusterKey,
      computeVersion: YIELD_COMPUTE_VERSION,
      scanned,
      upserted,
      immature,
      coverageGap,
      snapshotsUpdated,
      snapshotsReconciled,
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
};

await main();
