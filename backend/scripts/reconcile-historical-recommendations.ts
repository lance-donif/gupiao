/**
 * 历史推荐对账脚本
 *
 * 用途：对账距 asOf 已超过 MIN_TRADING_DAYS 个交易日的未对账 RecommendationSnapshot，
 *       计算 T+1/T+3/T+5 实际收益，更新快照并触发关键词表现惩罚。
 *
 * 用法：cd backend && bun run scripts/reconcile-historical-recommendations.ts
 * 通常由每日调度器或 cron 在收盘后自动运行。
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import pg from 'pg';

import { loadBackendEnv } from '../src/services/load-backend-env.js';
import { KeywordPerformancePenaltyService } from '../src/services/keyword-performance-penalty-service.js';

loadBackendEnv();

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://gupiao:password@localhost:5432/gupiaodb';
const DEFAULT_CLUSTER_KEY = 'global';
const MIN_TRADING_DAYS_AFTER_ASOF = 5;
const MAX_LOOKBACK_DAYS = 60;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface IReconciliationRow {
  traceId: string;
  symbol: string;
  asOf: Date;
  stockId: string;
  scoreBreakdown: any;
  rank: number;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL }),
  });
  const pgClient = new pg.Client({ connectionString: DATABASE_URL });
  await pgClient.connect();

  try {
    const now = new Date();
    const lookbackStart = new Date(now.getTime() - MAX_LOOKBACK_DAYS * ONE_DAY_MS);

    // 1. 查询未对账的推荐快照（按 traceId 分组批量处理）
    const unreconciled = await prisma.recommendationSnapshot.findMany({
      where: {
        clusterKey: DEFAULT_CLUSTER_KEY,
        isReconciled: false,
        asOf: {
          gte: lookbackStart,
          lte: now,
        },
      },
      orderBy: { asOf: 'asc' },
      select: {
        traceId: true,
        symbol: true,
        asOf: true,
        rank: true,
        scoreBreakdown: true,
      },
    }) as IReconciliationRow[];

    if (unreconciled.length === 0) {
      console.log(JSON.stringify({ status: 'NO_PENDING', unreconciledCount: 0 }));
      return;
    }

    console.log(`[reconcile] 发现 ${unreconciled.length} 条未对账推荐，开始处理...`);

    // 2. 按 traceId 分组
    const rowsByTraceId = new Map<string, IReconciliationRow[]>();
    for (const row of unreconciled) {
      const list = rowsByTraceId.get(row.traceId) ?? [];
      list.push(row);
      rowsByTraceId.set(row.traceId, list);
    }

    let totalReconciled = 0;
    let totalSkipped = 0;
    let totalMissingCandles = 0;

    // 3. 逐 traceId 处理
    for (const [traceId, rows] of rowsByTraceId.entries()) {
      const symbols = [...new Set(rows.map(r => r.symbol))];
      const asOf = rows[0].asOf;

      // 检查是否足够久远（asOf 后至少需要 MIN_TRADING_DAYS 个交易日）
      // 使用 Candle 表判断：对于每个 symbol，检查 asOf 后的交易日数量
      const stocks = await prisma.stock.findMany({
        where: {
          clusterKey: DEFAULT_CLUSTER_KEY,
          symbol: { in: symbols },
        },
      });

      const stockIds = stocks.map((s: any) => s.id);
      const stockMap = new Map(stocks.map((s: any) => [s.symbol, s]));

      // 查询 asOf 前后各 30 天的 Candle
      const marginBefore = new Date(asOf.getTime() - 30 * ONE_DAY_MS);
      const marginAfter = new Date(asOf.getTime() + 30 * ONE_DAY_MS);
      const allCandles = await prisma.candle.findMany({
        where: {
          stockId: { in: stockIds },
          tradingDay: { gte: marginBefore, lte: marginAfter },
        },
        orderBy: { tradingDay: 'asc' },
      });

      const candlesByStockId = new Map<string, any[]>();
      for (const candle of allCandles) {
        const list = candlesByStockId.get(candle.stockId) ?? [];
        list.push(candle);
        candlesByStockId.set(candle.stockId, list);
      }

      const updates: any[] = [];

      for (const row of rows) {
        const stock = stockMap.get(row.symbol);
        if (!stock) {
          totalSkipped++;
          continue;
        }

        const stockCandles = candlesByStockId.get(stock.id) ?? [];
        const baseCandles = stockCandles
          .filter((c: any) => c.tradingDay.getTime() <= asOf.getTime())
          .sort((left: any, right: any) => right.tradingDay.getTime() - left.tradingDay.getTime());
        const futureCandles = stockCandles
          .filter((c: any) => c.tradingDay.getTime() > asOf.getTime())
          .sort((left: any, right: any) => left.tradingDay.getTime() - right.tradingDay.getTime());

        // 检查未来数据是否足够（至少需要 MIN_TRADING_DAYS 个交易日）
        if (futureCandles.length < MIN_TRADING_DAYS_AFTER_ASOF) {
          totalMissingCandles++;
          continue;
        }

        if (baseCandles.length === 0) {
          totalSkipped++;
          continue;
        }

        const p0 = Number(baseCandles[0].close);
        const p1Candle = futureCandles[0];
        const p3Candle = futureCandles.length >= 3 ? futureCandles[2] : null;
        const p5Candle = futureCandles.length >= 5 ? futureCandles[4] : null;

        const yield1Day = p1Candle ? (Number(p1Candle.close) - p0) / p0 : null;
        const yield3Day = p3Candle ? (Number(p3Candle.close) - p0) / p0 : null;
        const yield5Day = p5Candle ? (Number(p5Candle.close) - p0) / p0 : null;

        const realizedPriceTarget = p5Candle
          ? Number(p5Candle.close)
          : p3Candle
          ? Number(p3Candle.close)
          : Number(p1Candle.close);

        updates.push(
          prisma.recommendationSnapshot.update({
            where: {
              traceId_symbol: {
                traceId,
                symbol: row.symbol,
              },
            },
            data: {
              realizedPrice: new Prisma.Decimal(p0),
              realizedPriceTarget: new Prisma.Decimal(realizedPriceTarget),
              yield1Day: yield1Day !== null ? new Prisma.Decimal(yield1Day) : null,
              yield3Day: yield3Day !== null ? new Prisma.Decimal(yield3Day) : null,
              yield5Day: yield5Day !== null ? new Prisma.Decimal(yield5Day) : null,
              isReconciled: true,
            },
          }),
        );
        totalReconciled++;
      }

      if (updates.length > 0) {
        await prisma.$transaction(updates);
        console.log(`[reconcile] traceId=${traceId} asOf=${asOf.toISOString().slice(0, 10)} reconciled=${updates.length}`);
      }
    }

    const result = {
      status: 'COMPLETED',
      totalUnreconciled: unreconciled.length,
      totalReconciled,
      totalSkipped,
      totalMissingCandles,
      pendingForLater: totalMissingCandles,
    };

    console.log(JSON.stringify(result, null, 2));

    // 4. 对账完成后重新运行关键词表现惩罚
    if (totalReconciled > 0) {
      console.log('[reconcile] 对账成功，触发关键词表现惩罚刷新...');
      const penaltyResult = await new KeywordPerformancePenaltyService().refresh(prisma, {
        asOf: now,
        clusterKey: DEFAULT_CLUSTER_KEY,
      });
      console.log(JSON.stringify({
        step: 'keyword_performance_penalty',
        ...penaltyResult,
      }, null, 2));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ status: 'FAILED', error: message }));
    process.exitCode = 1;
  } finally {
    await pgClient.end();
    await prisma.$disconnect();
  }
}

void main();
