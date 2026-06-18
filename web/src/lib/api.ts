import type {
  BatchBrief,
  BatchProgress,
  ClusterSummary,
  DashboardEvidencePayload,
  DashboardNetworkPayload,
  DashboardSnapshotPayload,
  DashboardStockDetailPayload,
  DispatchResponse,
  StrategyConfig,
  StrategyDefinition,
  StrategyPerformanceReport,
  StrategyProfitPayload,
} from './api-types';

export type * from './api-types';

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
  getBatchByTraceId(trace_id: string) {
    return http<BatchBrief>(`/api/batches/by-trace/${encodeURIComponent(trace_id)}`);
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
  getStrategyPerformanceReports(group_id: string, strategy_id?: string | null, limit?: number) {
    const qs = new URLSearchParams({ group_id });
    if (strategy_id && strategy_id !== 'all') {
      qs.set('strategy_id', strategy_id);
    }
    if (limit && Number.isInteger(limit) && limit > 0) {
      qs.set('limit', String(limit));
    }
    return http<StrategyPerformanceReport[]>(`/api/strategy/performance-reports?${qs.toString()}`);
  },
};
