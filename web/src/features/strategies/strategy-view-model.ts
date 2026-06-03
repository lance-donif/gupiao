import type { StrategyDefinition, StrategyProfitHorizonSummary, StrategyProfitSummary } from '@/lib/api-types';

export interface StrategyViewModel {
  id: string;
  name: string;
  enabled_label: '已启用' | '已停用';
  filter_summary: string;
  weight_summary: string;
  performance_summary: string;
}

export function buildStrategyViewModel(
  strategy: StrategyDefinition,
  summary?: StrategyProfitSummary | null,
): StrategyViewModel {
  const config = strategy.config_json;
  const filters = [
    `最多 ${config.limit} 只`,
    config.maxPrice == null ? '价格不限' : `价格 ≤ ${config.maxPrice}`,
    config.exclude688 ? '排除 688' : '包含 688',
    config.excludeST ? '排除 ST' : '包含 ST',
    config.recent5dGainMaxPct == null ? '5日涨幅不限' : `5日涨幅 ≤ ${(config.recent5dGainMaxPct * 100).toFixed(0)}%`,
  ];
  const weights = config.weights;
  const mw = config.marketWeights ?? { momentum5d: 6, momentum20d: 5, volumeRatio: 4, breakout: 3, compression: 2, fibonacci: 0, supportResistance: 0 };

  return {
    id: strategy.id,
    name: strategy.name,
    enabled_label: strategy.enabled ? '已启用' : '已停用',
    filter_summary: filters.join(' / '),
    weight_summary: `证据 ${weights.evidence} / 图谱 ${weights.graph} / 暴露 ${weights.exposure} / 市场 ${weights.market} | 行情 动量5d:${mw.momentum5d} 动量20d:${mw.momentum20d} 量比:${mw.volumeRatio} 突破:${mw.breakout} 压缩:${mw.compression} 斐波:${mw.fibonacci} 支撑阻力:${mw.supportResistance}`,
    performance_summary: formatPerformanceSummary(summary),
  };
}

function formatPerformanceSummary(summary?: StrategyProfitSummary | null): string {
  if (!summary || summary.recommendation_count === 0) {
    return '暂无收益样本';
  }

  const horizonOptions: Array<[string, StrategyProfitHorizonSummary | undefined]> = [
    ['T+5', summary.horizon_summaries?.t5],
    ['T+3', summary.horizon_summaries?.t3],
    ['T+1', summary.horizon_summaries?.t1],
  ];
  const settled = horizonOptions.find(([, horizon]) => (horizon?.final_count ?? 0) > 0);

  if (settled) {
    const [label, horizon] = settled;
    if (horizon) {
      return `近 ${summary.run_count} 期，${label} 已结算 ${horizon.final_count}/${horizon.sample_count}，平均 ${formatPct(horizon.avg_return_pct)}，胜率 ${formatPct(horizon.win_rate, 0)}`;
    }
  }

  const pending = summary.horizon_summaries?.t1?.pending_count ?? summary.recommendation_count;
  return `近 ${summary.run_count} 期，推荐 ${summary.recommendation_count} 只，T+1 待结算 ${pending} 只`;
}

function formatPct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) {
    return '--';
  }
  const pct = value * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(digits)}%`;
}
