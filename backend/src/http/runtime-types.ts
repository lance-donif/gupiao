import type { BackendConfigCategory } from './types.js';

export type BatchStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'DEGRADED';
export type GraphKind = 'execution' | 'causal';

export interface IRuntimeNode {
  readonly node_id: string;
  readonly node_label: string;
  readonly sequence_no: number;
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  readonly total_count: number;
  readonly current_index: number;
  readonly current_label: string;
  readonly has_result: boolean;
  readonly started_at: string | null;
  readonly updated_at: string | null;
  readonly finished_at: string | null;
}

export interface IRuntimeBatchRecord {
  readonly id: string;
  readonly group_id: string;
  readonly group_version_id: string;
  readonly target_trading_date: string;
  readonly status: BatchStatus;
  readonly trace_id: string;
  readonly run_fingerprint: string;
  readonly enqueued_at: number;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly graph_done: boolean;
  readonly chroma_done: boolean;
  readonly market_cached_done: boolean;
  readonly schema_checked_count: number;
  readonly schema_mismatch_count: number;
  readonly schema_mismatch_rate: number;
  readonly promote_blocked_by_quality: boolean;
  readonly quality_warnings_json: string;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly progress_percent: number;
  readonly current_stage: string;
  readonly current_stage_index: number;
  readonly remaining_node_count: number;
  readonly nodes: readonly IRuntimeNode[];
  readonly created_at: string;
}

export interface IClusterSummaryRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly active_version_id: string | null;
  readonly active_version: number | null;
  readonly last_batch_status: string | null;
  readonly last_target_trading_date: string | null;
  readonly updated_at: string;
}

export type ClusterLifecycleStatus = '待反馈' | '待确认' | '已升级' | '可回滚' | '已回滚' | '失败';

// 当前先落在 runtime JSON store，后续可平移到数据库表，字段名保持业务含义稳定。
export interface IClusterVersionRecord {
  readonly id: string;
  readonly group_id: string;
  readonly version: number;
  readonly prompts_dir: string;
  readonly created_at: string | null;
  readonly status: ClusterLifecycleStatus;
  readonly source_feedback_id: string | null;
  readonly source_feedback_reason: string | null;
  readonly confirmed_by: string | null;
  readonly confirmed_at: string | null;
  readonly previous_version_id: string | null;
}

export interface IClusterFeedbackRecord {
  readonly id: string;
  readonly group_id: string;
  readonly group_version_id: string;
  readonly display_date: string;
  readonly ticker: string;
  readonly score: number;
  readonly reason: string | null;
  readonly trace_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted: boolean;
  readonly status: ClusterLifecycleStatus;
}

export interface IClusterRollbackRecord {
  readonly id: string;
  readonly group_id: string;
  readonly from_version_id: string;
  readonly to_version_id: string;
  readonly reason: string;
  readonly trace_id: string;
  readonly created_at: string;
  readonly status: ClusterLifecycleStatus;
}

export interface ITraceStepRecord {
  readonly id: number;
  readonly trace_id: string;
  readonly batch_id: string | null;
  readonly group_id: string | null;
  readonly flow: string;
  readonly node_name: string;
  readonly sequence_no: number;
  readonly status: string;
  readonly error_code: string | null;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly duration_ms: number;
  readonly input_snapshot: Record<string, unknown>;
  readonly output_snapshot: Record<string, unknown>;
  readonly delta_snapshot: Record<string, unknown>;
  readonly metrics: Record<string, unknown>;
  readonly drift_report: {
    readonly layer_level: number;
    readonly new_entities: readonly string[];
    readonly disappeared_entities: readonly string[];
    readonly polarity_flips: readonly unknown[][];
    readonly relation_shifts: readonly unknown[][];
    readonly drift_count: number;
  };
}

export interface ITraceEventRecord {
  readonly id: number;
  readonly trace_id: string;
  readonly batch_id: string | null;
  readonly group_id: string | null;
  readonly sequence_no: number;
  readonly event_type: string;
  readonly level: string;
  readonly payload: Record<string, unknown>;
  readonly created_at: string;
}

export interface ITraceCostRowRecord {
  readonly role: string;
  readonly model: string;
  readonly provider: string;
  readonly calls: number;
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  readonly cost_usd: number;
  readonly budget_exceeded_calls: number;
  readonly degraded_calls: number;
}

export interface ITraceRecord {
  readonly trace_id: string;
  readonly batch_id: string;
  readonly group_id: string;
  readonly status: string;
  readonly latest_phase: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly budget_usd: number;
  readonly budget_exceeded: boolean;
  readonly steps: readonly ITraceStepRecord[];
  readonly events: readonly ITraceEventRecord[];
  readonly costs: readonly ITraceCostRowRecord[];
}

export interface INodeResultSummaryCard {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

export interface INodeResultSection {
  readonly key: string;
  readonly label: string;
  readonly kind: 'scalar' | 'object' | 'list';
  readonly total_count: number;
  readonly page: number;
  readonly page_size: number;
  readonly has_more: boolean;
  readonly items: readonly Record<string, unknown>[];
  readonly fields: Record<string, unknown>;
}

export interface INodeResultPayload {
  readonly batch_id: string;
  readonly node_id: string;
  readonly node_label: string;
  readonly status: string;
  readonly source: 'node_snapshot';
  readonly summary_cards: readonly INodeResultSummaryCard[];
  readonly sections: readonly INodeResultSection[];
}

export interface IHorizonPolicyRecord {
  readonly default_horizon: string;
  readonly horizon_profiles: Record<string, Record<string, unknown>>;
}

export interface IAutopilotPolicyRecord {
  readonly enabled: boolean;
  readonly kill_switch: boolean;
  readonly promote_consecutive_days: number;
  readonly rollback_cooldown_days: number;
  readonly guard_consecutive_fail_days: number;
  readonly guard_window_days: number;
  readonly slo_p95_budget_ms: number;
}

export interface IWhatIfHistoryItemRecord {
  readonly id: string;
  readonly group_id: string;
  readonly query: string;
  readonly cutoff_date: string;
  readonly max_hops: number;
  readonly max_items: number;
  readonly hit_count: number;
  readonly top_symbols: readonly string[];
  readonly warnings: readonly string[];
  readonly hint: string | null;
  readonly created_at: string;
}

export interface IRuntimeSnapshot {
  readonly version: 2;
  readonly clusters: readonly IClusterSummaryRecord[];
  readonly batches: readonly IRuntimeBatchRecord[];
  readonly traces: Record<string, ITraceRecord>;
  readonly node_results: Record<string, Record<string, INodeResultPayload>>;
  readonly cluster_versions: readonly IClusterVersionRecord[];
  readonly cluster_feedback: readonly IClusterFeedbackRecord[];
  readonly cluster_rollbacks: readonly IClusterRollbackRecord[];
  readonly horizon_policies: Record<string, IHorizonPolicyRecord>;
  readonly autopilot_policies: Record<string, IAutopilotPolicyRecord>;
  readonly whatif_history: readonly IWhatIfHistoryItemRecord[];
}

export interface IInteractionLatencyPayload {
  readonly interaction: string;
  readonly duration_ms: number;
  readonly group_id?: string | null;
  readonly trade_date?: string | null;
  readonly ok: boolean;
}

export interface IRuntimeServerOptions {
  readonly rootDir: string;
  readonly port?: number;
  readonly host?: string;
  readonly configStoreOptions?: {
    readonly category?: BackendConfigCategory;
  };
}
