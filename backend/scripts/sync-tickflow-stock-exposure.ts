/**
 * sync-tickflow-stock-exposure.ts
 *
 * 独立的 TickFlow 行业暴露刷新脚本（定时任务用）。
 * 每日推荐链路在暴露数据过期时也会自动刷新；本脚本用于按月强制刷新一次，
 * 保证在推荐链路未运行的时间段内暴露事实不会长期过期。
 *
 * 用法：
 *   DATABASE_URL=... bun dist/scripts/sync-tickflow-stock-exposure.js [--cluster global]
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createTickFlowStockExposureServiceFromEnv } from '../src/services/tickflow-stock-exposure-service.js';

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
  const clusterKey = parseArgs().cluster ?? process.env.CLUSTER_KEY ?? 'global';

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    // 股票名映射优先取 Stock 表，缺失时回退到既有的可信暴露事实，避免把空名字喂给上游。
    const stockNameBySymbol = new Map<string, string>();
    const stocks = await prisma.stock.findMany({
      where: { clusterKey },
      select: { symbol: true, name: true },
    });
    for (const stock of stocks) {
      if (/^\d{6}$/u.test(stock.symbol) && stock.name.trim().length > 0) {
        stockNameBySymbol.set(stock.symbol, stock.name);
      }
    }
    const facts = await prisma.stockExposureFact.findMany({
      where: { clusterKey, status: 'active', source: 'tickflow_sw_universe' },
      select: { symbol: true, stockName: true },
    });
    for (const fact of facts) {
      if (!stockNameBySymbol.has(fact.symbol) && fact.stockName.trim().length > 0) {
        stockNameBySymbol.set(fact.symbol, fact.stockName);
      }
    }

    const service = createTickFlowStockExposureServiceFromEnv();
    const result = await service.sync(prisma, {
      traceId: `scheduler-tickflow-${randomUUID()}`,
      asOf: new Date(),
      clusterKey,
      stockNameBySymbol,
    });

    console.log(JSON.stringify({
      clusterKey,
      universeCount: result.universeCount,
      acceptedUniverseCount: result.acceptedUniverseCount,
      candidateCount: result.candidateCount,
      promotedFactCount: result.promotedFactCount,
      rejectedCount: result.rejectedCount,
      failures: result.failures.slice(0, 5),
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
};

await main();
