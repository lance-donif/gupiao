export interface DispatchResponse { trace_id: string; celery_task_id: string }

interface BatchProgressNode {
  node_id: string;
  node_label: string;
  sequence_no: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  total_count: number;
  current_index: number;
  current_label: string;
  has_result: boolean;
  started_at?: string | null;
  updated_at?: string | null;
  finished_at?: string | null;
}

export interface BatchProgress {
  batch_id: string;
  trace_id: string;
  group_id: string;
  target_trading_date: string;
  batch_status: string;
  current_stage: string;
  current_stage_index: number;
  remaining_node_count: number;
  nodes: BatchProgressNode[];
}

export interface BatchBrief {
  id: string;
  group_id: string;
  group_version_id: string;
  target_trading_date: string;
  status: string;
  trace_id: string;
  run_fingerprint: string;
  enqueued_at: number;
  started_at?: string | null;
  finished_at?: string | null;
  graph_done: boolean;
  chroma_done: boolean;
  market_cached_done: boolean;
  schema_checked_count?: number;
  schema_mismatch_count?: number;
  schema_mismatch_rate?: number;
  promote_blocked_by_quality?: boolean;
  quality_warnings_json?: string;
  error_code?: string | null;
  error_message?: string | null;
}

export interface ClusterSummary {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  active_version_id?: string | null;
  active_version?: number | null;
  last_batch_status?: string | null;
  last_target_trading_date?: string | null;
  updated_at?: string | null;
}

interface StrategyConfigWeights {
  evidence: number;
  graph: number;
  exposure: number;
  market: number;
}

interface StrategyMarketWeights {
  momentum5d: number;
  momentum20d: number;
  volumeRatio: number;
  breakout: number;
  compression: number;
  fibonacci: number;
  supportResistance: number;
}

export interface StrategyConfig {
  limit: number;
  maxPerSignalType: number;
  maxPrice: number | null;
  exclude688: boolean;
  excludeST: boolean;
  recent5dGainMaxPct: number | null;
  minFinalScore: number | null;
  minEvidenceScore: number | null;
  minExposureScore: number | null;
  minMarketScore: number | null;
  includeSignalTypes: string[];
  excludeSignalTypes: string[];
  weights: StrategyConfigWeights;
  marketWeights: StrategyMarketWeights;
  fibonacciLookbackDays: number;
  fibonacciThresholdPct: number;
  supportResistanceLookbackDays: number;
  supportResistanceThresholdPct: number;
}

export interface StrategyDefinition {
  id: string;
  cluster_key: string;
  name: string;
  description: string | null;
  enabled: boolean;
  config_json: StrategyConfig;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  last_status: string | null;
  last_error_message: string | null;
}

interface StrategyProfitHorizonResult {
  trading_day: string | null;
  price: number | null;
  return_pct: number | null;
  status: 'LIVE' | 'FINAL' | 'PENDING' | 'NO_CURRENT_PRICE' | 'NO_BASE_PRICE';
  price_source: 'tickflow' | 'yahoo_finance' | 'candle_fallback' | 'unavailable' | 'settlement';
  price_time: string | null;
  settlement_note: string | null;
}

export interface StrategyProfitRow {
  strategy_id: string;
  strategy_name: string;
  strategy_run_id: string;
  trace_id: string;
  execution_time: string | null;
  trace_label: string;
  cluster_key: string;
  as_of: string;
  rank: number;
  symbol: string;
  stock_name: string;
  industry: string;
  final_score: number;
  score_breakdown: Record<string, unknown>;
  reasons: string[];
  base_trading_day: string;
  base_price: number;
  current_trading_day: string | null;
  current_price: number | null;
  return_pct: number | null;
  return_status: string;
  horizons?: {
    live: StrategyProfitHorizonResult;
    t1: StrategyProfitHorizonResult;
    t3: StrategyProfitHorizonResult;
    t5: StrategyProfitHorizonResult;
  };
  recommendation_key: string;
}

export interface StrategyProfitHorizonSummary {
  sample_count: number;
  pending_count: number;
  final_count: number;
  avg_return_pct: number | null;
  win_rate: number | null;
  max_drawdown_pct: number | null;
}

export interface StrategyProfitSummary {
  strategy_id: string;
  strategy_name: string;
  run_count: number;
  recommendation_count: number;
  avg_return_pct: number | null;
  median_return_pct: number | null;
  win_rate: number | null;
  top_return_pct: number | null;
  worst_return_pct: number | null;
  horizon_summaries?: {
    live: StrategyProfitHorizonSummary;
    t1: StrategyProfitHorizonSummary;
    t3: StrategyProfitHorizonSummary;
    t5: StrategyProfitHorizonSummary;
  };
}

export interface StrategyProfitPayload {
  cluster_key: string;
  as_of: string;
  rows: StrategyProfitRow[];
  summaries: StrategyProfitSummary[];
}

export interface StrategyPerformanceReport {
  id: string;
  strategy_id: string;
  strategy_name_snapshot: string;
  cluster_key: string;
  as_of: string;
  win_rate: number | null;
  profit_ratio: number | null;
  avg_return_pct: number | null;
  max_drawdown: number | null;
  recommendation_count: number;
  created_at: string;
}

export interface DashboardRecommendationItem {
  symbol: string;
  stock_name: string;
  industry: string;
  rank: number;
  stage: 'A' | 'B' | 'C';
  total_score: number;
  confidence: number;
  evidence_count: number;
  l1_evidence_count: number;
  total_contribution: number;
  latest_close: number | null;
  latest_trading_day: string | null;
  macro_mainline: string | null;
  reason_summary: string;
  reason_detail: string;
  score_breakdown: Record<string, unknown>;
  trace_id: string;
  strategy_id: string | null;
  win_rate_t1: number | null;
  win_rate_t3: number | null;
}

interface DashboardExecutionHistoryItem {
  trace_id: string;
  batch_id: string;
  started_at: string | null;
  finished_at: string | null;
  target_trading_date: string;
  group_id: string;
  strategy_id: string | null;
  status: string;
  current_stage: string;
  error_code: string | null;
  error_message: string | null;
}

interface ThemeForecastItem {
  theme: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  probability: number;
  horizon: number;
  signal_strength: number;
  expectation_gap: number;
  related_symbols: string[];
  weak_signal: boolean;
  reasons: string[];
}

interface ExpectationGapItem {
  keyword: string;
  graph_strength: number;
  price_reaction: number;
  expectation_gap: number;
  is_weak_signal: boolean;
  related_symbols: string[];
  reasons: string[];
}

export interface DashboardSnapshotPayload {
  available: boolean;
  group_id: string;
  group_version_id: string | null;
  display_date: string;
  strategy_id: string | null;
  default_symbol: string | null;
  recommendations: DashboardRecommendationItem[];
  execution_history: DashboardExecutionHistoryItem[];
  theme_forecasts: ThemeForecastItem[];
  expectation_gaps: ExpectationGapItem[];
  warnings: string[];
  sla: {
    status: 'ready' | 'failed' | 'running' | 'waiting' | 'no_trace';
    status_label: string;
    failed_node: string | null;
    failed_node_label: string | null;
    error_message: string | null;
    next_retry_at: string | null;
    deadline_at: string;
  };
  quality: {
    recommendation_count: number;
    effective_evidence_count: number;
    l1_coverage: number;
    schema_checked_count: number;
    schema_mismatch_count: number;
    schema_mismatch_rate: number;
    timeliness_status: string;
    execution_time: string | null;
  };
  meta: {
    trace_id: string;
    batch_id: string | null;
    run_fingerprint: string | null;
    current_stage: string | null;
    status: string | null;
    started_at: string | null;
    finished_at: string | null;
  };
}

interface LiveQuotePayload {
  price: number | null;
  day_low: number | null;
  day_high: number | null;
  change_pct: number | null;
  market_time: string | null;
  source: 'tickflow' | 'yahoo_finance' | 'candle_fallback' | 'unavailable';
  status: 'LIVE' | 'FALLBACK' | 'UNAVAILABLE';
}

interface DashboardUiSummary {
  decision: {
    headline: string;
    action_state: 'strong_buy' | 'watch_pullback' | 'observe' | 'avoid';
    action_label: '强推荐' | '等待回踩' | '继续观察' | '暂不买入';
    score_formula: string;
  };
  buy_trigger: {
    trigger_label: string;
    buy_price_ref_label: string;
    stop_loss_label: string;
    position_label: string;
  };
  why_stock: {
    conclusion: string;
    key_evidence: string;
    mapping_reason: string;
    risk_note: string;
  };
  why_now: Array<{
    label: string;
    detail: string;
    tone: 'positive' | 'neutral' | 'warning';
  }>;
  primary_evidence: {
    chain_id: string | null;
    mapping_short: string;
    mapping_explanation: string;
  };
  system_health: {
    data_updated_at: string | null;
    schema_health_label: string;
    pipeline_health_label: string;
  };
}

export interface DashboardStockDetailPayload {
  symbol: string;
  stock_name: string;
  industry: string;
  rank: number;
  stage: 'A' | 'B' | 'C';
  total_score: number;
  confidence: number;
  trace_id: string;
  strategy_id: string | null;
  macro_mainline: string | null;
  latest_close: number | null;
  latest_trading_day: string | null;
  live_quote: LiveQuotePayload;
  score_breakdown: {
    evidence: number;
    graph: number;
    exposure: number;
    market: number;
    total_contribution: number;
    evidence_count: number;
    raw: Record<string, unknown>;
  };
  why_this_stock: {
    short: string;
    detail: string;
  };
  why_now: {
    headline: string;
    bullets: string[];
    tone: 'ready' | 'watch';
  };
  trade_plan: {
    buy_when: string;
    buy_price_ref: number | null;
    buy_price_range: [number, number] | null;
    stop_loss_price: number | null;
    take_profit_range: [number, number] | null;
    sell_when: string;
  } | null;
  market_confirmation: {
    momentum5d_pct: number | null;
    momentum20d_pct: number | null;
    volume_ratio20d: number | null;
    breakout20d: boolean;
    volatility_compression: boolean;
    recent_week_gain_exceeded: boolean;
    reasons: string[];
  };
  falsification_conditions: string[];
  concept_tags: string[];
  ui_summary: DashboardUiSummary;
}

export interface DashboardEvidenceChainItem {
  chain_id: string;
  news: {
    news_id: string;
    title: string;
    source: string;
    published_at: string;
    url: string;
    excerpt: string;
    anchor_quote: string;
  };
  signal: {
    source_keyword: string | null;
    asset_or_theme_keyword: string | null;
    match_method: string | null;
    match_confidence: number | null;
    signal_reason: string;
  };
  exposure: {
    matched_exposure_keyword: string | null;
    exposure_fact_id: string | null;
    exposure_type: string | null;
    exposure_label: string;
    exposure_reason: string;
    external_fact: {
      source: string | null;
      source_id: string | null;
      source_name: string | null;
      source_provider: string | null;
      source_url: string | null;
      observed_at: string | null;
      updated_at?: string | null;
      confidence: number | null;
      evidence_text: string;
      raw_field?: string | null;
      exposure_type?: string | null;
      sourceId?: string | null;
      sourceName?: string | null;
      exposureType?: string | null;
      rawField?: string | null;
      updatedAt?: string | null;
      verification_status: 'verified_external' | 'historical_news' | 'missing_external_fact';
      verification_label: string;
    };
  };
  stock_link: {
    symbol: string;
    stock_name: string;
    link_reason: string;
    industry: string | null;
    concept_tags: string[];
  };
  score: {
    base_frequency_score: number;
    time_decayed_score: number;
    reprint_penalty_score: number;
    final_contrib_score: number;
  };
}

export interface DashboardEvidencePayload {
  trace_id: string;
  group_id: string;
  symbol: string;
  stock_name: string | null;
  stats: {
    effective_count: number;
    total_count: number;
    coverage: number;
    average_confidence: number;
    total_contribution: number;
  };
  items: DashboardEvidenceChainItem[];
}

export interface DashboardNetworkPayload {
  trace_id: string;
  group_id: string;
  symbol: string;
  stock_name: string | null;
  nodes: Array<{
    id: string;
    label: string;
    kind: 'stock' | 'theme' | 'keyword' | 'exposure' | 'industry';
    polarity: 'positive' | 'neutral' | 'negative';
    weight: number;
  }>;
  edges: Array<{
    source: string;
    target: string;
    label: string;
    confidence: number;
    source_type: '因果链' | '暴露映射' | '全局图谱';
  }>;
  relations: Array<{
    source: string;
    relation: string;
    target: string;
    strength: number;
    source_type: '因果链' | '暴露映射' | '全局图谱';
  }>;
  related_theme_forecasts: ThemeForecastItem[];
  network_preview: {
    explanation: string | null;
  };
}
