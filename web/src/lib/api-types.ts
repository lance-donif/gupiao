export interface DispatchResponse { trace_id: string; celery_task_id: string }

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

export interface BatchProgressNode {
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

export interface BatchNodeResultSummaryCard {
  key: string;
  label: string;
  value: string;
}

export interface BatchNodeResultSection {
  key: string;
  label: string;
  kind: 'scalar' | 'object' | 'list';
  total_count: number;
  page: number;
  page_size: number;
  has_more: boolean;
  items: Array<Record<string, unknown>>;
  fields: Record<string, unknown>;
}

export interface BatchNodeResult {
  batch_id: string;
  node_id: string;
  node_label: string;
  status: string;
  source: 'node_snapshot';
  summary_cards: BatchNodeResultSummaryCard[];
  sections: BatchNodeResultSection[];
}

export interface DailyReportEvidence {
  evidence_id: string;
  source: string;
  title: string;
  url: string;
  event_ts_or_publish_ts: number;
  snippet: string;
  schema_version: string;
  anchor_status: 'ANCHOR_OK' | 'ANCHOR_MULTI_HIT' | 'ANCHOR_MISS' | 'UNAVAILABLE';
  created_at?: string | null;
}

export interface DailyReportPath {
  hop_index: number;
  src_entity: string;
  dst_entity: string;
  relation_type: string;
  relation_confidence: number;
  source_diversity_score?: number;
  conflict_penalty?: number;
  path_score?: number;
  direction?: 'OUTBOUND' | 'INBOUND' | 'UNKNOWN';
  edge_fact_id?: string | null;
  anchor_status: 'ANCHOR_OK' | 'ANCHOR_MULTI_HIT' | 'ANCHOR_MISS' | 'UNAVAILABLE';
  evidences: DailyReportEvidence[];
}

export interface DailyReportStock {
  ticker: string;
  name: string;
  stage: 'A' | 'B' | 'C';
  total_score: number;
  confidence?: number | null;
  confidence_reason?: string | null;
  macro_mainline?: string | null;
  macro_reason?: string | null;
  why_this_stock: { short: string; detail: string };
  why_now: string | { detail: string };
  stage_strategy?: {
    watch_signals?: string[];
    trigger_to_B?: string;
    entry_trigger?: string;
    stop_loss_rule?: string;
    take_profit_rule?: string;
    position_suggestion?: string;
    do_not_chase_reason?: string;
    second_chance_trigger?: string;
  };
  falsification_conditions: string[];
  risk_summary?: string;
  hard_c_reasons?: string[];
  tradeability_flags?: {
    tradeable: boolean;
    reasons: string[];
    candles_used: number;
  };
  evidence_paths: DailyReportPath[];
  tech_details?: Record<string, unknown> | null;
  graph_data?: unknown;
  evidence_tier?: 'E1' | 'E0';
  evidence_path_count?: number;
  selection_reason_codes?: string[];
  selection_reason_texts_zh?: string[];
  latest_close?: number | string | null;
  amount?: number | string | null;
  market_cap?: number | string | null;
  ret_5d?: number | string | null;
  quality_filter_tags?: string[];
  quality_filter_texts_zh?: string[];
  candidate_source?: string;
  candidate_source_confidence?: number | null;
  trade_plan?: {
    buy_when: string;
    buy_price_ref: number | null;
    buy_price_range: [number, number] | null;
    stop_loss_price: number | null;
    take_profit_range: [number, number] | null;
    sell_when: string;
  };
  friend_chain?: {
    nodes: string[];
    edges: { rel_zh: string; polarity: 1 | -1; weight: number | null }[];
    text: string;
    source: 'CAUSAL' | 'EVIDENCE_FALLBACK';
  };
}

export interface DailyReportPayload {
  available: boolean;
  report_kind: 'PERSISTED' | 'EMPTY';
  warnings: string[];
  summary_text?: string;
  hotspot_overview?: {
    primary_hotspots: string[];
    overflow_hotspots: string[];
    weak_signals: string[];
    hotspot_debug: {
      theme_caps_applied: number;
      deduped_theme_count: number;
      dropped_same_theme_count: number;
      source_news_count: number;
      duplicate_news_count: number;
      weak_signal_count: number;
      weak_signal_appended_count: number;
      weak_signal_overflow_count: number;
    };
  };
  news_diagnostics?: {
    source_distribution: Record<string, number>;
    raw_count: number;
    exact_dedup_count: number;
    semantic_dedup_count: number;
    cross_batch_duplicate_count: number;
    duplicate_title_count: number;
    translated_count: number;
    final_input_count: number;
  };
  group_id: string;
  group_version_id: string;
  display_date: string;
  as_of_trade_date: string;
  recommendation_kind: 'TRADING' | 'NON_TRADING_SPECIAL';
  stage_rules_version: string;
  batch_quality: {
    schema_checked_count: number;
    schema_mismatch_count: number;
    schema_mismatch_rate: number;
    degraded: boolean;
    promote_blocked_by_quality: boolean;
  };
  recommendations: {
    A: DailyReportStock[];
    B: DailyReportStock[];
    C: DailyReportStock[];
  };
  meta: {
    batch_id: string;
    trace_id: string;
    run_fingerprint: string;
    created_at: string;
    status: string;
  };
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

export interface ClusterVersion {
  id: string;
  group_id: string;
  version: number;
  prompts_dir: string;
  created_at: string | null;
}

export interface ClusterFeedback {
  id?: string;
  group_id: string;
  group_version_id: string;
  display_date: string;
  ticker: string;
  score: number;
  reason?: string | null;
  trace_id?: string;
  created_at?: string;
  updated_at?: string;
  deleted?: boolean;
}

export interface GraphNode { id: string; label: string; type: string }
export interface GraphEdge {
  source: string;
  target: string;
  label: string;
  type: string;
  event_ts?: number | null;
  confidence?: number | null;
}
export interface GraphOut { nodes: GraphNode[]; edges: GraphEdge[] }
export interface PromotePreflightResponse {
  group_id: string;
  stage_rules_version: string;
  eval_rules_version: string;
  rules_pair_key: string;
  gate_profile: string;
  gate_passed: boolean;
  gate_failed_reasons: string[];
  matured_valid_ab_tradeable_count: number;
  c_class_rate: number | null;
  warnings: string[];
}

export interface ContributionDetailRow {
  newsId: string;
  keyword: string;
  sourceKeyword?: string | null;
  matchedExposureKeyword?: string | null;
  exposureFactId?: string | null;
  matchMethod?: string | null;
  matchConfidence?: number | null;
  baseFrequencyScore: number;
  timeDecayedScore: number;
  reprintPenaltyScore: number;
  finalContribScore: number;
  reasons: string[];
  asOf: string;
  clusterKey: string;
}

export interface ContributionDetailPayload {
  traceId: string;
  symbol: string;
  totalContribution: number;
  rows: ContributionDetailRow[];
}

export interface MetricsOverview {
  last_ts?: number | null;
  events: Record<string, number>;
  levels: Record<string, number>;
  avg_lag_seconds?: number | null;
  schema_mismatch_rate_latest?: number | null;
  schema_mismatch_block_count?: number;
  leadtime_breakout_median_latest?: number | null;
  no_breakout_rate_latest?: number | null;
  promote_gate_block_count?: number;
  latest_trade_date?: string | null;
  stock_count_latest?: number;
}

export interface RealtimeQuote {
  price: number | null;
  change: number | null;
  change_pct: number | null;
  volume: number | null;
  high: number | null;
  low: number | null;
  open: number | null;
  pre_close: number | null;
  timestamp?: string | null;
  source?: string;
  amount?: number | null;
  market_cap?: number | null;
  intraday?: RealtimeQuotePoint[];
  minute_points?: RealtimeQuotePoint[];
  points?: RealtimeQuotePoint[];
  series?: RealtimeQuotePoint[];
}

export interface RealtimeQuotePoint {
  time?: string | null;
  timestamp?: string | null;
  price?: number | string | null;
  close?: number | string | null;
  value?: number | string | null;
}

export type ConfigCategory = 'ai' | 'akshare' | 'strategy' | 'system';

export interface StrategyConfigWeights {
  evidence: number;
  graph: number;
  exposure: number;
  market: number;
}

export interface StrategyMarketWeights {
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

export interface StrategyProfitHorizonResult {
  trading_day: string | null;
  price: number | null;
  return_pct: number | null;
  status: 'LIVE' | 'FINAL' | 'PENDING' | 'NO_CURRENT_PRICE' | 'NO_BASE_PRICE';
  price_source: 'tickflow' | 'yahoo_finance' | 'candle_fallback' | 'unavailable' | 'settlement';
  price_time: string | null;
  settlement_note: string | null;
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

export interface ConfigItem {
  key: string;
  value: string;
  category: ConfigCategory;
  label: string;
  is_secret: boolean;
}

export interface TraceOverview {
  trace_id: string;
  status: string;
  latest_phase: string;
  started_at?: string | null;
  finished_at?: string | null;
  steps_total: number;
  events_total: number;
  total_tokens: number;
  total_cost_usd?: number;
}

export interface TraceStep {
  id: number;
  trace_id: string;
  batch_id: string | null;
  group_id: string | null;
  flow: string;
  node_name: string;
  sequence_no: number;
  status: string;
  error_code: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number;
  input_snapshot: Record<string, unknown>;
  output_snapshot: Record<string, unknown>;
  delta_snapshot: Record<string, unknown>;
  metrics: Record<string, unknown>;
}

export interface TraceEvent {
  id: number;
  trace_id: string;
  batch_id: string | null;
  group_id: string | null;
  sequence_no: number;
  event_type: string;
  level: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface TracePage<T> {
  trace_id: string;
  rows: T[];
  next_cursor: number | null;
  has_more: boolean;
}

export interface TraceCostOut {
  trace_id: string;
  total_cost_usd: number;
  total_tokens: number;
  rows: Array<{
    role: string;
    model: string;
    provider: string;
    calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost_usd: number;
  }>;
}

export interface RuntimeGraphOut {
  trace_id: string;
  graph_kind: 'execution' | 'causal';
  nodes: Array<{
    id: string;
    label: string;
    type: string;
    status?: string;
    data: Record<string, unknown>;
  }>;
  edges: Array<{
    source: string;
    target: string;
    label: string;
    type: string;
    data: Record<string, unknown>;
  }>;
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

export interface DashboardExecutionHistoryItem {
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

export interface ThemeForecastItem {
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

export interface ExpectationGapItem {
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

export interface LiveQuotePayload {
  price: number | null;
  day_low: number | null;
  day_high: number | null;
  market_time: string | null;
  source: 'tickflow' | 'yahoo_finance' | 'candle_fallback' | 'unavailable';
  status: 'LIVE' | 'FALLBACK' | 'UNAVAILABLE';
}

export interface DashboardUiSummary {
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
