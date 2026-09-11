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
  it('高分同行业挤占名额时保底让低分新行业先进', () => {
    // 前 5 名占满后，银行 A2-A4（65~63 分）仍高于机器人 F1（50 分）：
    // 无保底时 A2-A4 吃掉剩余名额，F 行业出局；有保底时 A2-A4 让路，F 先进再回填。
    const candidates = [
      buildRec('银行', 70),
      buildRec('商贸零售', 69),
      buildRec('交通运输', 68),
      buildRec('食品农业', 67),
      buildRec('化工材料', 66),
      buildRec('银行', 65),
      buildRec('银行', 64),
      buildRec('银行', 63),
      buildRec('机器人设备', 50),
    ];

    const result = new TempRecommendationSelector().selectTopRecommendationsWithDiagnostics(candidates, 8, 30);

    expect(result.recommendations).toHaveLength(8);
    // 6 个可用行业全覆盖（含 50 分的机器人设备）
    expect(distinctIndustries(result.recommendations)).toBe(6);
    expect(result.diagnostics.distinctIndustryCount).toBe(6);
    expect(result.diagnostics.eligibleIndustryCount).toBe(6);
    expect(result.recommendations.map(item => item.industry)).toContain('机器人设备');
    // 银行只留 3 只（A1 首选 + A2/A3 回填），A4 被名额挡掉
    expect(result.recommendations.filter(item => item.industry === '银行')).toHaveLength(3);
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
