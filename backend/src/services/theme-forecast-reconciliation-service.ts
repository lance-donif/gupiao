import { Prisma } from '@prisma/client';
import { hasPrismaDelegateMethod } from './prisma-utils.js';

/**
 * 主题预测 T+5 对账服务
 *
 * 在预测发出 5 个交易日后，回填实际涨跌方向和幅度，用于：
 * 1. 评估预测准确率
 * 2. 喂给模块3的集团自提升闭环
 */

export interface IThemeForecastReconciliationInput {
  readonly asOf: Date;
  readonly clusterKey: string;
}

export interface IThemeForecastReconciliationResult {
  readonly reconciledCount: number;
  readonly hitCount: number;  // 方向命中数
  readonly hitRate: number;
  readonly details: readonly {
    readonly theme: string;
    readonly direction: string;
    readonly realizedDirection: string;
    readonly realizedChangePct: number;
    readonly isHit: boolean;
  }[];
}

const FLAT_CHANGE_THRESHOLD = 0.01;  // 涨跌<1%视为平
const RECONCILIATION_LOOKBACK_DAYS = 15;  // 日历日，覆盖约10个交易日

const hasDelegate = (prisma: any, delegateName: string, methodName: string): boolean => {
  return hasPrismaDelegateMethod(prisma, delegateName, methodName);
};

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const classifyRealizedDirection = (changePct: number): 'up' | 'down' | 'flat' => {
  if (changePct > FLAT_CHANGE_THRESHOLD) {
    return 'up';
  }
  if (changePct < -FLAT_CHANGE_THRESHOLD) {
    return 'down';
  }
  return 'flat';
};

const isForecastHit = (forecastDirection: string, realizedDirection: string): boolean => {
  if (forecastDirection === 'bullish' && realizedDirection === 'up') {
    return true;
  }
  if (forecastDirection === 'bearish' && realizedDirection === 'down') {
    return true;
  }
  if (forecastDirection === 'neutral' && realizedDirection === 'flat') {
    return true;
  }
  return false;
};

export class ThemeForecastReconciliationService {
  /**
   * 对账 asOf 之前已到期的 ThemeForecast。
   */
  public async reconcile(prisma: any, input: IThemeForecastReconciliationInput): Promise<IThemeForecastReconciliationResult> {
    if (!hasDelegate(prisma, 'themeForecast', 'findMany') || !hasDelegate(prisma, 'themeForecast', 'update')) {
      return { reconciledCount: 0, hitCount: 0, hitRate: 0, details: [] };
    }

    // 找出已过 horizon 且未对账的预测
    const cutoff = new Date(input.asOf.getTime() - RECONCILIATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const pendingForecasts = await prisma.themeForecast.findMany({
      where: {
        clusterKey: input.clusterKey,
        isReconciled: false,
        asOf: { gte: cutoff, lt: input.asOf },
      },
    });

    if (pendingForecasts.length === 0) {
      return { reconciledCount: 0, hitCount: 0, hitRate: 0, details: [] };
    }

    // 收集所有需要查行情的 symbol
    const symbolByTheme = new Map<string, string[]>();
    for (const forecast of pendingForecasts) {
      const symbols = Array.isArray(forecast.relatedSymbols) ? forecast.relatedSymbols : [];
      symbolByTheme.set(String(forecast.theme), symbols.map(String));
    }
    const allSymbols = [...new Set([...symbolByTheme.values()].flatMap(list => list))];

    // 查 stockId
    const stockIdBySymbol = new Map<string, string>();
    if (allSymbols.length > 0 && hasDelegate(prisma, 'stock', 'findMany')) {
      const stocks = await prisma.stock.findMany({
        where: { clusterKey: input.clusterKey, symbol: { in: allSymbols } },
        select: { id: true, symbol: true },
      });
      for (const stock of stocks) {
        stockIdBySymbol.set(String(stock.symbol), String(stock.id));
      }
    }

    // 预算所有需要查的 (stockId, forecastAsOf) 组合，做批量查询避免循环内 N+1
    const allStockIds: string[] = [];
    const forecastAsOfById = new Map<string, Date>();
    for (const forecast of pendingForecasts) {
      const theme = String(forecast.theme);
      const symbols = symbolByTheme.get(theme) ?? [];
      const stockIds = symbols
        .map(s => stockIdBySymbol.get(s))
        .filter((id): id is string => Boolean(id));
      for (const stockId of stockIds) {
        if (!allStockIds.includes(stockId)) {
          allStockIds.push(stockId);
        }
      }
      const forecastAsOf = forecast.asOf instanceof Date
        ? forecast.asOf
        : new Date(String(forecast.asOf));
      forecastAsOfById.set(String(forecast.id), forecastAsOf);
    }
    const minForecastAsOf = forecastAsOfById.size > 0
      ? new Date(Math.min(...[...forecastAsOfById.values()].map(d => d.getTime())))
      : new Date(input.asOf.getTime());

    // 批量查 future + base Candle（仅 2 次 round-trip，不随 forecast 数量增长）
    const allFutureCandles = hasDelegate(prisma, 'candle', 'findMany')
      ? await prisma.candle.findMany({
          where: {
            stockId: { in: allStockIds },
            tradingDay: { gt: minForecastAsOf, lte: input.asOf },
          },
          orderBy: [{ stockId: 'asc' }, { tradingDay: 'asc' }],
        })
      : [];
    const allBaseCandles = hasDelegate(prisma, 'candle', 'findMany')
      ? await prisma.candle.findMany({
          where: {
            stockId: { in: allStockIds },
            tradingDay: { lte: input.asOf },
          },
          orderBy: [{ stockId: 'asc' }, { tradingDay: 'desc' }],
        })
      : [];

    // 按 stockId 内存分组
    const futureCandlesByStockId = new Map<string, { tradingDay: Date; close: unknown }[]>();
    for (const candle of allFutureCandles) {
      const stockId = String(candle.stockId);
      const list = futureCandlesByStockId.get(stockId) ?? [];
      list.push({ tradingDay: candle.tradingDay, close: candle.close });
      futureCandlesByStockId.set(stockId, list);
    }
    const baseCandlesByStockId = new Map<string, { tradingDay: Date; close: unknown }[]>();
    for (const candle of allBaseCandles) {
      const stockId = String(candle.stockId);
      const list = baseCandlesByStockId.get(stockId) ?? [];
      list.push({ tradingDay: candle.tradingDay, close: candle.close });
      baseCandlesByStockId.set(stockId, list);
    }

    // 对每个 forecast，计算预测日后5个交易日的实际涨跌（纯内存计算，无 DB 查询）
    const details: Array<{
      readonly theme: string;
      readonly direction: string;
      readonly realizedDirection: string;
      readonly realizedChangePct: number;
      readonly isHit: boolean;
    }> = [];
    let hitCount = 0;

    for (const forecast of pendingForecasts) {
      const theme = String(forecast.theme);
      const forecastAsOf = forecastAsOfById.get(String(forecast.id))!;
      const symbols = symbolByTheme.get(theme) ?? [];
      const stockIds = symbols
        .map(s => stockIdBySymbol.get(s))
        .filter((id): id is string => Boolean(id));
      if (stockIds.length === 0) {
        continue;
      }

      const changePcts: number[] = [];
      for (const stockId of stockIds) {
        // base：tradingDay <= forecastAsOf 的最近一根（baseCandles 列表已按 desc 排序）
        const baseList = baseCandlesByStockId.get(stockId) ?? [];
        const baseCandle = baseList.find(c => c.tradingDay.getTime() <= forecastAsOf.getTime());
        const baseClose = baseCandle ? toNumber(baseCandle.close) : 0;
        if (!baseClose || baseClose <= 0) {
          continue;
        }

        // future：tradingDay > forecastAsOf 的前 5 个交易日
        const futureList = (futureCandlesByStockId.get(stockId) ?? [])
          .filter(c => c.tradingDay.getTime() > forecastAsOf.getTime())
          .slice(0, 5);
        if (futureList.length === 0) {
          continue;
        }

        const futureClose = toNumber(futureList[futureList.length - 1].close);
        if (futureClose > 0) {
          changePcts.push((futureClose - baseClose) / baseClose);
        }
      }

      if (changePcts.length === 0) {
        continue;
      }

      const avgChangePct = changePcts.reduce((sum, value) => sum + value, 0) / changePcts.length;
      const realizedDirection = classifyRealizedDirection(avgChangePct);
      const forecastDirection = String(forecast.direction);
      const isHit = isForecastHit(forecastDirection, realizedDirection);

      if (isHit) {
        hitCount += 1;
      }

      details.push({
        theme,
        direction: forecastDirection,
        realizedDirection,
        realizedChangePct: Number(avgChangePct.toFixed(6)),
        isHit,
      });
    }

    // 回填 — 并行 N 个 update（每个 forecast 的 data 不同，updateMany 不适用）
    await Promise.all(
      details.map((detail) => {
        const forecast = pendingForecasts.find(
          (row: { theme: string }) => String(row.theme) === detail.theme,
        );
        if (!forecast) {
          return Promise.resolve();
        }
        return prisma.themeForecast.update({
          where: { id: String(forecast.id) },
          data: {
            realizedDirection: detail.realizedDirection,
            realizedChangePct: new Prisma.Decimal(detail.realizedChangePct.toFixed(6)),
            isReconciled: true,
          },
        });
      }),
    );

    const reconciledCount = details.length;
    const hitRate = reconciledCount > 0 ? Number((hitCount / reconciledCount).toFixed(4)) : 0;

    return {
      reconciledCount,
      hitCount,
      hitRate,
      details,
    };
  }
}
