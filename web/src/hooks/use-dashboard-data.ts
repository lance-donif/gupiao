import * as React from 'react';
import type {
  DashboardEvidencePayload,
  DashboardNetworkPayload,
  DashboardSnapshotPayload,
  DashboardStockDetailPayload,
} from '@/lib/api-types';
import { api } from '@/lib/api';

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const inflightCache = new Map<string, Promise<unknown>>();

async function cachedLoad<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const cached = inflightCache.get(key);
  if (cached) {
    return cached as Promise<T>;
  }
  const promise = loader().finally(() => {
    if (inflightCache.get(key) === promise) {
      inflightCache.delete(key);
    }
  });
  inflightCache.set(key, promise);
  return promise;
}

/**
 * @param cacheScope 缓存命名空间。不同接口即使deps 相同也必须传不同scope，
 *                   否则会共用同一个 inflight promise（曾导致"亲友网络"Tab 永远拿不到数据）。
 * @param deps       触发重新请求的业务依赖；loader 的闭包变量也必须在此列全。
 */
function useAsync<T>(
  cacheScope: string,
  loader: () => Promise<T>,
  deps: React.DependencyList,
  enabled = true,
): AsyncState<T> {
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadToken, setReloadToken] = React.useState(0);

  // 用 ref 持有最新 loader，避免把每次渲染的新闭包塞进依赖数组造成无限循环。
  const loaderRef = React.useRef(loader);
  loaderRef.current = loader;

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
    const cacheKey = JSON.stringify([cacheScope, ...deps, reloadToken]);
    cachedLoad(cacheKey, () => loaderRef.current())
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
  }, [cacheScope, enabled, reloadToken, ...deps]);

  const reload = React.useCallback(() => setReloadToken(value => value + 1), []);

  return { data, loading, error, reload };
}

export function useDashboardSnapshot(input: {
  groupId: string;
  displayDate: string;
  strategyId: string;
  refreshKey?: string | null;
}) {
  return useAsync<DashboardSnapshotPayload>(
    'dashboard-snapshot',
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
    'stock-detail',
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
    'stock-evidence',
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
    'stock-network',
    () => api.getDashboardStockNetwork(input.symbol ?? '', {
      trace_id: input.traceId,
      group_id: input.groupId,
    }),
    [input.symbol, input.traceId, input.groupId],
    Boolean(input.symbol && input.traceId),
  );
}