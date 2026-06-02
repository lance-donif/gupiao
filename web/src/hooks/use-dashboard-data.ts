import * as React from 'react';
import type {
  BatchProgress,
  DashboardEvidencePayload,
  DashboardNetworkPayload,
  DashboardSnapshotPayload,
  DashboardStockDetailPayload,
  TraceCostOut,
  TraceEvent,
  TraceOverview,
  TracePage,
  TraceStep,
} from '@/lib/api-types';
import { api } from '@/lib/api';

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

function useAsync<T>(loader: () => Promise<T>, deps: React.DependencyList, enabled = true): AsyncState<T> {
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadToken, setReloadToken] = React.useState(0);

  React.useEffect(() => {
    if (!enabled) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    loader()
      .then((payload) => {
        if (!controller.signal.aborted) {
          setData(payload);
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setError(String(caught));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [...deps, enabled, reloadToken]);

  return {
    data,
    loading,
    error,
    reload: () => setReloadToken(value => value + 1),
  };
}

export function useDashboardSnapshot(input: {
  groupId: string;
  displayDate: string;
  strategyId: string;
  refreshKey?: string | null;
}) {
  return useAsync<DashboardSnapshotPayload>(
    () => api.getDashboardSnapshot({
      group_id: input.groupId,
      display_date: input.displayDate,
      strategy_id: input.strategyId,
    }),
    [input.groupId, input.displayDate, input.strategyId, input.refreshKey],
  );
}

export function useStockDetail(input: { symbol: string | null; traceId: string; groupId: string; strategyId: string }) {
  return useAsync<DashboardStockDetailPayload>(
    () => api.getDashboardStockDetail(input.symbol ?? '', {
      trace_id: input.traceId,
      group_id: input.groupId,
      strategy_id: input.strategyId,
    }),
    [input.symbol, input.traceId, input.groupId, input.strategyId],
    Boolean(input.symbol && input.traceId),
  );
}

export function useStockEvidence(input: { symbol: string | null; traceId: string; groupId: string }) {
  return useAsync<DashboardEvidencePayload>(
    () => api.getDashboardStockEvidence(input.symbol ?? '', {
      trace_id: input.traceId,
      group_id: input.groupId,
    }),
    [input.symbol, input.traceId, input.groupId],
    Boolean(input.symbol && input.traceId),
  );
}

export function useStockNetwork(input: { symbol: string | null; traceId: string; groupId: string }) {
  return useAsync<DashboardNetworkPayload>(
    () => api.getDashboardStockNetwork(input.symbol ?? '', {
      trace_id: input.traceId,
      group_id: input.groupId,
    }),
    [input.symbol, input.traceId, input.groupId],
    Boolean(input.symbol && input.traceId),
  );
}

export function useBatchProgress(input: { groupId: string; displayDate: string }) {
  return useAsync<BatchProgress | null>(
    () => api.getLatestBatchProgress(input.groupId, input.displayDate),
    [input.groupId, input.displayDate],
  );
}

export function useTraceDetail(traceId: string) {
  const overview = useAsync<TraceOverview>(
    () => api.getTraceOverview(traceId),
    [traceId],
    Boolean(traceId),
  );
  const steps = useAsync<TracePage<TraceStep>>(
    () => api.getTraceSteps(traceId, undefined, 200),
    [traceId],
    Boolean(traceId),
  );
  const events = useAsync<TracePage<TraceEvent>>(
    () => api.getTraceEvents(traceId, undefined, 200),
    [traceId],
    Boolean(traceId),
  );
  const costs = useAsync<TraceCostOut>(
    () => api.getTraceCosts(traceId),
    [traceId],
    Boolean(traceId),
  );
  return { overview, steps, events, costs };
}
