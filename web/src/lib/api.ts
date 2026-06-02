import type {
  BatchBrief,
  BatchNodeResult,
  BatchProgress,
  ClusterFeedback,
  ClusterSummary,
  ClusterVersion,
  ConfigCategory,
  ConfigItem,
  ContributionDetailPayload,
  DailyReportPayload,
  DashboardEvidencePayload,
  DashboardNetworkPayload,
  DashboardSnapshotPayload,
  DashboardStockDetailPayload,
  DispatchResponse,
  GraphOut,
  MetricsOverview,
  PromotePreflightResponse,
  RealtimeQuote,
  RuntimeGraphOut,
  StrategyConfig,
  StrategyDefinition,
  StrategyProfitPayload,
  TraceCostOut,
  TraceEvent,
  TraceOverview,
  TracePage,
  TraceStep,
} from './api-types';

export type * from './api-types';

export function startPerceivedInteraction(input: {
  interaction: string;
  group_id?: string | null;
  trade_date?: string | null;
}) {
  const startedAt = performance.now();
  return {
    async complete(ok: boolean) {
      await http('/api/metrics/latency/interactions', {
        method: 'POST',
        body: JSON.stringify({
          interaction: input.interaction,
          group_id: input.group_id ?? null,
          trade_date: input.trade_date ?? null,
          duration_ms: Math.round(performance.now() - startedAt),
          ok,
        }),
      });
    },
  };
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status} ${resp.statusText}: ${text}`);
  }
  return (await resp.json()) as T;
}

export const api = {
  dispatchDaily(group_id: string, target_date?: string) {
    return http<DispatchResponse>('/api/dispatch/daily', {
      method: 'POST',
      body: JSON.stringify({ group_id, target_date: target_date || null }),
    });
  },
  listBatches(limit = 20) {
    return http<BatchBrief[]>(`/api/batches?limit=${limit}`);
  },
  getBatchByTraceId(trace_id: string) {
    return http<BatchBrief>(`/api/batches/by-trace/${encodeURIComponent(trace_id)}`);
  },
  getLatestBatchByGroup(group_id: string, target_date?: string | null) {
    const qs = new URLSearchParams();
    if (target_date) {
      qs.set('target_date', target_date);
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return http<BatchBrief | null>(`/api/batches/latest/${encodeURIComponent(group_id)}${suffix}`);
  },
  getLatestBatchProgress(group_id: string, target_date?: string | null) {
    const qs = new URLSearchParams();
    if (target_date) {
      qs.set('target_date', target_date);
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return http<BatchProgress | null>(
      `/api/batches/latest/${encodeURIComponent(group_id)}/progress${suffix}`,
    );
  },
  getBatchNodeResult(
    batch_id: string,
    node_id: string,
    section?: string,
    page = 1,
    page_size = 20,
  ) {
    const qs = new URLSearchParams();
    if (section) {
      qs.set('section', section);
    }
    qs.set('page', String(page));
    qs.set('page_size', String(page_size));
    return http<BatchNodeResult>(
      `/api/batches/${encodeURIComponent(batch_id)}/nodes/${encodeURIComponent(node_id)}/result?${qs.toString()}`,
    );
  },
  getContributionDetail(traceId: string, symbol: string) {
    const qs = new URLSearchParams({ traceId, symbol });
    return http<ContributionDetailPayload>(`/api/batches/contribution?${qs.toString()}`);
  },
  getDailyReport(display_date: string, group_id = 'main') {
    const qs = new URLSearchParams({ display_date, group_id });
    return http<DailyReportPayload>(`/api/report/daily?${qs.toString()}`);
  },
  getDashboardSnapshot(params: { group_id: string; display_date: string; strategy_id?: string | null }) {
    const qs = new URLSearchParams({
      group_id: params.group_id,
      display_date: params.display_date,
    });
    if (params.strategy_id && params.strategy_id !== 'all') {
      qs.set('strategy_id', params.strategy_id);
    }
    return http<DashboardSnapshotPayload>(`/api/dashboard/snapshot?${qs.toString()}`);
  },
  getDashboardStockDetail(symbol: string, params: { trace_id: string; group_id: string; strategy_id?: string | null }) {
    const qs = new URLSearchParams({
      trace_id: params.trace_id,
      group_id: params.group_id,
    });
    if (params.strategy_id && params.strategy_id !== 'all') {
      qs.set('strategy_id', params.strategy_id);
    }
    return http<DashboardStockDetailPayload>(
      `/api/dashboard/stocks/${encodeURIComponent(symbol)}/detail?${qs.toString()}`,
    );
  },
  getDashboardStockEvidence(symbol: string, params: { trace_id: string; group_id: string }) {
    const qs = new URLSearchParams({
      trace_id: params.trace_id,
      group_id: params.group_id,
    });
    return http<DashboardEvidencePayload>(
      `/api/dashboard/stocks/${encodeURIComponent(symbol)}/evidence?${qs.toString()}`,
    );
  },
  getDashboardStockNetwork(symbol: string, params: { trace_id: string; group_id: string }) {
    const qs = new URLSearchParams({
      trace_id: params.trace_id,
      group_id: params.group_id,
    });
    return http<DashboardNetworkPayload>(
      `/api/dashboard/stocks/${encodeURIComponent(symbol)}/network?${qs.toString()}`,
    );
  },
  listClusters() {
    return http<ClusterSummary[]>('/api/cluster/list');
  },
  listClusterVersions(group_id = 'main') {
    const qs = new URLSearchParams({ group_id });
    return http<ClusterVersion[]>(`/api/cluster/versions?${qs.toString()}`);
  },
  listClusterFeedback(group_id: string, display_date: string) {
    const qs = new URLSearchParams({ group_id, display_date });
    return http<ClusterFeedback[]>(`/api/cluster/feedback?${qs.toString()}`);
  },
  saveClusterFeedback(payload: {
    group_id: string;
    group_version_id: string;
    display_date: string;
    ticker: string;
    score: number;
    reason?: string | null;
    trace_id?: string;
  }) {
    return http<ClusterFeedback>('/api/cluster/feedback', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  rollbackCluster(payload: {
    group_id: string;
    target_group_version_id: string;
    reason: string;
    trace_id?: string;
  }) {
    return http<{
      trace_id: string;
      group_id: string;
      old_version_id: string | null;
      target_group_version_id: string;
      status: string;
    }>('/api/cluster/rollback', { method: 'POST', body: JSON.stringify(payload) });
  },
  promoteCluster(payload: { group_id: string; reason?: string | null }) {
    return http<{ trace_id: string; celery_task_id: string }>('/api/cluster/promote', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  promotePreflight(params: { group_id?: string; cluster_id?: string }) {
    const qs = new URLSearchParams();
    if (params.group_id) {
      qs.set('group_id', params.group_id);
    }
    if (params.cluster_id) {
      qs.set('cluster_id', params.cluster_id);
    }
    return http<PromotePreflightResponse>(`/api/cluster/promote/preflight?${qs.toString()}`);
  },
  getGraph(
    cutoff_date: string,
    group_id = 'main',
    max_depth = 3,
    max_nodes = 200,
    signal?: AbortSignal,
  ) {
    const qs = new URLSearchParams({
      group_id,
      cutoff_date,
      max_depth: String(max_depth),
      max_nodes: String(max_nodes),
    });
    return http<GraphOut>(`/api/graph?${qs.toString()}`, { signal });
  },
  metricsOverview() {
    return http<MetricsOverview>('/metrics/overview');
  },
  getStockRealtimeQuote(ticker: string) {
    return http<RealtimeQuote>(
      `/api/ml-recommendations/stocks/${encodeURIComponent(ticker)}/realtime`,
    );
  },
  getTraceOverview(traceId: string) {
    return http<TraceOverview>(`/api/trace/${encodeURIComponent(traceId)}/overview`);
  },
  getTraceSteps(traceId: string, cursor?: number, limit = 200) {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (cursor !== undefined) {
      qs.set('cursor', String(cursor));
    }
    return http<TracePage<TraceStep>>(`/api/trace/${encodeURIComponent(traceId)}/steps?${qs.toString()}`);
  },
  getTraceEvents(traceId: string, cursor?: number, limit = 500) {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (cursor !== undefined) {
      qs.set('cursor', String(cursor));
    }
    return http<TracePage<TraceEvent>>(`/api/trace/${encodeURIComponent(traceId)}/events?${qs.toString()}`);
  },
  getTraceCosts(traceId: string) {
    return http<TraceCostOut>(`/api/trace/${encodeURIComponent(traceId)}/llm-costs`);
  },
  getExecutionGraph(traceId: string, maxNodes = 2000) {
    return http<RuntimeGraphOut>(
      `/api/graph/execution?trace_id=${encodeURIComponent(traceId)}&max_nodes=${maxNodes}`,
    );
  },
  getCausalGraph(traceId: string, maxNodes = 2000) {
    return http<RuntimeGraphOut>(
      `/api/graph/causal?trace_id=${encodeURIComponent(traceId)}&max_nodes=${maxNodes}`,
    );
  },
  createTraceEventSource(traceId: string, lastEventId?: number) {
    const qs = new URLSearchParams();
    if (lastEventId !== undefined) {
      qs.set('last_event_id', String(lastEventId));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return new EventSource(`/api/trace/${encodeURIComponent(traceId)}/stream${suffix}`);
  },
  listConfigByCategory(category: ConfigCategory) {
    return http<{ items: ConfigItem[] }>(`/api/config/${encodeURIComponent(category)}`);
  },
  updateConfig(key: string, value: string) {
    return http<{ key: string; value: string; message: string }>(
      `/api/config/${encodeURIComponent(key)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ value }),
      },
    );
  },
  listStrategies(group_id = 'main') {
    const qs = new URLSearchParams({ group_id });
    return http<{ items: StrategyDefinition[] }>(`/api/strategy/definitions?${qs.toString()}`);
  },
  createStrategy(payload: {
    group_id: string;
    name: string;
    description?: string | null;
    enabled?: boolean;
    config_json?: Partial<StrategyConfig>;
  }) {
    return http<StrategyDefinition>('/api/strategy/definitions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  updateStrategy(strategy_id: string, payload: {
    group_id: string;
    name?: string;
    description?: string | null;
    enabled?: boolean;
    config_json?: Partial<StrategyConfig>;
  }) {
    return http<StrategyDefinition>(`/api/strategy/definitions/${encodeURIComponent(strategy_id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },
  copyStrategy(strategy_id: string, payload: {
    group_id: string;
    name?: string;
    description?: string | null;
    enabled?: boolean;
  }) {
    return http<StrategyDefinition>(`/api/strategy/definitions/${encodeURIComponent(strategy_id)}/copy`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  deleteStrategy(strategy_id: string, group_id = 'main') {
    const qs = new URLSearchParams({ group_id });
    return http<{ id: string; deleted: boolean }>(
      `/api/strategy/definitions/${encodeURIComponent(strategy_id)}?${qs.toString()}`,
      { method: 'DELETE' },
    );
  },
  getStrategyProfits(group_id: string, as_of: string, options?: {
    trace_id?: string | null;
    strategy_id?: string | null;
    symbol_query?: string | null;
    return_status?: string | null;
    sort_by?: 'execution_time' | 'rank' | 'live' | 't1' | 't3' | 't5' | null;
    sort_order?: 'asc' | 'desc' | null;
  } | string | null) {
    const qs = new URLSearchParams({ group_id, as_of });
    const params = typeof options === 'string' || options === null
      ? { trace_id: options ?? null }
      : options ?? {};
    if (params.trace_id) {
      qs.set('trace_id', params.trace_id);
    }
    if (params.strategy_id && params.strategy_id !== 'all') {
      qs.set('strategy_id', params.strategy_id);
    }
    if (params.symbol_query?.trim()) {
      qs.set('symbol_query', params.symbol_query.trim());
    }
    if (params.return_status && params.return_status !== 'all') {
      qs.set('return_status', params.return_status);
    }
    if (params.sort_by) {
      qs.set('sort_by', params.sort_by);
    }
    if (params.sort_order) {
      qs.set('sort_order', params.sort_order);
    }
    return http<StrategyProfitPayload>(`/api/strategy/profits?${qs.toString()}`);
  },
};
