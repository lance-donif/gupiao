import type {
  IStrategyExperimentCandidate,
  IStrategyExperimentConfig,
  IStrategyExperimentFeatureInput,
  IStrategyExperimentSelectionDiagnostics,
} from './strategy-experiment-core.js';
import crypto from 'node:crypto';

import { Prisma } from '@prisma/client';
import { FactSnapshotService } from './limitup-evidence-initialization.js';
import {
  defaultStrategyExperimentConfig,
  normalizeStrategyExperimentConfig,
  scoreStrategyFeature,
  selectStrategyRecommendations,
} from './strategy-experiment-core.js';
import { normalizeSelectionSignalType } from './temp-stock-recommendation-service.js';
import { calculateMarketSignalScore } from './scoring-contribution-engine.js';

export interface IStrategyDefinitionRow {
  readonly id: string;
  readonly clusterKey: string;
  readonly name: string;
  readonly description: string | null;
  readonly enabled: boolean;
  readonly configJson: unknown;
  readonly deletedAt?: Date | string | null;
  readonly createdAt?: Date | string | null;
  readonly updatedAt?: Date | string | null;
}

export interface IStrategyRunSummary {
  readonly strategyId: string;
  readonly strategyName: string;
  readonly status: 'SUCCESS' | 'FAILED';
  readonly recommendationCount: number;
  readonly selectedSignals: Record<string, number>;
  readonly errorMessage: string | null;
}

export interface IStrategyExperimentExecutionResult {
  readonly strategyCount: number;
  readonly enabledStrategyCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly recommendationCount: number;
  readonly runs: readonly IStrategyRunSummary[];
}

const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toDate = (value: unknown): Date => {
  if (value instanceof Date) {
    return value;
  }
  return new Date(String(value));
};

const readScoreBreakdownNumber = (
  value: unknown,
  keys: readonly string[],
  fallback = 0,
): number => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallback;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const direct = toNumber(record[key], Number.NaN);
    if (Number.isFinite(direct)) {
      return direct;
    }
  }
  const rawScores = record.rawScores;
  if (rawScores && typeof rawScores === 'object' && !Array.isArray(rawScores)) {
    const rawRecord = rawScores as Record<string, unknown>;
    for (const key of keys) {
      const direct = toNumber(rawRecord[key], Number.NaN);
      if (Number.isFinite(direct)) {
        return direct;
      }
    }
  }
  return fallback;
};

const stableFingerprint = (input: {
  readonly strategyId: string;
  readonly asOf: Date;
  readonly clusterKey: string;
  readonly config: unknown;
}): string => {
  return crypto.createHash('sha256').update(JSON.stringify({
    strategyId: input.strategyId,
    asOf: input.asOf.toISOString(),
    clusterKey: input.clusterKey,
    config: input.config,
  })).digest('hex').slice(0, 32);
};

const defaultMarketSignal = (): Record<string, unknown> => ({
  score: 0,
  momentum5dPct: null,
  momentum20dPct: null,
  volumeRatio20d: null,
  breakout20d: false,
  volatilityCompression: false,
  recentWeekGainExceeded: false,
});

const CHINESE_TEXT_PATTERN = /[\u3400-\u9FFF]/u;

const stockInfoExposureSources = new Set([
  'tickflow_sw_universe',
  'akshare_industry_board_em',
  'akshare_concept_board_em',
  'akshare_individual_info_em',
  'manual_verified',
  'test_exposure',
]);

const stockInfoExposureRank = (exposure: any): number => {
  const source = String(exposure.source ?? '');
  const exposureType = String(exposure.exposureType ?? '');
  const taxonomyLevel = String(exposure.taxonomyLevel ?? '').toUpperCase();
  if (source === 'historical_limitup_news' || exposureType === 'movement_evidence') {
    return -1;
  }
  if (!source && !exposureType) {
    return 1;
  }
  if (!stockInfoExposureSources.has(source)) {
    return -1;
  }
  if (source === 'tickflow_sw_universe') {
    if (taxonomyLevel === 'SW3') {
      return 100;
    }
    if (taxonomyLevel === 'SW2') {
      return 90;
    }
    if (taxonomyLevel === 'SW1') {
      return 80;
    }
    return 70;
  }
  if (source === 'akshare_industry_board_em') {
    return 75;
  }
  if (source === 'akshare_concept_board_em') {
    return 65;
  }
  if (source === 'akshare_individual_info_em') {
    return 55;
  }
  return 40;
};

export class StrategyExperimentRunner {
  public async ensureDefaultStrategy(prisma: any, clusterKey: string): Promise<readonly IStrategyDefinitionRow[]> {
    if (!prisma.strategyDefinition?.findMany || !prisma.strategyDefinition?.create) {
      return [];
    }

    const existing = await prisma.strategyDefinition.findMany({
      where: { clusterKey, deletedAt: null },
      orderBy: [{ createdAt: 'asc' }],
    });

    if (existing.length > 0) {
      return existing;
    }

    await prisma.strategyDefinition.create({
      data: {
        clusterKey,
        name: '默认策略',
        description: '共享事实上的基线策略',
        enabled: true,
        configJson: defaultStrategyExperimentConfig(),
      },
    });

    return prisma.strategyDefinition.findMany({
      where: { clusterKey, deletedAt: null },
      orderBy: [{ createdAt: 'asc' }],
    });
  }

  public async runEnabledStrategies(
    prisma: any,
    input: {
      readonly traceId: string;
      readonly asOf: Date;
      readonly clusterKey: string;
    },
  ): Promise<IStrategyExperimentExecutionResult> {
    const strategyDefinitions = await this.ensureDefaultStrategy(prisma, input.clusterKey);
    const enabledStrategies = strategyDefinitions.filter(strategy => Boolean(strategy.enabled) && !strategy.deletedAt);

    if (enabledStrategies.length === 0) {
      return {
        strategyCount: strategyDefinitions.length,
        enabledStrategyCount: 0,
        successCount: 0,
        failureCount: 0,
        recommendationCount: 0,
        runs: [],
      };
    }

    await new FactSnapshotService().ensure(prisma, {
      traceId: input.traceId,
      asOf: input.asOf,
      clusterKey: input.clusterKey,
    });
    const features = await this.loadFeatures(prisma, input);
    if (features.length === 0) {
      throw new Error('共享特征为空，无法执行多策略推荐');
    }

    const runs: IStrategyRunSummary[] = [];
    let recommendationCount = 0;

    for (const strategy of enabledStrategies) {
      const startedAt = Date.now();
      try {
        const config = normalizeStrategyExperimentConfig(strategy.configJson);
        const candidates = features.map((feature) => {
          let updatedFeature = feature;
          if (feature.candles && feature.candles.length > 0) {
            const computed = calculateMarketSignalScore(feature.candles, config);
            updatedFeature = {
              ...feature,
              marketSignalScore: computed.score,
              marketSignal: computed as any,
            };
          }
          return scoreStrategyFeature(updatedFeature, config);
        });
        const selection = selectStrategyRecommendations(candidates, config);
        const run = await this.persistStrategyRunSuccess(prisma, {
          strategy,
          traceId: input.traceId,
          asOf: input.asOf,
          clusterKey: input.clusterKey,
          config,
          candidates,
          selected: selection.recommendations,
          diagnostics: selection.diagnostics,
          elapsedMs: Date.now() - startedAt,
        });
        recommendationCount += selection.recommendations.length;
        runs.push(run);
      }
      catch (error: any) {
        const failureMessage = error instanceof Error ? error.message : String(error);
        await this.persistStrategyRunFailure(prisma, {
          strategy,
          traceId: input.traceId,
          asOf: input.asOf,
          clusterKey: input.clusterKey,
          errorMessage: failureMessage,
          rawConfigSnapshot: strategy.configJson,
          elapsedMs: Date.now() - startedAt,
        });
        runs.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          status: 'FAILED',
          recommendationCount: 0,
          selectedSignals: {},
          errorMessage: failureMessage,
        });
      }
    }

    const successCount = runs.filter(run => run.status === 'SUCCESS').length;
    const failureCount = runs.length - successCount;
    if (successCount === 0) {
      throw new Error('所有启用策略都未成功，已停止多策略输出');
    }

    return {
      strategyCount: strategyDefinitions.length,
      enabledStrategyCount: enabledStrategies.length,
      successCount,
      failureCount,
      recommendationCount,
      runs,
    };
  }

  private async loadFeatures(
    prisma: any,
    input: {
      readonly traceId: string;
      readonly asOf: Date;
      readonly clusterKey: string;
    },
  ): Promise<readonly IStrategyExperimentFeatureInput[]> {
    const recommendationFeatures = await this.loadRecommendationSnapshotFeatures(prisma, input);
    if (recommendationFeatures.length > 0) {
      return recommendationFeatures;
    }

    if (!prisma.stockFeatureSnapshot?.findMany) {
      return [];
    }

    const featureRows = await prisma.stockFeatureSnapshot.findMany({
      where: { traceId: input.traceId },
    }) as any[];
    if (featureRows.length === 0) {
      return [];
    }

    const symbols: string[] = [...new Set(featureRows.map((row: any) => String(row.symbol)))];
    const [stockInfoMap, signalMap, marketSignalMap, priceMap] = await Promise.all([
      this.loadStockInfo(prisma, input.clusterKey, input.asOf, symbols),
      this.loadContributionSignals(prisma, input.traceId, symbols),
      this.loadMarketSignals(prisma, input.traceId, input.clusterKey, input.asOf, symbols),
      this.loadLatestPrices(prisma, input.clusterKey, input.asOf, symbols),
    ]);

    return featureRows.map((row: any) => {
      const symbol = String(row.symbol);
      const stockInfo = stockInfoMap.get(symbol) ?? {
        stockName: `股票-${symbol}`,
        industry: '未归类',
      };
      const marketSignal = marketSignalMap.get(symbol) ?? defaultMarketSignal();
      const priceInfo = priceMap.get(symbol) ?? null;
      return {
        symbol,
        stockName: stockInfo.stockName,
        industry: stockInfo.industry,
        newsFrequencyScore: toNumber(row.newsFrequencyScore),
        relationConfidenceScore: toNumber(row.relationConfidenceScore),
        boardMatchScore: toNumber(row.boardMatchScore),
        weakSignalBonus: toNumber(row.weakSignalBonus),
        marketSignalScore: toNumber(marketSignal.score),
        marketSignal,
        reasons: Array.isArray(row.reasons) ? row.reasons.map(String) : [],
        matchedSignals: signalMap.get(symbol) ?? [],
        latestClose: priceInfo?.close ?? null,
        baseTradingDay: priceInfo?.tradingDay ?? input.asOf,
        basePrice: priceInfo?.close ?? 0,
        currentTradingDay: priceInfo?.tradingDay ?? null,
        currentPrice: priceInfo?.close ?? null,
        returnPct: priceInfo?.close == null ? null : 0,
        returnStatus: priceInfo?.close == null ? 'NO_BASE_PRICE' : 'RECORDED',
        candles: (marketSignal as any).candles ?? [],
      } satisfies IStrategyExperimentFeatureInput;
    });
  }

  private async loadRecommendationSnapshotFeatures(
    prisma: any,
    input: {
      readonly traceId: string;
      readonly asOf: Date;
      readonly clusterKey: string;
    },
  ): Promise<readonly IStrategyExperimentFeatureInput[]> {
    if (!prisma.recommendationSnapshot?.findMany) {
      return [];
    }
    const snapshotRows = await prisma.recommendationSnapshot.findMany({
      where: {
        traceId: input.traceId,
        clusterKey: input.clusterKey,
      },
      orderBy: [{ rank: 'asc' }],
    }) as any[];
    if (snapshotRows.length === 0) {
      return [];
    }

    const symbols: string[] = [...new Set(snapshotRows.map((row: any) => String(row.symbol)))];
    const [signalMap, marketSignalMap, priceMap] = await Promise.all([
      this.loadContributionSignals(prisma, input.traceId, symbols),
      this.loadMarketSignals(prisma, input.traceId, input.clusterKey, input.asOf, symbols),
      this.loadLatestPrices(prisma, input.clusterKey, input.asOf, symbols),
    ]);

    return snapshotRows.map((row: any) => {
      const symbol = String(row.symbol);
      const scoreBreakdown = row.scoreBreakdown;
      const priceInfo = priceMap.get(symbol) ?? null;
      const marketSignal = marketSignalMap.get(symbol) ?? defaultMarketSignal();
      const rawSignal = scoreBreakdown && typeof scoreBreakdown === 'object' && !Array.isArray(scoreBreakdown)
        ? (scoreBreakdown.selectionSignalType ?? scoreBreakdown.primarySignalType ?? row.industry)
        : row.industry;
      const fallbackSignal = String(rawSignal ?? row.industry ?? '未归类');
      return {
        symbol,
        stockName: String(row.stockName ?? `股票-${symbol}`),
        industry: String(row.industry ?? '未归类'),
        newsFrequencyScore: readScoreBreakdownNumber(scoreBreakdown, ['evidenceScore', 'evidence']),
        relationConfidenceScore: readScoreBreakdownNumber(scoreBreakdown, ['graphScore', 'graph']),
        boardMatchScore: readScoreBreakdownNumber(scoreBreakdown, ['exposurePrecisionScore', 'exposure']),
        weakSignalBonus: 0,
        marketSignalScore: readScoreBreakdownNumber(scoreBreakdown, ['marketSignalScore', 'market']),
        marketSignal,
        reasons: Array.isArray(row.reasons) ? row.reasons.map(String) : [],
        matchedSignals: signalMap.get(symbol) ?? [{ keyword: fallbackSignal, score: readScoreBreakdownNumber(scoreBreakdown, ['evidenceScore', 'evidence']) }],
        latestClose: priceInfo?.close ?? null,
        baseTradingDay: priceInfo?.tradingDay ?? input.asOf,
        basePrice: priceInfo?.close ?? 0,
        currentTradingDay: priceInfo?.tradingDay ?? null,
        currentPrice: priceInfo?.close ?? null,
        returnPct: priceInfo?.close == null ? null : 0,
        returnStatus: priceInfo?.close == null ? 'NO_BASE_PRICE' : 'RECORDED',
        candles: (marketSignal as any).candles ?? [],
      } satisfies IStrategyExperimentFeatureInput;
    });
  }

  private async loadStockInfo(
    prisma: any,
    clusterKey: string,
    asOf: Date,
    symbols: readonly string[],
  ): Promise<Map<string, { stockName: string; industry: string }>> {
    const map = new Map<string, { stockName: string; industry: string }>();
    if (!prisma.stockExposureFact?.findMany || symbols.length === 0) {
      return map;
    }

    const rows = await prisma.stockExposureFact.findMany({
      where: {
        clusterKey,
        status: 'active',
        symbol: { in: symbols },
        validFrom: { lte: asOf },
        OR: [
          { validTo: null },
          { validTo: { gte: asOf } },
        ],
      },
      orderBy: [
        { taxonomyLevel: 'desc' },
        { confidence: 'desc' },
      ],
    });

    const stockInfoRows = rows
      .filter((row: any) => stockInfoExposureRank(row) >= 0)
      .sort((left: any, right: any) => {
        const leftName = String(left.stockName ?? '');
        const rightName = String(right.stockName ?? '');
        const leftHasChineseName = CHINESE_TEXT_PATTERN.test(leftName) ? 1 : 0;
        const rightHasChineseName = CHINESE_TEXT_PATTERN.test(rightName) ? 1 : 0;
        return rightHasChineseName - leftHasChineseName
          || stockInfoExposureRank(right) - stockInfoExposureRank(left)
          || Number(right.confidence ?? 0) - Number(left.confidence ?? 0)
          || String(left.keyword ?? '').localeCompare(String(right.keyword ?? ''));
      });

    for (const row of stockInfoRows) {
      const symbol = String(row.symbol);
      if (!map.has(symbol)) {
        map.set(symbol, {
          stockName: String(row.stockName ?? `股票-${symbol}`),
          industry: String(row.keyword ?? '未归类'),
        });
      }
    }

    return map;
  }

  private async loadContributionSignals(
    prisma: any,
    traceId: string,
    symbols: readonly string[],
  ): Promise<Map<string, readonly { keyword: string; score: number }[]>> {
    const map = new Map<string, readonly { keyword: string; score: number }[]>();
    if (!prisma.evidenceContribution?.findMany || symbols.length === 0) {
      return map;
    }

    const rows = await prisma.evidenceContribution.findMany({
      where: {
        traceId,
        symbol: { in: [...symbols] },
      },
    }) as any[];

    const keywordScoreBySymbol = new Map<string, Map<string, number>>();
    for (const row of rows) {
      const symbol = String(row.symbol);
      const keyword = String(row.matchedExposureKeyword ?? row.keyword);
      const current = keywordScoreBySymbol.get(symbol) ?? new Map<string, number>();
      current.set(keyword, (current.get(keyword) ?? 0) + toNumber(row.finalContribScore));
      keywordScoreBySymbol.set(symbol, current);
    }

    for (const [symbol, keywordScores] of keywordScoreBySymbol.entries()) {
      const signals = [...keywordScores.entries()]
        .map(([keyword, score]) => ({ keyword, score }))
        .sort((left, right) => right.score - left.score || left.keyword.localeCompare(right.keyword));
      map.set(symbol, signals);
    }

    return map;
  }

  private async loadMarketSignals(
    prisma: any,
    traceId: string,
    clusterKey: string,
    asOf: Date,
    symbols: readonly string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const map = new Map<string, Record<string, unknown>>();
    if (symbols.length === 0) {
      return map;
    }

    const stocks = await prisma.stock.findMany({
      where: {
        clusterKey,
        symbol: { in: [...symbols] },
      },
      select: {
        id: true,
        symbol: true,
      },
    }) as any[];

    const stockIdToSymbol = new Map<string, string>(
      stocks.map((stock: any) => [String(stock.id), String(stock.symbol)]),
    );

    const calendarDays = 120 * 1.6 + 15;
    const marketWindowStart = new Date(asOf.getTime() - calendarDays * 24 * 60 * 60 * 1000);
    const candles = await prisma.candle.findMany({
      where: {
        stockId: { in: [...stockIdToSymbol.keys()] },
        tradingDay: {
          lte: asOf,
          gte: marketWindowStart,
        },
      },
      orderBy: [
        { stockId: 'asc' },
        { tradingDay: 'desc' },
      ],
    }) as any[];

    const candlesBySymbol = new Map<string, any[]>();
    for (const candle of candles) {
      const symbol = stockIdToSymbol.get(String(candle.stockId));
      if (symbol) {
        const list = candlesBySymbol.get(symbol) ?? [];
        if (list.length < 120) {
          list.push(candle);
          candlesBySymbol.set(symbol, list);
        }
      }
    }

    const rows = prisma.marketSignalSnapshot?.findMany
      ? (await prisma.marketSignalSnapshot.findMany({
          where: {
            traceId,
            symbol: { in: [...symbols] },
          },
        }) as any[])
      : [];

    const foundSymbols = new Set(rows.map((row: any) => String(row.symbol)));
    if (foundSymbols.size < symbols.length && prisma.marketSignalSnapshot?.findMany) {
      const reusableRows = await prisma.marketSignalSnapshot.findMany({
        where: {
          clusterKey,
          asOf,
          symbol: { in: symbols.filter(symbol => !foundSymbols.has(symbol)) },
        },
        orderBy: { createdAt: 'desc' },
      }) as any[];
      const seen = new Set<string>();
      for (const row of reusableRows) {
        const symbol = String(row.symbol);
        if (seen.has(symbol)) {
          continue;
        }
        rows.push(row);
        seen.add(symbol);
      }
    }

    for (const row of rows) {
      const symbol = String(row.symbol);
      map.set(symbol, {
        score: toNumber(row.score),
        momentum5dPct: row.momentum5dPct === null || row.momentum5dPct === undefined ? null : toNumber(row.momentum5dPct),
        momentum20dPct: row.momentum20dPct === null || row.momentum20dPct === undefined ? null : toNumber(row.momentum20dPct),
        volumeRatio20d: row.volumeRatio20d === null || row.volumeRatio20d === undefined ? null : toNumber(row.volumeRatio20d),
        breakout20d: row.breakout20d === true,
        volatilityCompression: row.volatilityCompression === true,
        recentWeekGainExceeded: row.recentWeekGainExceeded === true,
        candles: candlesBySymbol.get(symbol) ?? [],
      });
    }

    // fallback for symbols that do not even have marketSignalSnapshot in DB
    for (const symbol of symbols) {
      if (!map.has(symbol)) {
        map.set(symbol, {
          score: 0,
          momentum5dPct: null,
          momentum20dPct: null,
          volumeRatio20d: null,
          breakout20d: false,
          volatilityCompression: false,
          recentWeekGainExceeded: false,
          candles: candlesBySymbol.get(symbol) ?? [],
        });
      }
    }

    return map;
  }

  private async loadLatestPrices(
    prisma: any,
    clusterKey: string,
    asOf: Date,
    symbols: readonly string[],
  ): Promise<Map<string, { close: number; tradingDay: Date }>> {
    const map = new Map<string, { close: number; tradingDay: Date }>();
    if (!prisma.stock?.findMany || !prisma.candle?.findMany || symbols.length === 0) {
      return map;
    }

    const stocks = await prisma.stock.findMany({
      where: {
        clusterKey,
        symbol: { in: [...symbols] },
      },
      select: {
        id: true,
        symbol: true,
      },
    }) as any[];

    if (stocks.length === 0) {
      return map;
    }

    const stockById = new Map<string, string>(stocks.map((stock: any) => [String(stock.id), String(stock.symbol)]));
    const candles = await prisma.candle.findMany({
      where: {
        stockId: { in: stocks.map((stock: any) => String(stock.id)) },
        tradingDay: { lte: asOf },
      },
      orderBy: [
        { stockId: 'asc' },
        { tradingDay: 'asc' },
      ],
    }) as any[];

    const sortedCandles = [...candles].sort((left: any, right: any) => {
      const stockCompare = String(left.stockId).localeCompare(String(right.stockId));
      if (stockCompare !== 0) {
        return stockCompare;
      }
      return toDate(left.tradingDay).getTime() - toDate(right.tradingDay).getTime();
    });

    for (const candle of sortedCandles) {
      const stockId = String(candle.stockId);
      const symbol = stockById.get(stockId);
      if (!symbol) {
        continue;
      }
      map.set(symbol, {
        close: toNumber(candle.close),
        tradingDay: toDate(candle.tradingDay),
      });
    }

    return map;
  }

  private async persistStrategyRunSuccess(
    prisma: any,
    input: {
      readonly strategy: IStrategyDefinitionRow;
      readonly traceId: string;
      readonly asOf: Date;
      readonly clusterKey: string;
      readonly config: IStrategyExperimentConfig;
      readonly candidates: readonly IStrategyExperimentCandidate[];
      readonly selected: readonly IStrategyExperimentCandidate[];
      readonly diagnostics: IStrategyExperimentSelectionDiagnostics;
      readonly elapsedMs: number;
    },
  ): Promise<IStrategyRunSummary> {
    if (!prisma.strategyRun?.findFirst || !prisma.strategyRun?.create || !prisma.strategyRun?.update || !prisma.strategyRecommendationEvent?.createMany) {
      throw new Error('strategy tables are unavailable');
    }

    const fingerprint = stableFingerprint({
      strategyId: input.strategy.id,
      asOf: input.asOf,
      clusterKey: input.clusterKey,
      config: input.config,
    });

    const configSnapshot = {
      ...input.config,
      createdAt: input.asOf.toISOString(),
    };
    const diagnostics = {
      ...input.diagnostics,
      elapsedMs: input.elapsedMs,
      candidateCount: input.candidates.length,
      selectedCount: input.selected.length,
    };

    const existing = await prisma.strategyRun.findFirst({
      where: {
        strategyId: input.strategy.id,
        asOf: input.asOf,
        inputFingerprint: fingerprint,
      },
    });

    const strategyRun = existing
      ? await prisma.strategyRun.update({
          where: { id: existing.id },
          data: {
            strategyNameSnapshot: input.strategy.name,
            traceId: input.traceId,
            clusterKey: input.clusterKey,
            status: 'RUNNING',
            configSnapshot,
            diagnostics,
            errorMessage: null,
            completedAt: null,
          },
        })
      : await prisma.strategyRun.create({
          data: {
            strategyId: input.strategy.id,
            strategyNameSnapshot: input.strategy.name,
            traceId: input.traceId,
            clusterKey: input.clusterKey,
            asOf: input.asOf,
            status: 'RUNNING',
            inputFingerprint: fingerprint,
            configSnapshot,
            diagnostics,
          },
        });

    if (existing) {
      await prisma.strategyRecommendationEvent.deleteMany({
        where: {
          strategyRunId: strategyRun.id,
        },
      });
    }

    const eventRows = input.selected.map((candidate, index) => ({
      strategyRunId: strategyRun.id,
      strategyId: input.strategy.id,
      traceId: input.traceId,
      clusterKey: input.clusterKey,
      asOf: input.asOf,
      rank: index + 1,
      symbol: candidate.symbol,
      stockName: candidate.stockName,
      industry: candidate.industry,
      finalScore: new Prisma.Decimal(candidate.score.toFixed(4)),
      scoreBreakdown: candidate.scoreBreakdown,
      reasons: [...candidate.reasons],
      baseTradingDay: candidate.baseTradingDay,
      basePrice: new Prisma.Decimal(candidate.basePrice.toFixed(4)),
      currentTradingDay: candidate.currentTradingDay,
      currentPrice: candidate.currentPrice == null ? null : new Prisma.Decimal(candidate.currentPrice.toFixed(4)),
      returnPct: candidate.returnPct == null ? null : new Prisma.Decimal(candidate.returnPct.toFixed(6)),
      returnStatus: candidate.returnStatus,
    }));

    if (eventRows.length > 0) {
      await prisma.strategyRecommendationEvent.createMany({
        data: eventRows,
        skipDuplicates: true,
      });
    }

    await prisma.strategyRun.update({
      where: { id: strategyRun.id },
      data: {
        status: 'SUCCESS',
        diagnostics: {
          ...diagnostics,
          selectedSignalTypes: input.selected.reduce<Record<string, number>>((acc, candidate) => {
            const signalType = normalizeSelectionSignalType(candidate.scoreBreakdown.selectionSignalType ?? candidate.industry);
            acc[signalType] = (acc[signalType] ?? 0) + 1;
            return acc;
          }, {}),
        },
        completedAt: new Date(),
      },
    });

    return {
      strategyId: input.strategy.id,
      strategyName: input.strategy.name,
      status: 'SUCCESS',
      recommendationCount: input.selected.length,
      selectedSignals: input.selected.reduce<Record<string, number>>((acc, candidate) => {
        const signalType = normalizeSelectionSignalType(candidate.scoreBreakdown.selectionSignalType ?? candidate.industry);
        acc[signalType] = (acc[signalType] ?? 0) + 1;
        return acc;
      }, {}),
      errorMessage: null,
    };
  }

  private async persistStrategyRunFailure(
    prisma: any,
    input: {
      readonly strategy: IStrategyDefinitionRow;
      readonly traceId: string;
      readonly asOf: Date;
      readonly clusterKey: string;
      readonly errorMessage: string;
      readonly elapsedMs: number;
      readonly config?: IStrategyExperimentConfig;
      readonly rawConfigSnapshot?: unknown;
    },
  ): Promise<void> {
    if (!prisma.strategyRun?.findFirst || !prisma.strategyRun?.create || !prisma.strategyRun?.update) {
      return;
    }

    const configSnapshot = input.config ?? input.rawConfigSnapshot ?? defaultStrategyExperimentConfig();
    const fingerprint = stableFingerprint({
      strategyId: input.strategy.id,
      asOf: input.asOf,
      clusterKey: input.clusterKey,
      config: configSnapshot,
    });

    const existing = await prisma.strategyRun.findFirst({
      where: {
        strategyId: input.strategy.id,
        asOf: input.asOf,
        inputFingerprint: fingerprint,
      },
    });

    const payload = {
      strategyNameSnapshot: input.strategy.name,
      traceId: input.traceId,
      clusterKey: input.clusterKey,
      status: 'FAILED',
      configSnapshot,
      diagnostics: {
        elapsedMs: input.elapsedMs,
        errorMessage: input.errorMessage,
        rawConfigSnapshot: input.rawConfigSnapshot ?? null,
      },
      errorMessage: input.errorMessage,
      completedAt: new Date(),
    };

    if (existing) {
      await prisma.strategyRun.update({
        where: { id: existing.id },
        data: payload,
      });
      await prisma.strategyRecommendationEvent.deleteMany({
        where: {
          strategyRunId: existing.id,
        },
      });
      return;
    }

    await prisma.strategyRun.create({
      data: {
        strategyId: input.strategy.id,
        strategyNameSnapshot: input.strategy.name,
        traceId: input.traceId,
        clusterKey: input.clusterKey,
        asOf: input.asOf,
        status: 'FAILED',
        inputFingerprint: fingerprint,
        configSnapshot: payload.configSnapshot,
        diagnostics: payload.diagnostics,
        errorMessage: input.errorMessage,
        completedAt: payload.completedAt,
      },
    });
  }
}
