import { Prisma } from '@prisma/client';
import { hasPrismaDelegateMethod } from './prisma-utils.js';
import { clamp, toNumber } from '../lib/number-utils.js';

/**
 * 主题/资产级预测：生成 + T+5 对账
 *
 * 生成（ThemeForecastService）：基于因果信号聚合 + 预期差，输出"白银未来5日可能上涨"的主题级预测。
 *   数据来源：CausalSignalCandidate、ExpectationGapSnapshot、StockExposureFact。
 *
 * 对账（ThemeForecastReconciliationService）：在预测发出 5 个交易日后回填实际涨跌，
 *   用于评估准确率 + 喂给集团自提升闭环。
 */

// ============================================================
// 生成：ThemeForecastService
// ============================================================

export interface IThemeForecastInput {
  readonly traceId: string;
  readonly asOf: Date;
  readonly clusterKey: string;
  readonly horizon?: number;  // 默认5
}

export type ThemeDirection = 'bullish' | 'bearish' | 'neutral';

export interface IThemeForecastItem {
  readonly theme: string;
  readonly direction: ThemeDirection;
  readonly probability: number;
  readonly horizon: number;
  readonly signalStrength: number;
  readonly expectationGap: number;
  readonly relatedSymbols: readonly string[];
  readonly evidenceChain: {
    readonly signalCount: number;
    readonly positiveRatio: number;
    readonly avgConfidence: number;
    readonly newsCount: number;
    readonly topBusinessVariables: readonly string[];
    readonly weakSignal: boolean;
  };
  readonly reasons: readonly string[];
}

export interface IThemeForecastResult {
  readonly forecastCount: number;
  readonly bullishCount: number;
  readonly bearishCount: number;
  readonly topForecasts: readonly IThemeForecastItem[];
}

const FORECAST_HORIZON_DEFAULT = 5;
const BULLISH_POSITIVE_RATIO_THRESHOLD = 0.60;
const BEARISH_POSITIVE_RATIO_THRESHOLD = 0.40;
const SIGNAL_STRENGTH_NORMALIZATION = 25.0;  // top主题原始强度约22（25信号×0.88置信），归一化后~0.88

// 泛化词黑名单：这些词不是有意义的资产/主题，不应生成预测
const GENERIC_KEYWORD_BLACKLIST = new Set([
  '行业', '产业', '产业链', '项目', '公司', '建设', '发展', '投资', '市场', '企业',
  '业务', '产品', '服务', '板块', '概念', '主题', '领域', '方向', '趋势',
]);

const hasDelegate = (prisma: any, delegateName: string, methodName: string): boolean => {
  return hasPrismaDelegateMethod(prisma, delegateName, methodName);
};

interface IAggregatedTheme {
  readonly theme: string;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly totalCount: number;
  readonly confidenceSum: number;
  readonly newsIds: Set<string>;
  readonly businessVariables: Map<string, number>;
}

const aggregateCausalSignalsByTheme = (
  signals: readonly any[],
): ReadonlyMap<string, IAggregatedTheme> => {
  const result = new Map<string, IAggregatedTheme>();

  for (const signal of signals) {
    const theme = String(signal.assetOrThemeKeyword ?? '').trim();
    if (!theme || GENERIC_KEYWORD_BLACKLIST.has(theme)) {
      continue;
    }
    const direction = String(signal.direction ?? 'neutral');
    const confidence = Number(signal.confidence ?? 0.5);
    const newsId = String(signal.newsId ?? '');
    const businessVariable = String(signal.businessVariable ?? 'unknown');

    const existing = result.get(theme);
    if (existing) {
      const positiveCount = existing.positiveCount + (direction === 'positive' ? 1 : 0);
      const negativeCount = existing.negativeCount + (direction === 'negative' ? 1 : 0);
      const businessVariables = new Map(existing.businessVariables);
      businessVariables.set(
        businessVariable,
        (businessVariables.get(businessVariable) ?? 0) + 1,
      );
      result.set(theme, {
        ...existing,
        positiveCount,
        negativeCount,
        totalCount: existing.totalCount + 1,
        confidenceSum: existing.confidenceSum + confidence,
        newsIds: new Set([...existing.newsIds, newsId]),
        businessVariables,
      });
    }
    else {
      const newsIds = new Set<string>([newsId]);
      const businessVariables = new Map<string, number>([[businessVariable, 1]]);
      result.set(theme, {
        theme,
        positiveCount: direction === 'positive' ? 1 : 0,
        negativeCount: direction === 'negative' ? 1 : 0,
        totalCount: 1,
        confidenceSum: confidence,
        newsIds,
        businessVariables,
      });
    }
  }

  return result;
};

const determineDirection = (positiveRatio: number): ThemeDirection => {
  if (positiveRatio >= BULLISH_POSITIVE_RATIO_THRESHOLD) {
    return 'bullish';
  }
  if (positiveRatio < BEARISH_POSITIVE_RATIO_THRESHOLD) {
    return 'bearish';
  }
  return 'neutral';
};

/**
 * probability = signalStrength × 0.6 + expectationGap × 0.4
 * 两者都归一化到 0-1，最终 clamp 到 0-1。
 */
const calculateProbability = (
  signalStrength: number,
  expectationGap: number,
  direction: ThemeDirection,
): number => {
  // bullish 时正向叠加，bearish 时取反向概率
  const directionalGap = direction === 'bearish' ? Math.max(0, -expectationGap) : Math.max(0, expectationGap);
  const raw = signalStrength * 0.6 + directionalGap * 0.4;
  return Number(clamp(raw, 0, 1).toFixed(4));
};

export class ThemeForecastService {
  /**
   * 生成主题级预测并落库。
   */
  public async generate(prisma: any, input: IThemeForecastInput): Promise<IThemeForecastResult> {
    const horizon = input.horizon ?? FORECAST_HORIZON_DEFAULT;

    if (!hasDelegate(prisma, 'causalSignalCandidate', 'findMany')) {
      return { forecastCount: 0, bullishCount: 0, bearishCount: 0, topForecasts: [] };
    }

    // 1. 读取本 trace 的 CausalSignalCandidate
    const signals = await prisma.causalSignalCandidate.findMany({
      where: {
        traceId: input.traceId,
        clusterKey: input.clusterKey,
        status: 'candidate',
      },
    });
    if (signals.length === 0) {
      return { forecastCount: 0, bullishCount: 0, bearishCount: 0, topForecasts: [] };
    }

    // 2. 按 theme 聚合
    const themes = aggregateCausalSignalsByTheme(signals);

    // 3. 读取 ExpectationGapSnapshot（模块2产出）
    const gapByKeyword = new Map<string, { expectationGap: number; weakSignal: boolean }>();
    if (hasDelegate(prisma, 'expectationGapSnapshot', 'findMany')) {
      const gapSnapshots = await prisma.expectationGapSnapshot.findMany({
        where: { traceId: input.traceId, clusterKey: input.clusterKey },
        select: { keyword: true, expectationGap: true, isWeakSignal: true },
      });
      for (const gap of gapSnapshots) {
        gapByKeyword.set(String(gap.keyword), {
          expectationGap: Number(gap.expectationGap),
          weakSignal: Boolean(gap.isWeakSignal),
        });
      }
    }

    // 4. 读取 StockExposureFact 关联股票
    const themeKeywords = [...themes.keys()];
    const exposureByKeyword = new Map<string, string[]>();
    if (themeKeywords.length > 0 && hasDelegate(prisma, 'stockExposureFact', 'findMany')) {
      const facts = await prisma.stockExposureFact.findMany({
        where: {
          clusterKey: input.clusterKey,
          status: 'active',
          keyword: { in: themeKeywords },
          validFrom: { lte: input.asOf },
          OR: [{ validTo: null }, { validTo: { gte: input.asOf } }],
        },
        select: { symbol: true, keyword: true },
      });
      for (const fact of facts) {
        const keyword = String(fact.keyword);
        const list = exposureByKeyword.get(keyword) ?? [];
        list.push(String(fact.symbol));
        exposureByKeyword.set(keyword, list);
      }
    }

    // 5. 生成预测
    const forecasts: IThemeForecastItem[] = [];
    for (const [theme, agg] of themes) {
      const positiveRatio = agg.totalCount > 0 ? agg.positiveCount / agg.totalCount : 0;
      const avgConfidence = agg.totalCount > 0 ? agg.confidenceSum / agg.totalCount : 0.5;
      const direction = determineDirection(positiveRatio);
      const signalStrength = Number(clamp(
        (agg.totalCount * avgConfidence) / SIGNAL_STRENGTH_NORMALIZATION,
        0,
        1,
      ).toFixed(4));

      const gapInfo = gapByKeyword.get(theme);
      const expectationGap = gapInfo?.expectationGap ?? 0;
      const weakSignal = gapInfo?.weakSignal ?? false;

      const probability = calculateProbability(signalStrength, expectationGap, direction);
      const relatedSymbols = [...new Set(exposureByKeyword.get(theme) ?? [])].slice(0, 10);

      const topBusinessVariables = [...agg.businessVariables.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 5)
        .map(([variable]) => variable);

      const reasons: string[] = [
        `因果信号聚合：${agg.totalCount} 条信号（正 ${agg.positiveCount} / 负 ${agg.negativeCount}），正向占比 ${(positiveRatio * 100).toFixed(1)}%`,
        `平均置信度 ${avgConfidence.toFixed(4)}，信号强度 ${signalStrength.toFixed(4)}`,
        `预期差 ${expectationGap.toFixed(4)}${weakSignal ? '（弱信号：市场尚未充分反映）' : ''}`,
        `预测方向 ${direction}，未来 ${horizon} 交易日上涨概率 ${(probability * 100).toFixed(1)}%`,
        `关联股票 ${relatedSymbols.length} 只：${relatedSymbols.slice(0, 5).join(', ')}${relatedSymbols.length > 5 ? '...' : ''}`,
      ];

      forecasts.push({
        theme,
        direction,
        probability,
        horizon,
        signalStrength,
        expectationGap,
        relatedSymbols,
        evidenceChain: {
          signalCount: agg.totalCount,
          positiveRatio: Number(positiveRatio.toFixed(4)),
          avgConfidence: Number(avgConfidence.toFixed(4)),
          newsCount: agg.newsIds.size,
          topBusinessVariables,
          weakSignal,
        },
        reasons,
      });
    }

    // 按 probability 降序
    forecasts.sort((left, right) => right.probability - left.probability);

    // 6. 落库
    if (forecasts.length > 0 && hasDelegate(prisma, 'themeForecast', 'createMany')) {
      const rows = forecasts.map(item => ({
        traceId: input.traceId,
        asOf: input.asOf,
        clusterKey: input.clusterKey,
        theme: item.theme,
        direction: item.direction,
        probability: new Prisma.Decimal(item.probability.toFixed(4)),
        horizon: item.horizon,
        signalStrength: new Prisma.Decimal(item.signalStrength.toFixed(4)),
        expectationGap: new Prisma.Decimal(item.expectationGap.toFixed(4)),
        relatedSymbols: [...item.relatedSymbols],
        evidenceChain: item.evidenceChain as unknown as Prisma.InputJsonValue,
        reasons: [...item.reasons],
      }));
      await prisma.themeForecast.createMany({ data: rows, skipDuplicates: true });
    }

    return {
      forecastCount: forecasts.length,
      bullishCount: forecasts.filter(item => item.direction === 'bullish').length,
      bearishCount: forecasts.filter(item => item.direction === 'bearish').length,
      topForecasts: forecasts.slice(0, 20),
    };
  }
}

// ============================================================
// 对账：ThemeForecastReconciliationService
// ============================================================

export interface IThemeForecastReconciliationInput {
  readonly asOf: Date;
  readonly clusterKey: string;
}

export interface IThemeForecastReconciliationDetail {
  readonly forecastId: string;
  readonly theme: string;
  readonly direction: string;
  readonly realizedDirection: string | null;
  readonly realizedChangePct: number | null;
  readonly isHit: boolean;
  /** 对账原因；no_data 表示无关联股票行情可对账（已收口为 isReconciled=true，避免孤儿）。 */
  readonly reason?: string;
}

export interface IThemeForecastReconciliationResult {
  readonly reconciledCount: number;
  readonly hitCount: number;  // 方向命中数
  readonly hitRate: number;
  readonly details: readonly IThemeForecastReconciliationDetail[];
}

const FLAT_CHANGE_THRESHOLD = 0.01;  // 涨跌<1%视为平
const RECONCILIATION_LOOKBACK_DAYS = 15;  // 日历日，覆盖约10个交易日

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

    // 对每个 forecast，构建 {forecastId, updateData, detail}：
    //   - 直接用 forecast.id 关联（避免按 theme 文本反查导致的同主题错配）；
    //   - 无行情数据时不再 continue 孤儿，而是标记 isReconciled=true + realized*=null + reason='no_data'。
    const updates: Array<{
      readonly forecastId: string;
      readonly data: Prisma.ThemeForecastUpdateInput;
      readonly detail: IThemeForecastReconciliationDetail;
    }> = [];

    for (const forecast of pendingForecasts) {
      const forecastId = String(forecast.id);
      const theme = String(forecast.theme);
      const forecastDirection = String(forecast.direction);
      const forecastAsOf = forecastAsOfById.get(forecastId);
      if (!forecastAsOf) {
        continue;
      }
      const symbols = symbolByTheme.get(theme) ?? [];
      const stockIds = symbols
        .map(s => stockIdBySymbol.get(s))
        .filter((id): id is string => Boolean(id));

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
        // 无可对账行情数据：收口为 isReconciled=true（避免成为孤儿被永久留在 lookback 外），
        // realized 字段置 null，详情标记 reason='no_data'。
        updates.push({
          forecastId,
          data: {
            realizedDirection: null,
            realizedChangePct: null,
            isReconciled: true,
          },
          detail: {
            forecastId,
            theme,
            direction: forecastDirection,
            realizedDirection: null,
            realizedChangePct: null,
            isHit: false,
            reason: 'no_data',
          },
        });
        continue;
      }

      const avgChangePct = changePcts.reduce((sum, value) => sum + value, 0) / changePcts.length;
      const realizedDirection = classifyRealizedDirection(avgChangePct);
      const isHit = isForecastHit(forecastDirection, realizedDirection);

      updates.push({
        forecastId,
        data: {
          realizedDirection,
          realizedChangePct: new Prisma.Decimal(avgChangePct.toFixed(6)),
          isReconciled: true,
        },
        detail: {
          forecastId,
          theme,
          direction: forecastDirection,
          realizedDirection,
          realizedChangePct: Number(avgChangePct.toFixed(6)),
          isHit,
        },
      });
    }

    // 回填 —— 直接用 forecastId，避免按 theme 文本反查（修复同主题多条错配）
    await Promise.all(
      updates.map(update => prisma.themeForecast.update({
        where: { id: update.forecastId },
        data: update.data,
      })),
    );

    const reconciledCount = updates.length;
    const hitCount = updates.filter(update => update.detail.isHit).length;
    // no_data不计入分母：无行情不是预测错，避免稀释真实命中率。
    const evaluableCount = updates.filter(update => update.detail.reason !== 'no_data').length;
    const hitRate = evaluableCount > 0 ? Number((hitCount / evaluableCount).toFixed(4)) : 0;

    return {
      reconciledCount,
      hitCount,
      hitRate,
      details: updates.map(update => update.detail),
    };
  }
}