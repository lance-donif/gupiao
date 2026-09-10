/**
 * 行情信号加载器（从 scoring-contribution-engine 抽离的读取段落）。
 *
 * 本文件只负责「行情读取」，并统一经由 market-data-reader 施加：
 *  - 业务时间校验（tradingDay <= asOf）
 *  - 可信可见时间校验（visibleAt ?? dailyCloseVisibleAt <= asOf）
 * 严格禁止把盘中未收盘 / 未来交易日 K 线纳入特征。
 *
 * 这三个函数对应原 scoring-contribution-engine 中的三处泄漏点：
 *  - loadMarketSignalFreshnessBySymbol
 *  - loadRecentCandlesRawSql
 *  - loadRecentCandlesPrismaFallback
 */
import type { IMarketSignalFreshness } from '../scoring-contribution-engine.js';
import { hasDelegate } from './scoring-helpers.js';
import {
  isCandleVisibleAsOf,
  readCandles,
  datasetVersionWhere,
  buildDatasetSqlClause,
} from '../market-data/market-data-reader.js';

const toDayKey = (value: Date | null | undefined): string | null => {
  return value?.toISOString?.().slice(0, 10) ?? null;
};

/**
 * 修复点 1：市场信号新鲜度。原实现只判 tradingDay <= asOf，完全无可见性守卫。
 * 现改为：首先按 asOf 仅纳入「已可见」的 K 线，再计算最新可见交易日与陈旧交易日数。
 * 对历史日（asOf 在收盘后）结果与旧逻辑一致；对盘中 asOf 不再把当日未收盘日线计入。
 */
export const loadMarketSignalFreshnessBySymbol = async (
  prisma: any,
  input: {
    readonly clusterKey: string;
    readonly asOf: Date;
    readonly snapshots: readonly { readonly symbol: string; readonly latestTradingDay: Date | null }[];
  },
  datasetVersionId?: string | null,
): Promise<Map<string, IMarketSignalFreshness>> => {
  const symbols = [...new Set(input.snapshots.map(row => row.symbol))];
  const snapshotBySymbol = new Map(input.snapshots.map(row => [row.symbol, row.latestTradingDay]));
  const results = new Map<string, IMarketSignalFreshness>();
  if (symbols.length === 0 || !hasDelegate(prisma, 'candle', 'findMany')) {
    return results;
  }

  if (typeof prisma?.$queryRawUnsafe === 'function') {
    const dataset = buildDatasetSqlClause(datasetVersionId, 3);
    const params: unknown[] = [input.clusterKey, input.asOf, symbols];
    if (dataset.param !== null) {
      params.push(dataset.param);
    }
    const rows = await prisma.$queryRawUnsafe(
      [
        'SELECT s.symbol AS "symbol", c."tradingDay" AS "tradingDay", c."visibleAt" AS "visibleAt"',
        'FROM "Stock" s',
        `JOIN "Candle" c ON c."stockId" = s.id AND c."tradingDay" <= $2${dataset.clause}`,
        'WHERE s."clusterKey" = $1 AND s.symbol = ANY($3::text[])',
      ].join(' '),
      ...params,
    ) as readonly any[];

    const visibleBySymbol = new Map<string, Date[]>();
    for (const row of rows) {
      const candle = {
        tradingDay: new Date(row.tradingDay),
        visibleAt: row.visibleAt ? new Date(row.visibleAt) : null,
      };
      if (!isCandleVisibleAsOf(candle, input.asOf)) {
        continue;
      }
      const symbol = String(row.symbol);
      const arr = visibleBySymbol.get(symbol) ?? [];
      arr.push(candle.tradingDay);
      visibleBySymbol.set(symbol, arr);
    }

    for (const symbol of symbols) {
      const days = visibleBySymbol.get(symbol) ?? [];
      const latest = days.length
        ? days.reduce((a, b) => (a.getTime() > b.getTime() ? a : b))
        : null;
      const snapshotTradingDay = snapshotBySymbol.get(symbol);
      const staleTradingDays = snapshotTradingDay
        ? days.filter(d => d.getTime() > snapshotTradingDay.getTime()).length
        : 0;
      results.set(symbol, {
        latestMarketTradingDay: toDayKey(latest),
        latestMarketTradingDayDate: latest,
        staleTradingDays,
      });
    }
    return results;
  }

  const candles = await prisma.candle.findMany({
    where: {
      stock: {
        clusterKey: input.clusterKey,
        symbol: { in: symbols },
      },
      tradingDay: { lte: input.asOf },
      ...datasetVersionWhere(datasetVersionId),
    },
    select: {
      tradingDay: true,
      visibleAt: true,
      stock: { select: { symbol: true } },
    },
    orderBy: [
      { stockId: 'asc' },
      { tradingDay: 'desc' },
    ],
  });

  for (const symbol of symbols) {
    results.set(symbol, {
      latestMarketTradingDay: null,
      latestMarketTradingDayDate: null,
      staleTradingDays: 0,
    });
  }

  const visibleBySymbol = new Map<string, Date[]>();
  for (const candle of candles) {
    const symbol = String(candle.stock?.symbol ?? '');
    if (!symbol) {
      continue;
    }
    const wrapped = {
      tradingDay: candle.tradingDay instanceof Date ? candle.tradingDay : new Date(candle.tradingDay),
      visibleAt: candle.visibleAt ? new Date(candle.visibleAt) : null,
    };
    if (!isCandleVisibleAsOf(wrapped, input.asOf)) {
      continue;
    }
    const arr = visibleBySymbol.get(symbol) ?? [];
    arr.push(wrapped.tradingDay);
    visibleBySymbol.set(symbol, arr);
  }

  for (const symbol of symbols) {
    const days = visibleBySymbol.get(symbol) ?? [];
    const latest = days.length
      ? days.reduce((a, b) => (a.getTime() > b.getTime() ? a : b))
      : null;
    const snapshotTradingDay = snapshotBySymbol.get(symbol);
    const staleTradingDays = snapshotTradingDay
      ? days.filter(d => d.getTime() > snapshotTradingDay.getTime()).length
      : 0;
    results.set(symbol, {
      latestMarketTradingDay: toDayKey(latest),
      latestMarketTradingDayDate: latest,
      staleTradingDays,
    });
  }

  return results;
};

/**
 * 修复点 2：原始 SQL 批量读取近期 K 线。原实现只判 c."tradingDay" <= $2，无可见性守卫。
 * 现：窗口内 tradingDay <= asOf 且已可见；按 stockId 聚合后取最近 lookbackDays 条。
 */
export const loadRecentCandlesRawSql = async (
  prisma: any,
  input: {
    readonly clusterKey: string;
    readonly asOf: Date;
    readonly stockIds: readonly string[];
  },
  lookbackDays: number,
  datasetVersionId?: string | null,
): Promise<Map<string, any[]>> => {
  const fromTradingDay = new Date(
    input.asOf.getTime() - (lookbackDays * 3 + 60) * 24 * 60 * 60 * 1000,
  );
  const rows = await readCandles(prisma, {
    clusterKey: input.clusterKey,
    asOf: input.asOf,
    stockIds: input.stockIds,
    fromTradingDay,
    datasetVersionId,
    columns: [
      'c."tradingDay"', 'c.open', 'c.high', 'c.low', 'c.close', 'c.volume',
      'c."visibleAt"', 'c."datasetVersionId"',
    ],
  });

  const candlesByStockId = new Map<string, any[]>();
  for (const row of rows) {
    const stockId = String(row.stockId);
    const list = candlesByStockId.get(stockId) ?? [];
    if (list.length < lookbackDays) {
      list.push(row);
      candlesByStockId.set(stockId, list);
    }
  }
  return candlesByStockId;
};

/**
 * 修复点 3：Prisma findMany 回退路径。原实现只判 tradingDay lte/gte，无可见性守卫。
 * 现：readCandles 已施加可见性过滤，这里仅做按 stockId 聚合与条数截断。
 */
export const loadRecentCandlesPrismaFallback = async (
  prisma: any,
  input: {
    readonly stockIds: readonly string[];
    readonly asOf: Date;
  },
  lookbackDays: number,
  datasetVersionId?: string | null,
): Promise<Map<string, any[]>> => {
  const calendarDays = Math.ceil(lookbackDays * 1.6) + 15;
  const fromTradingDay = new Date(input.asOf.getTime() - calendarDays * 24 * 60 * 60 * 1000);
  const rows = await readCandles(prisma, {
    asOf: input.asOf,
    stockIds: input.stockIds,
    fromTradingDay,
    datasetVersionId,
  });

  const candlesByStockId = new Map<string, any[]>();
  for (const row of rows) {
    const stockId = String(row.stockId);
    const list = candlesByStockId.get(stockId) ?? [];
    if (list.length < lookbackDays) {
      list.push(row);
      candlesByStockId.set(stockId, list);
    }
  }
  return candlesByStockId;
};
