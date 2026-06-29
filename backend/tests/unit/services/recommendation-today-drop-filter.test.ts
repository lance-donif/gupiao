import { describe, expect, it } from 'vitest';

import { isTodayDropEligible } from '../../../src/services/temp-stock-recommendation-service.js';
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
