import type { IBackendArtifacts } from './types.js';

interface IRankedRecommendation {
  readonly rank: number;
  readonly ticker: string;
  readonly name: string;
  readonly score: number;
  readonly stage: 'A' | 'B' | 'C';
  readonly reasons: readonly string[];
  readonly industry: string;
  readonly latest_close: number | null;
}

interface IPartitionedRecommendations {
  readonly ranked: readonly IRankedRecommendation[];
  readonly byStage: {
    readonly A: readonly IRankedRecommendation[];
    readonly B: readonly IRankedRecommendation[];
    readonly C: readonly IRankedRecommendation[];
  };
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const computeStage = (index: number, total: number): 'A' | 'B' | 'C' => {
  if (total <= 2) {
    return index === 0 ? 'A' : 'B';
  }
  const aCutoff = Math.max(1, Math.ceil(total * 0.3));
  const bCutoff = Math.max(aCutoff + 1, Math.ceil(total * 0.7));
  if (index < aCutoff) {
    return 'A';
  }
  if (index < bCutoff) {
    return 'B';
  }
  return 'C';
};

const pickLatestClose = (artifacts: IBackendArtifacts, symbol: string): number | null => {
  const hit = artifacts.stockPayload.data.find(item => item.symbol === symbol);
  return hit?.price ?? null;
};

const partitionRecommendations = (artifacts: IBackendArtifacts): IPartitionedRecommendations => {
  const sorted = [...artifacts.recommendationFile.recommendations].sort((left, right) => right.score - left.score);
  const ranked = sorted.map((item, index) => ({
    rank: index + 1,
    ticker: item.symbol,
    name: item.stockName,
    score: item.score,
    stage: computeStage(index, sorted.length),
    reasons: item.reasons,
    industry: item.industry,
    latest_close: pickLatestClose(artifacts, item.symbol),
  }));
  return {
    ranked,
    byStage: {
      A: ranked.filter(row => row.stage === 'A'),
      B: ranked.filter(row => row.stage === 'B'),
      C: ranked.filter(row => row.stage === 'C'),
    },
  };
};

export const buildRecommendationDocuments = (input: {
  artifacts: IBackendArtifacts;
  tradeDate: string;
  groupId: string;
  groupVersionId: string;
  batchId: string;
  traceId: string;
  runFingerprint: string;
  createdAt: string;
}): readonly Record<string, unknown>[] => {
  const partitioned = partitionRecommendations(input.artifacts);
  const items = partitioned.ranked.map(row => ({
    id: `${input.batchId}-${row.ticker}`,
    rank: row.rank,
    symbol: row.ticker,
    ticker: row.ticker,
    name: row.name,
    stage: row.stage,
    ml_score: Number(row.score.toFixed(2)),
    latest_close: row.latest_close ?? 0,
    tech_score: Number((row.score / 10).toFixed(3)),
    final_score: row.score,
    reason: row.reasons.join('；') || '命中本地信号',
    summary_text: row.reasons.join('；') || '命中本地信号',
    tech_json: JSON.stringify({ industry: row.industry, reasons: row.reasons }),
  }));
  return [
    {
      id: input.batchId,
      batch_id: input.batchId,
      group_id: input.groupId,
      group_version_id: input.groupVersionId,
      trade_date: input.tradeDate,
      status: 'COMPLETED',
      summary_text: `共 ${items.length} 条推荐，兼容层生成`,
      created_at: input.createdAt,
      trace_id: input.traceId,
      run_fingerprint: input.runFingerprint,
      items,
    },
  ];
};

export const buildNonTradingRecommendationDocuments = (input: {
  artifacts: IBackendArtifacts;
  displayDate: string;
  groupId: string;
  groupVersionId: string;
  batchId: string;
  traceId: string;
  runFingerprint: string;
  createdAt: string;
}): readonly Record<string, unknown>[] => {
  const rows = buildRecommendationDocuments({
    artifacts: input.artifacts,
    tradeDate: input.displayDate,
    groupId: input.groupId,
    groupVersionId: input.groupVersionId,
    batchId: input.batchId,
    traceId: input.traceId,
    runFingerprint: input.runFingerprint,
    createdAt: input.createdAt,
  })[0] as { items: readonly Record<string, unknown>[] };
  return [
    {
      id: `nontrading-${input.batchId}`,
      batch_id: input.batchId,
      group_id: input.groupId,
      group_version_id: input.groupVersionId,
      display_date: input.displayDate,
      target_trade_date: input.displayDate,
      recommendation_kind: 'NON_TRADING_SPECIAL',
      status: 'COMPLETED',
      summary_text: `非交易日兼容推荐 ${rows.items.length} 条`,
      created_at: input.createdAt,
      trace_id: input.traceId,
      run_fingerprint: input.runFingerprint,
      items: rows.items,
    },
  ];
};

const defaultIndicators = (score: number): Record<string, unknown> => {
  const normalized = clamp(score / 100, 0.2, 0.95);
  return {
    rsi_6: Number((45 + normalized * 40).toFixed(2)),
    rsi_12: Number((43 + normalized * 35).toFixed(2)),
    rsi_24: Number((40 + normalized * 30).toFixed(2)),
    rsi_divergence: 'none',
    ma_5_ratio: Number((0.95 + normalized * 0.2).toFixed(3)),
    ma_10_ratio: Number((0.94 + normalized * 0.2).toFixed(3)),
    ma_20_ratio: Number((0.93 + normalized * 0.2).toFixed(3)),
    trend_direction: normalized > 0.66 ? '上涨' : normalized > 0.45 ? '震荡' : '下跌',
    volatility_5d: Number((12 + (1 - normalized) * 18).toFixed(2)),
    volatility_20d: Number((16 + (1 - normalized) * 16).toFixed(2)),
    max_drawdown_5d: Number((0.02 + (1 - normalized) * 0.12).toFixed(4)),
    max_drawdown_20d: Number((0.04 + (1 - normalized) * 0.2).toFixed(4)),
    volume_ratio: Number((0.8 + normalized * 1.8).toFixed(3)),
    volume_trend: normalized > 0.6 ? '放量' : '平量',
    ret_1d: Number(((normalized - 0.5) * 0.04).toFixed(4)),
    ret_5d: Number(((normalized - 0.45) * 0.08).toFixed(4)),
    ret_10d: Number(((normalized - 0.4) * 0.12).toFixed(4)),
    ret_20d: Number(((normalized - 0.35) * 0.2).toFixed(4)),
    momentum_acceleration: Number(((normalized - 0.5) * 1.5).toFixed(4)),
    sharpe_ratio: Number((0.4 + normalized * 1.8).toFixed(3)),
    market_cap: Math.round(5e9 + normalized * 8e10),
    pe_ratio: Number((15 + (1 - normalized) * 20).toFixed(2)),
    pb_ratio: Number((1.2 + (1 - normalized) * 2.8).toFixed(2)),
  };
};

export const buildMLRecommendations = (input: {
  artifacts: IBackendArtifacts;
  tradeDate: string;
  topN: number;
}): Record<string, unknown> => {
  const partitioned = partitionRecommendations(input.artifacts);
  const capped = partitioned.ranked.slice(0, Math.max(1, input.topN));
  const aRows = capped.filter(row => row.stage === 'A');
  const sCount = Math.max(1, Math.ceil(aRows.length * 0.3));
  const mapRow = (row: IRankedRecommendation, grade: 'S' | 'A' | 'B' | 'C') => ({
    ticker: row.ticker,
    name: row.name,
    ml_score: Number(row.score.toFixed(2)),
    grade,
    latest_close: row.latest_close ?? 0,
    tech_indicators: defaultIndicators(row.score),
    trade_script: {
      type: grade === 'S' ? 'breakout' : grade === 'A' ? 'follow-trend' : 'watch',
      open_pct: grade === 'S' ? '30%' : grade === 'A' ? '20%' : '10%',
      volume_ratio: grade === 'S' ? '>1.8' : '>1.2',
      stop_loss_pct: grade === 'S' ? '-4%' : '-5%',
      ml_score: Number(row.score.toFixed(2)),
    },
  });
  const grouped = {
    S: aRows.slice(0, sCount).map(row => mapRow(row, 'S')),
    A: aRows.slice(sCount).map(row => mapRow(row, 'A')),
    B: capped.filter(row => row.stage === 'B').map(row => mapRow(row, 'B')),
    C: capped.filter(row => row.stage === 'C').map(row => mapRow(row, 'C')),
  };
  return {
    trade_date: input.tradeDate,
    total_stocks: partitioned.ranked.length,
    analyzed_stocks: capped.length,
    recommendations: grouped,
    model_info: {
      type: 'local-compatibility',
      expected_top100_hit_rate: 'N/A',
      s_grade_count: grouped.S.length,
      a_grade_count: grouped.A.length,
      second_round_analyzed: grouped.S.length + grouped.A.length,
      description: '基于本地 artifacts 的稳定兼容响应',
    },
  };
};
