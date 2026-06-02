import { describe, expect, it } from 'vitest';

import { buildStrategyViewModel } from '../../../src/features/strategies/strategy-view-model';
import type { StrategyDefinition, StrategyProfitSummary } from '../../../src/lib/api-types';

const strategy: StrategyDefinition = {
  id: 's1',
  cluster_key: 'global',
  name: '策略一',
  description: null,
  enabled: true,
  config_json: {
    limit: 30,
    maxPerSignalType: 5,
    maxPrice: 40,
    exclude688: true,
    excludeST: true,
    recent5dGainMaxPct: 0.2,
    minFinalScore: null,
    minEvidenceScore: null,
    minExposureScore: null,
    minMarketScore: null,
    includeSignalTypes: [],
    excludeSignalTypes: [],
    weights: { evidence: 1.2, graph: 0.8, exposure: 1.1, market: 1 },
  },
  created_at: '',
  updated_at: '',
  last_run_at: null,
  last_status: null,
  last_error_message: null,
};

const summary: StrategyProfitSummary = {
  strategy_id: 's1',
  strategy_name: '策略一',
  run_count: 3,
  recommendation_count: 90,
  avg_return_pct: 0.1234,
  median_return_pct: 0.1,
  win_rate: 0.66,
  top_return_pct: 0.2,
  worst_return_pct: -0.05,
};

describe('buildStrategyViewModel', () => {
  it('formats filter, weight, and performance summaries', () => {
    expect(buildStrategyViewModel(strategy, summary)).toMatchObject({
      enabled_label: '已启用',
      filter_summary: '最多 30 只 / 价格 ≤ 40 / 排除 688 / 排除 ST / 5日涨幅 ≤ 20%',
      weight_summary: '证据 1.2 / 图谱 0.8 / 暴露 1.1 / 市场 1',
      performance_summary: '近 3 期，平均 +12.34%，胜率 +66%',
    });
  });
});
