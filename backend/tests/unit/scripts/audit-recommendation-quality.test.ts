import { describe, expect, it } from 'vitest';

import { auditRecommendationQualityRows } from '../../../scripts/audit-recommendation-quality.js';

describe('auditRecommendationQualityRows', () => {
  it('detects stale market data, saturated theme evidence and graph-dominated recommendations', () => {
    const issues = auditRecommendationQualityRows([
      {
        traceId: 'trace-2026-06-29',
        rank: 2,
        symbol: '600198',
        stockName: '大唐电信',
        finalScore: 63,
        reasons: [
          '评分组件：证据 35.0000/35，图谱 15.0000/15，暴露 5.5807/15，市场 7.7637/35，总分 63.3444/100',
          '关键词 [半导体] 累计净贡献值 4.6838，单关键词有效贡献按 1.5 封顶',
        ],
        scoreBreakdown: {
          evidenceScore: 35,
          graphScore: 15,
          exposurePrecisionScore: 5.5,
          marketSignalScore: 7.7,
          marketSignal: {
            staleTradingDays: 7,
            momentum5dPct: 0.03,
            momentum20dPct: 0.02,
            volumeRatio20d: 1.5,
            breakout20d: false,
          },
        },
        pctChange: -8.55,
        latestTradingDay: '2026-06-16',
        latestMarketTradingDay: '2026-06-29',
      },
      {
        traceId: 'trace-2026-06-29',
        rank: 24,
        symbol: '600909',
        stockName: '华安证券',
        finalScore: 33,
        reasons: ['评分组件：证据 6.2086/45，图谱 15.0000/20，暴露 5.0578/15，市场 7.2662/20，总分 33.5326/100'],
        scoreBreakdown: {
          evidenceScore: 6.2,
          graphScore: 15,
          exposurePrecisionScore: 5,
          marketSignalScore: 7,
          marketSignal: {},
        },
        pctChange: -16.21,
      },
    ]);

    expect(issues.map(issue => issue.type)).toEqual(expect.arrayContaining([
      'weight_mismatch',
      'stale_market_signal',
      'keyword_saturated',
      'post_return',
      'graph_dominated',
    ]));
  });
});
