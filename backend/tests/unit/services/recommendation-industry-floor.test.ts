import { describe, expect, it } from 'vitest';

import { TempRecommendationSelector } from '../../../src/services/temp-stock-recommendation-service.js';
import type { ITempStockRecommendation } from '../../../src/services/temp-stock-recommendation-service.js';

let serial = 0;
const buildRec = (industry: string, score: number, signalType?: string): ITempStockRecommendation => {
  serial += 1;
  const symbol = `600${String(100 + serial)}`;
  return {
    symbol,
    stockName: `测试股${symbol}`,
    industry,
    score,
    matchedSignals: [`信号${symbol}`],
    matchedBoards: [],
    reasons: [],
    latestClose: 10,
    scoreBreakdown: {
      keywordFrequencyScore: 20,
      temperatureScore: 0,
      relationshipConfidenceScore: 5,
      boardMatchScore: 8,
      weakSignalBonus: 0,
      coverageBonus: 0,
      evidenceScore: 20,
      graphScore: 5,
      exposurePrecisionScore: 8,
      marketSignalScore: 10,
      ...(signalType !== undefined ? { selectionSignalType: signalType } : {}),
      marketSignal: {
        staleTradingDays: 0,
        volumeRatio20d: 1,
        breakout20d: false,
        momentum5dPct: 0,
        momentum20dPct: 0,
        latestTradingDay: '2026-07-07',
        latestMarketTradingDay: '2026-07-07',
      },
    },
  };
};

const distinctIndustries = (items: readonly ITempStockRecommendation[]): number =>
  new Set(items.map(item => item.industry)).size;

describe('TempRecommendationSelector industry guarantee', () => {
  it('银行扎堆时每个行业保底 1 只，凑满 15 只', () => {
    const candidates: ITempStockRecommendation[] = [];
    for (let i = 0; i < 12; i += 1) candidates.push(buildRec('银行', 70 - i));
    const others = ['商贸零售', '交通运输', '食品农业', '化工材料', '机器人设备', '资源能源', '家电消费', '算力通信', '国防军工'];
    others.forEach((industry, i) => candidates.push(buildRec(industry, 58 - i)));

    const result = new TempRecommendationSelector().selectTopRecommendationsWithDiagnostics(candidates, 15, 30);

    expect(result.recommendations).toHaveLength(15);
    // 10 个可用行业全覆盖
    expect(distinctIndustries(result.recommendations)).toBe(10);
    expect(result.diagnostics.distinctIndustryCount).toBe(10);
    expect(result.diagnostics.eligibleIndustryCount).toBe(10);
    // 银行只留 6 只（1 首选 + 5 回填），不再占 10 只
    expect(result.recommendations.filter(item => item.industry === '银行')).toHaveLength(6);
    expect(result.diagnostics.shortfallReasons.join()).not.toContain('行业覆盖不足');
  });

  it('可用行业少时全覆盖，不报行业不足', () => {
    const candidates: ITempStockRecommendation[] = [];
    for (let i = 0; i < 4; i += 1) candidates.push(buildRec('银行', 70 - i));
    for (let i = 0; i < 4; i += 1) candidates.push(buildRec('商贸零售', 60 - i));
    for (let i = 0; i < 4; i += 1) candidates.push(buildRec('交通运输', 50 - i));

    const result = new TempRecommendationSelector().selectTopRecommendationsWithDiagnostics(candidates, 10, 30);

    expect(result.recommendations).toHaveLength(10);
    expect(distinctIndustries(result.recommendations)).toBe(3);
    expect(result.diagnostics.shortfallReasons.join()).not.toContain('行业覆盖不足');
  });

  it('名额少于行业数时按分取前 N 个行业', () => {
    const industries = ['银行', '商贸零售', '交通运输', '食品农业', '化工材料', '机器人设备'];
    const candidates = industries.map((industry, i) => buildRec(industry, 70 - i));

    const result = new TempRecommendationSelector().selectTopRecommendationsWithDiagnostics(candidates, 4, 30);

    expect(result.recommendations).toHaveLength(4);
    expect(distinctIndustries(result.recommendations)).toBe(4);
    expect(result.diagnostics.shortfallReasons.join()).not.toContain('行业覆盖不足');
  });

  it('某行业唯一候选被信号上限挡掉时报行业覆盖不足', () => {
    const candidates = [
      buildRec('银行', 70, '同信号'),
      buildRec('商贸零售', 60, '同信号'),
    ];

    const result = new TempRecommendationSelector().selectTopRecommendationsWithDiagnostics(candidates, 2, 1);

    expect(result.recommendations).toHaveLength(1);
    expect(distinctIndustries(result.recommendations)).toBe(1);
    expect(result.diagnostics.shortfallReasons.join()).toContain('行业覆盖不足');
  });
});
