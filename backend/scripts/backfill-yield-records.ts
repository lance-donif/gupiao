/**
 * backfill-yield-records.ts
 * Writes 1/3/5-day YieldRecord rows for existing RecommendationSnapshot rows using visible candles.
 * Short horizon is never used to fill 5d.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const main = async (): Promise<void> => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    const snapshots = await prisma.recommendationSnapshot.findMany();
    const symbols = [...new Set(snapshots.map(s => s.symbol))];
    const stocks = await prisma.stock.findMany({ where: { symbol: { in: symbols } }, select: { id: true, symbol: true } });
    const stockIdBySymbol = new Map(stocks.map(s => [s.symbol, s.id]));
    let upserted = 0;
    for (const snap of snapshots) {
      const stockId = stockIdBySymbol.get(snap.symbol);
      if (!stockId) continue;
      const asOf = snap.asOf instanceof Date ? snap.asOf : new Date(snap.asOf);
      const future = await prisma.candle.findMany({
        where: { stockId, tradingDay: { gt: asOf } },
        orderBy: { tradingDay: 'asc' },
        take: 5,
      });
      if (!future.length) continue;
      const p0 = Number(future[0]?.close ?? 0);
      const horizons = [1, 3, 5] as const;
      for (const horizon of horizons) {
        const idx = horizon - 1;
        const exit = future[idx];
        if (!exit) continue;
        const value = p0 > 0 ? (Number(exit.close) - p0) / p0 : null;
        const plannedExitDay = exit.tradingDay;
        const maturityAt = new Date(plannedExitDay.getTime() + 15 * 3600 * 1000);
        await prisma.yieldRecord.upsert({
          where: {
            snapshotId_symbol_horizon_computeVersion: { snapshotId: snap.id, symbol: snap.symbol, horizon, computeVersion: 'm5-backfill-v1' },
          },
          create: { snapshotId: snap.id, symbol: snap.symbol, horizon, value, status: 'mature', plannedExitDay, actualExitDay: plannedExitDay, maturityAt, computeVersion: 'm5-backfill-v1' },
          update: { value, plannedExitDay, actualExitDay: plannedExitDay, maturityAt },
        });
        upserted += 1;
      }
    }
    console.log(JSON.stringify({ snapshots: snapshots.length, upserted }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
};

await main();
