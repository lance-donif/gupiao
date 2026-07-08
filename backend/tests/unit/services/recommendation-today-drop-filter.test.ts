import { describe, expect, it } from 'vitest';

import { TempRecommendationSelector, isTodayDropEligible } from '../../../src/services/temp-stock-recommendation-service.js';
import type { ITempStockRecommendation } from '../../../src/services/temp-stock-recommendation-service.js';

// 构造仅含 marketSignal.todayChangePct 的 mock 推荐
const buildRec = (todayChangePct: number | null | undefined): ITempStockRecommendation => ({
  symbol: '000001',
  stockName: '测试股',
  industry: '测试',
  score: 50,
  matchedSignals: [],
  matchedBoards: [],
  reasons: [],
  latestClose: 10,
  scoreBreakdown: {
    keywordFrequencyScore: 0,
    temperatureScore: 0,
    relationshipConfidenceScore: 0,
    boardMatchScore: 0,
    weakSignalBonus: 0,
    coverageBonus: 0,
    marketSignal: todayChangePct === undefined ? {} : { todayChangePct },
  },
});

describe('isTodayDropEligible', () => {
  it('当日跌幅超过 3% 阈值时不合格', () => {
    expect(isTodayDropEligible(buildRec(-0.05))).toBe(false);
  });

  it('当日上涨时合格', () => {
    expect(isTodayDropEligible(buildRec(0.02))).toBe(true);
  });

  it('缺少当日 Candle 数据（todayChangePct 为 null/undefined）时合格（保留）', () => {
    expect(isTodayDropEligible(buildRec(null))).toBe(true);
    expect(isTodayDropEligible(buildRec(undefined))).toBe(true);
  });

  it('恰好等于 -3% 阈值时合格（边界含等于）', () => {
    expect(isTodayDropEligible(buildRec(-0.03))).toBe(true);
  });
});

const buildQualityRec = (
  symbol: string,
  input: {
    evidenceScore?: number;
    graphScore?: number;
    exposurePrecisionScore?: number;
    marketSignalScore?: number;
    marketSignal?: Record<string, unknown>;
  } = {},
): ITempStockRecommendation => ({
  symbol,
  stockName: `测试股${symbol}`,
  industry: `行业${symbol}`,
  score: 50,
  matchedSignals: [`信号${symbol}`],
  matchedBoards: [],
  reasons: [],
  latestClose: 10,
  scoreBreakdown: {
    keywordFrequencyScore: input.evidenceScore ?? 20,
    temperatureScore: 0,
    relationshipConfidenceScore: input.graphScore ?? 5,
    boardMatchScore: input.exposurePrecisionScore ?? 8,
    weakSignalBonus: 0,
    coverageBonus: 0,
    evidenceScore: input.evidenceScore ?? 20,
    graphScore: input.graphScore ?? 5,
    exposurePrecisionScore: input.exposurePrecisionScore ?? 8,
    marketSignalScore: input.marketSignalScore ?? 10,
    marketSignal: input.marketSignal ?? {
      staleTradingDays: 0,
      volumeRatio20d: 1,
      breakout20d: false,
      momentum5dPct: 0,
      momentum20dPct: 0,
      latestTradingDay: '2026-07-07',
      latestMarketTradingDay: '2026-07-07',
    },
  },
});

describe('TempRecommendationSelector quality gate', () => {
  it('filters stale, graph-dominated, broad-exposure, overheated, low-volume rebound and long-downtrend candidates', () => {
    const result = new TempRecommendationSelector().selectTopRecommendationsWithDiagnostics([
      buildQualityRec('600001'),
      buildQualityRec('600002', { marketSignal: { staleTradingDays: 2 } }),
      buildQualityRec('600003', { evidenceScore: 8, graphScore: 12 }),
      buildQualityRec('600004', { exposurePrecisionScore: 3, evidenceScore: 17, marketSignalScore: 7 }),
      buildQualityRec('600005', { marketSignal: { momentum5dPct: 0.16, volumeRatio20d: 0.5, breakout20d: false } }),
      buildQualityRec('600006', { marketSignal: { momentum20dPct: -0.13, volumeRatio20d: 0.7 } }),
      buildQualityRec('600007', { marketSignal: { longTermMomentumPct: -0.31, volumeRatio20d: 1.6 } }),
      buildQualityRec('600008', { marketSignal: { latestTradingDay: '2026-07-06', latestMarketTradingDay: '2026-07-07', staleTradingDays: 1 } }),
    ], 10, 10);

    expect(result.recommendations.map(item => item.symbol)).toEqual(['600001']);
    expect(result.diagnostics.excludedByQualityGate).toBe(7);
    expect(result.diagnostics.shortfallReasons).toContainEqual(expect.stringContaining('推荐质量门槛过滤 7 只'));
  });
});
