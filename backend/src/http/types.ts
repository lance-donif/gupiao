import type { IFriendNetworkGraphSnapshot, IFriendNetworkTreeSnapshot } from '../services/friend-network-types.js';
import type { ITempStockPayload } from '../services/temp-stock-recommendation-service.js';

export type BackendConfigCategory = 'ai' | 'akshare' | 'strategy' | 'system';

export interface IBackendConfigItem {
  readonly key: string;
  readonly value: string;
  readonly category: BackendConfigCategory;
  readonly label: string;
  readonly is_secret: boolean;
}

export interface IBackendConfigStore {
  listByCategory: (category: BackendConfigCategory) => Promise<readonly IBackendConfigItem[]>;
  setValue: (key: string, value: string) => Promise<{ key: string; value: string; message: string }>;
}

export interface IContributionDetailRow {
  readonly newsId: string;
  readonly keyword: string;
  readonly sourceKeyword?: string | null;
  readonly matchedExposureKeyword?: string | null;
  readonly exposureFactId?: string | null;
  readonly matchMethod?: string | null;
  readonly matchConfidence?: number | null;
  readonly baseFrequencyScore: number;
  readonly timeDecayedScore: number;
  readonly reprintPenaltyScore: number;
  readonly finalContribScore: number;
  readonly reasons: readonly string[];
  readonly asOf: string;
  readonly clusterKey: string;
}

export interface IContributionDetailPayload {
  readonly traceId: string;
  readonly symbol: string;
  readonly totalContribution: number;
  readonly rows: readonly IContributionDetailRow[];
}

export interface IDashboardRecommendationItem {
  readonly symbol: string;
  readonly stock_name: string;
  readonly industry: string;
  readonly rank: number;
  readonly stage: 'A' | 'B' | 'C';
  readonly total_score: number;
  readonly confidence: number;
  readonly evidence_count: number;
  readonly l1_evidence_count: number;
  readonly total_contribution: number;
  readonly latest_close: number | null;
  readonly latest_trading_day: string | null;
  readonly macro_mainline: string | null;
  readonly reason_summary: string;
  readonly reason_detail: string;
  readonly score_breakdown: Record<string, unknown>;
  readonly trace_id: string;
  readonly strategy_id: string | null;
  readonly win_rate_t1: number | null;
  readonly win_rate_t3: number | null;
}

export interface IDashboardExecutionHistoryItem {
  readonly trace_id: string;
  readonly batch_id: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly target_trading_date: string;
  readonly group_id: string;
  readonly strategy_id: string | null;
  readonly status: string;
  readonly current_stage: string;
  readonly error_code: string | null;
  readonly error_message: string | null;
}

export interface IDashboardSnapshotPayload {
  readonly available: boolean;
  readonly group_id: string;
  readonly group_version_id: string | null;
  readonly display_date: string;
  readonly strategy_id: string | null;
  readonly default_symbol: string | null;
  readonly recommendations: readonly IDashboardRecommendationItem[];
  readonly execution_history: readonly IDashboardExecutionHistoryItem[];
  readonly theme_forecasts: readonly IThemeForecastDisplayItem[];
  readonly expectation_gaps: readonly IExpectationGapDisplayItem[];
  readonly warnings: readonly string[];
  readonly sla: {
    readonly status: 'ready' | 'failed' | 'running' | 'waiting' | 'no_trace';
    readonly status_label: string;
    readonly failed_node: string | null;
    readonly failed_node_label: string | null;
    readonly error_message: string | null;
    readonly next_retry_at: string | null;
    readonly deadline_at: string;
  };
  readonly quality: {
    readonly recommendation_count: number;
    readonly effective_evidence_count: number;
    readonly l1_coverage: number;
    readonly schema_checked_count: number;
    readonly schema_mismatch_count: number;
    readonly schema_mismatch_rate: number;
    readonly timeliness_status: string;
    readonly execution_time: string | null;
  };
  readonly meta: {
    readonly trace_id: string;
    readonly batch_id: string | null;
    readonly run_fingerprint: string | null;
    readonly current_stage: string | null;
    readonly status: string | null;
    readonly started_at: string | null;
    readonly finished_at: string | null;
  };
}

export interface IThemeForecastDisplayItem {
  readonly theme: string;
  readonly direction: 'bullish' | 'bearish' | 'neutral';
  readonly probability: number;
  readonly horizon: number;
  readonly signal_strength: number;
  readonly expectation_gap: number;
  readonly related_symbols: readonly string[];
  readonly weak_signal: boolean;
  readonly reasons: readonly string[];
}

export interface IExpectationGapDisplayItem {
  readonly keyword: string;
  readonly graph_strength: number;
  readonly price_reaction: number;
  readonly expectation_gap: number;
  readonly is_weak_signal: boolean;
  readonly related_symbols: readonly string[];
  readonly reasons: readonly string[];
}

export interface IDashboardStockDetailPayload {
  readonly symbol: string;
  readonly stock_name: string;
  readonly industry: string;
  readonly rank: number;
  readonly stage: 'A' | 'B' | 'C';
  readonly total_score: number;
  readonly confidence: number;
  readonly trace_id: string;
  readonly strategy_id: string | null;
  readonly macro_mainline: string | null;
  readonly latest_close: number | null;
  readonly latest_trading_day: string | null;
  readonly live_quote: ILiveQuotePayload;
  readonly score_breakdown: {
    readonly evidence: number;
    readonly graph: number;
    readonly exposure: number;
    readonly market: number;
    readonly total_contribution: number;
    readonly evidence_count: number;
    readonly raw: Record<string, unknown>;
  };
  readonly why_this_stock: {
    readonly short: string;
    readonly detail: string;
  };
  readonly why_now: {
    readonly headline: string;
    readonly bullets: readonly string[];
    readonly tone: 'ready' | 'watch';
  };
  readonly trade_plan: {
    readonly buy_when: string;
    readonly buy_price_ref: number | null;
    readonly buy_price_range: readonly [number, number] | null;
    readonly stop_loss_price: number | null;
    readonly take_profit_range: readonly [number, number] | null;
    readonly sell_when: string;
  } | null;
  readonly market_confirmation: {
    readonly momentum5d_pct: number | null;
    readonly momentum20d_pct: number | null;
    readonly volume_ratio20d: number | null;
    readonly breakout20d: boolean;
    readonly volatility_compression: boolean;
    readonly recent_week_gain_exceeded: boolean;
    readonly reasons: readonly string[];
  };
  readonly falsification_conditions: readonly string[];
  readonly concept_tags: readonly string[];
  readonly ui_summary: IDashboardUiSummary;
}

export type LiveQuoteSource = 'tickflow' | 'yahoo_finance' | 'candle_fallback' | 'unavailable';

export type LiveQuoteStatus = 'LIVE' | 'FALLBACK' | 'UNAVAILABLE';

export interface ILiveQuotePayload {
  readonly price: number | null;
  readonly day_low: number | null;
  readonly day_high: number | null;
  readonly change_pct: number | null;
  readonly market_time: string | null;
  readonly source: LiveQuoteSource;
  readonly status: LiveQuoteStatus;
}

export interface ILiveQuoteReader {
  getQuotes: (symbols: readonly string[]) => Promise<ReadonlyMap<string, ILiveQuotePayload>>;
}

export interface IDashboardUiSummary {
  readonly decision: {
    readonly headline: string;
    readonly action_state: 'strong_buy' | 'watch_pullback' | 'observe' | 'avoid';
    readonly action_label: '强推荐' | '等待回踩' | '继续观察' | '暂不买入';
    readonly score_formula: string;
  };
  readonly buy_trigger: {
    readonly trigger_label: string;
    readonly buy_price_ref_label: string;
    readonly stop_loss_label: string;
    readonly position_label: string;
  };
  readonly why_stock: {
    readonly conclusion: string;
    readonly key_evidence: string;
    readonly mapping_reason: string;
    readonly risk_note: string;
  };
  readonly why_now: readonly {
    readonly label: string;
    readonly detail: string;
    readonly tone: 'positive' | 'neutral' | 'warning';
  }[];
  readonly primary_evidence: {
    readonly chain_id: string | null;
    readonly mapping_short: string;
    readonly mapping_explanation: string;
  };
  readonly system_health: {
    readonly data_updated_at: string | null;
    readonly schema_health_label: string;
    readonly pipeline_health_label: string;
  };
}

export interface IDashboardEvidenceChainItem {
  readonly chain_id: string;
  readonly news: {
    readonly news_id: string;
    readonly title: string;
    readonly source: string;
    readonly published_at: string;
    readonly url: string;
    readonly excerpt: string;
    readonly anchor_quote: string;
  };
  readonly signal: {
    readonly source_keyword: string | null;
    readonly asset_or_theme_keyword: string | null;
    readonly match_method: string | null;
    readonly match_confidence: number | null;
    readonly signal_reason: string;
  };
  readonly exposure: {
    readonly matched_exposure_keyword: string | null;
    readonly exposure_fact_id: string | null;
    readonly exposure_type: string | null;
    readonly exposure_label: string;
    readonly exposure_reason: string;
    readonly external_fact: {
      readonly source: string | null;
      readonly source_id: string | null;
      readonly source_name: string | null;
      readonly source_provider: string | null;
      readonly source_url: string | null;
      readonly observed_at: string | null;
      readonly updated_at?: string | null;
      readonly confidence: number | null;
      readonly evidence_text: string;
      readonly raw_field?: string | null;
      readonly exposure_type?: string | null;
      readonly sourceId?: string | null;
      readonly sourceName?: string | null;
      readonly exposureType?: string | null;
      readonly rawField?: string | null;
      readonly updatedAt?: string | null;
      readonly verification_status: 'verified_external' | 'historical_news' | 'missing_external_fact';
      readonly verification_label: string;
    };
  };
  readonly stock_link: {
    readonly symbol: string;
    readonly stock_name: string;
    readonly link_reason: string;
    readonly industry: string | null;
    readonly concept_tags: readonly string[];
  };
  readonly score: {
    readonly base_frequency_score: number;
    readonly time_decayed_score: number;
    readonly reprint_penalty_score: number;
    readonly final_contrib_score: number;
  };
}

export interface IDashboardEvidencePayload {
  readonly trace_id: string;
  readonly group_id: string;
  readonly symbol: string;
  readonly stock_name: string | null;
  readonly stats: {
    readonly effective_count: number;
    readonly total_count: number;
    readonly coverage: number;
    readonly average_confidence: number;
    readonly total_contribution: number;
  };
  readonly items: readonly IDashboardEvidenceChainItem[];
}

export interface IDashboardNetworkNode {
  readonly id: string;
  readonly label: string;
  readonly kind: 'stock' | 'theme' | 'keyword' | 'exposure' | 'industry';
  readonly polarity: 'positive' | 'neutral' | 'negative';
  readonly weight: number;
}

export interface IDashboardNetworkEdge {
  readonly source: string;
  readonly target: string;
  readonly label: string;
  readonly confidence: number;
  readonly source_type: '因果链' | '暴露映射' | '全局图谱';
}

export interface IDashboardNetworkPayload {
  readonly trace_id: string;
  readonly group_id: string;
  readonly symbol: string;
  readonly stock_name: string | null;
  readonly nodes: readonly IDashboardNetworkNode[];
  readonly edges: readonly IDashboardNetworkEdge[];
  readonly relations: readonly {
    readonly source: string;
    readonly relation: string;
    readonly target: string;
    readonly strength: number;
    readonly source_type: '因果链' | '暴露映射' | '全局图谱';
  }[];
  readonly related_theme_forecasts: readonly IThemeForecastDisplayItem[];
  readonly network_preview: {
    readonly explanation: string | null;
  };
}

export interface IStrategyConfigWeights {
  readonly evidence: number;
  readonly graph: number;
  readonly exposure: number;
  readonly market: number;
}

export interface IStrategyConfig {
  readonly limit: number;
  readonly maxPerSignalType: number;
  readonly maxPrice: number | null;
  readonly exclude688: boolean;
  readonly excludeST: boolean;
  readonly recent5dGainMaxPct: number | null;
  readonly minFinalScore: number | null;
  readonly minEvidenceScore: number | null;
  readonly minExposureScore: number | null;
  readonly minMarketScore: number | null;
  readonly includeSignalTypes: readonly string[];
  readonly excludeSignalTypes: readonly string[];
  readonly weights: IStrategyConfigWeights;
}

export interface IStrategyDefinitionRecord {
  readonly id: string;
  readonly cluster_key: string;
  readonly name: string;
  readonly description: string | null;
  readonly enabled: boolean;
  readonly config_json: IStrategyConfig;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_run_at: string | null;
  readonly last_status: string | null;
  readonly last_error_message: string | null;
}

export interface IStrategyProfitHorizonResult {
  readonly trading_day: string | null;
  readonly price: number | null;
  readonly return_pct: number | null;
  readonly status: 'LIVE' | 'FINAL' | 'PENDING' | 'NO_CURRENT_PRICE' | 'NO_BASE_PRICE';
  readonly price_source: LiveQuoteSource | 'settlement';
  readonly price_time: string | null;
  readonly settlement_note: string | null;
}

export interface IStrategyProfitHorizonSummary {
  readonly sample_count: number;
  readonly pending_count: number;
  readonly final_count: number;
  readonly avg_return_pct: number | null;
  readonly win_rate: number | null;
  readonly max_drawdown_pct: number | null;
}

export interface IStrategyProfitRow {
  readonly strategy_id: string;
  readonly strategy_name: string;
  readonly strategy_run_id: string;
  readonly trace_id: string;
  readonly execution_time: string | null;
  readonly trace_label: string;
  readonly cluster_key: string;
  readonly as_of: string;
  readonly rank: number;
  readonly symbol: string;
  readonly stock_name: string;
  readonly industry: string;
  readonly final_score: number;
  readonly score_breakdown: Record<string, unknown>;
  readonly reasons: readonly string[];
  readonly base_trading_day: string;
  readonly base_price: number;
  readonly current_trading_day: string | null;
  readonly current_price: number | null;
  readonly return_pct: number | null;
  readonly return_status: string;
  readonly recommendation_key: string;
  readonly horizons: {
    readonly live: IStrategyProfitHorizonResult;
    readonly t1: IStrategyProfitHorizonResult;
    readonly t3: IStrategyProfitHorizonResult;
    readonly t5: IStrategyProfitHorizonResult;
  };
}

export interface IStrategyProfitSummary {
  readonly strategy_id: string;
  readonly strategy_name: string;
  readonly run_count: number;
  readonly recommendation_count: number;
  readonly avg_return_pct: number | null;
  readonly median_return_pct: number | null;
  readonly win_rate: number | null;
  readonly top_return_pct: number | null;
  readonly worst_return_pct: number | null;
  readonly horizon_summaries: {
    readonly live: IStrategyProfitHorizonSummary;
    readonly t1: IStrategyProfitHorizonSummary;
    readonly t3: IStrategyProfitHorizonSummary;
    readonly t5: IStrategyProfitHorizonSummary;
  };
}

export interface IStrategyProfitPayload {
  readonly cluster_key: string;
  readonly as_of: string;
  readonly rows: readonly IStrategyProfitRow[];
  readonly summaries: readonly IStrategyProfitSummary[];
}

export interface IStrategyProfitQuery {
  readonly trace_id?: string | null;
  readonly strategy_id?: string | null;
  readonly symbol_query?: string | null;
  readonly return_status?: string | null;
  readonly sort_by?: 'execution_time' | 'rank' | 'live' | 't1' | 't3' | 't5' | null;
  readonly sort_order?: 'asc' | 'desc' | null;
}

export interface IContributionDetailQuery {
  readonly traceId: string;
  readonly symbol: string;
}

export interface IContributionDetailReader {
  getContributionDetail: (query: IContributionDetailQuery) => Promise<IContributionDetailPayload | null>;
  close?: () => Promise<void>;
}

export interface IDailyReportSnapshotQuery {
  readonly displayDate: string;
  readonly groupId: string;
}

export interface IDailyReportSnapshotReader {
  getDailyReport: (query: IDailyReportSnapshotQuery) => Promise<Record<string, unknown> | null>;
  close?: () => Promise<void>;
}

export interface IBackendArtifacts {
  readonly graphSnapshot: {
    readonly generatedAtBeijing: string;
    readonly sourceNewsFilePath: string;
    readonly graph: IFriendNetworkGraphSnapshot;
    readonly tree: IFriendNetworkTreeSnapshot;
    readonly aiDecisions: readonly unknown[];
  };
  readonly recommendationFile: {
    readonly generatedAtBeijing: string;
    readonly newsFilePath: string;
    readonly stockFilePath: string;
    readonly summary: {
      readonly keywordCount: number;
      readonly candidateCount: number;
      readonly totalRecommendations: number;
      readonly maxPerIndustry: number;
    };
    readonly recommendations: readonly {
      readonly symbol: string;
      readonly stockName: string;
      readonly industry: string;
      readonly score: number;
      readonly matchedSignals: readonly string[];
      readonly matchedBoards: readonly string[];
      readonly reasons: readonly string[];
      readonly scoreBreakdown: Record<string, number>;
    }[];
  };
  readonly stockPayload: ITempStockPayload;
}

export interface IBackendRuntimeStoreOptions {
  readonly rootDir: string;
  readonly configStore: IBackendConfigStore;
  readonly contributionReader?: IContributionDetailReader;
  readonly dailyReportReader?: IDailyReportSnapshotReader | null;
  readonly liveQuoteReader?: ILiveQuoteReader | null;
  readonly pgPool?: { query: <T>(sql: string, values?: readonly unknown[]) => Promise<{ rows: readonly T[] }> } | null;
}

export interface IDispatchDailyInput {
  readonly groupId: string;
  readonly targetDate: string;
}

export interface IMLRecommendationQuery {
  readonly tradeDate: string;
  readonly groupId: string;
  readonly topN: number;
  readonly forceRefresh: boolean;
}

export interface IStrategyPerformanceReportPayload {
  readonly id: string;
  readonly strategy_id: string;
  readonly strategy_name_snapshot: string;
  readonly cluster_key: string;
  readonly as_of: string;
  readonly win_rate: number | null;
  readonly profit_ratio: number | null;
  readonly avg_return_pct: number | null;
  readonly max_drawdown: number | null;
  readonly recommendation_count: number;
  readonly created_at: string;
}

