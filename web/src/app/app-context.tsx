import * as React from 'react';
import type { ClusterSummary, DispatchResponse, StrategyDefinition } from '@/lib/api-types';
import { api } from '@/lib/api';
import { todayDate } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';

const MAX_DISPATCH_POLL_ATTEMPTS = 900;

export interface PortfolioItem {
  ticker: string;
  name: string;
  created_at: string;
}

export interface DispatchInfo extends DispatchResponse {
  at: string;
}

export interface DispatchOutcome {
  trace_id: string;
  status: 'COMPLETED' | 'DEGRADED' | 'FAILED';
  finished_at: string;
  error_code?: string | null;
  error_message?: string | null;
}

interface AppShellContextValue {
  today: string;
  globalDate: string;
  activeClusterId: string;
  activeStrategyId: string;
  activeTraceId: string;
  clusters: ClusterSummary[];
  strategies: StrategyDefinition[];
  portfolio: PortfolioItem[];
  lastDispatch: DispatchInfo | null;
  lastDispatchOutcome: DispatchOutcome | null;
  setGlobalDate: (value: string) => void;
  setActiveClusterId: (value: string) => void;
  setActiveStrategyId: (value: string) => void;
  setActiveTraceId: (value: string) => void;
  refreshClusters: () => Promise<void>;
  refreshStrategies: () => Promise<void>;
  runGlobalAnalysis: () => Promise<void>;
  addToPortfolio: (item: { ticker: string; name: string }) => void;
  removeFromPortfolio: (ticker: string) => void;
}

const AppShellContext = React.createContext<AppShellContextValue | null>(null);

function readStorage(key: string, fallback = '') {
  try {
    return localStorage.getItem(key) ?? fallback;
  }
  catch {
    return fallback;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  }
  catch {
    // ignore storage failures
  }
}

function readJson<T>(key: string, fallback: T): T {
  const raw = readStorage(key);
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  }
  catch {
    return fallback;
  }
}

export function AppShellProvider({ children }: { children: React.ReactNode }) {
  const { toast } = useToast();
  const [globalDate, setGlobalDateState] = React.useState(() => readStorage('gupiao.globalDate', todayDate()));
  const [activeClusterId, setActiveClusterIdState] = React.useState(() => readStorage('gupiao.activeClusterId', 'main'));
  const [activeStrategyId, setActiveStrategyIdState] = React.useState(() => readStorage('gupiao.activeStrategyId', 'all'));
  const [activeTraceId, setActiveTraceIdState] = React.useState(() => readStorage('gupiao.activeTraceId', ''));
  const [clusters, setClusters] = React.useState<ClusterSummary[]>([]);
  const [strategies, setStrategies] = React.useState<StrategyDefinition[]>([]);
  const [portfolio, setPortfolio] = React.useState<PortfolioItem[]>(() => readJson('gupiao.portfolio.v1', []));
  const [lastDispatch, setLastDispatch] = React.useState<DispatchInfo | null>(null);
  const [lastDispatchOutcome, setLastDispatchOutcome] = React.useState<DispatchOutcome | null>(null);

  React.useEffect(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
    writeStorage('gupiao.theme', 'light');
  }, []);

  const setGlobalDate = React.useCallback((value: string) => {
    setGlobalDateState(value);
    writeStorage('gupiao.globalDate', value);
  }, []);

  const setActiveClusterId = React.useCallback((value: string) => {
    setActiveClusterIdState(value);
    writeStorage('gupiao.activeClusterId', value);
  }, []);

  const setActiveStrategyId = React.useCallback((value: string) => {
    const next = value || 'all';
    setActiveStrategyIdState(next);
    writeStorage('gupiao.activeStrategyId', next);
  }, []);

  const setActiveTraceId = React.useCallback((value: string) => {
    setActiveTraceIdState(value);
    writeStorage('gupiao.activeTraceId', value);
  }, []);

  const refreshClusters = React.useCallback(async () => {
    try {
      const rows = await api.listClusters();
      setClusters(rows);
      if (rows.length > 0 && !rows.some(row => row.id === activeClusterId)) {
        setActiveClusterId(rows[0]!.id);
      }
    }
    catch (error) {
      toast({ title: '读取集群失败', description: String(error), variant: 'destructive' });
    }
  }, [activeClusterId, setActiveClusterId, toast]);

  const refreshStrategies = React.useCallback(async () => {
    try {
      const payload = await api.listStrategies(activeClusterId);
      setStrategies(payload.items);
      if (activeStrategyId !== 'all' && !payload.items.some(item => item.id === activeStrategyId)) {
        setActiveStrategyId('all');
      }
    }
    catch (error) {
      setStrategies([]);
      setActiveStrategyId('all');
      toast({ title: '读取策略失败', description: String(error), variant: 'destructive' });
    }
  }, [activeClusterId, activeStrategyId, setActiveStrategyId, toast]);

  React.useEffect(() => {
    void refreshClusters();
  }, [refreshClusters]);

  React.useEffect(() => {
    void refreshStrategies();
  }, [refreshStrategies]);

  const runGlobalAnalysis = React.useCallback(async () => {
    try {
      const response = await api.dispatchDaily(activeClusterId, globalDate);
      setLastDispatch({ ...response, at: new Date().toISOString() });
      setActiveTraceId(response.trace_id);
      toast({ title: '推演已触发', description: response.trace_id });
      let attempts = 0;
      const poll = async () => {
        attempts += 1;
        const batch = await api.getBatchByTraceId(response.trace_id);
        if (batch.status === 'COMPLETED' || batch.status === 'DEGRADED' || batch.status === 'FAILED') {
          setLastDispatchOutcome({
            trace_id: response.trace_id,
            status: batch.status as DispatchOutcome['status'],
            finished_at: batch.finished_at ?? new Date().toISOString(),
            error_code: batch.error_code,
            error_message: batch.error_message,
          });
          return;
        }
        if (attempts < MAX_DISPATCH_POLL_ATTEMPTS) {
          window.setTimeout(() => void poll(), 2000);
        }
      };
      window.setTimeout(() => void poll(), 1200);
    }
    catch (error) {
      toast({ title: '推演失败', description: String(error), variant: 'destructive' });
    }
  }, [activeClusterId, globalDate, setActiveTraceId, toast]);

  const addToPortfolio = React.useCallback((item: { ticker: string; name: string }) => {
    setPortfolio((current) => {
      if (current.some(row => row.ticker === item.ticker)) {
        return current;
      }
      const next = [{ ticker: item.ticker, name: item.name, created_at: new Date().toISOString() }, ...current];
      writeStorage('gupiao.portfolio.v1', JSON.stringify(next));
      return next;
    });
  }, []);

  const removeFromPortfolio = React.useCallback((ticker: string) => {
    setPortfolio((current) => {
      const next = current.filter(item => item.ticker !== ticker);
      writeStorage('gupiao.portfolio.v1', JSON.stringify(next));
      return next;
    });
  }, []);

  const value = React.useMemo<AppShellContextValue>(() => ({
    today: todayDate(),
    globalDate,
    activeClusterId,
    activeStrategyId,
    activeTraceId,
    clusters,
    strategies,
    portfolio,
    lastDispatch,
    lastDispatchOutcome,
    setGlobalDate,
    setActiveClusterId,
    setActiveStrategyId,
    setActiveTraceId,
    refreshClusters,
    refreshStrategies,
    runGlobalAnalysis,
    addToPortfolio,
    removeFromPortfolio,
  }), [
    activeClusterId,
    activeStrategyId,
    activeTraceId,
    addToPortfolio,
    clusters,
    globalDate,
    lastDispatch,
    lastDispatchOutcome,
    portfolio,
    refreshClusters,
    refreshStrategies,
    removeFromPortfolio,
    runGlobalAnalysis,
    setActiveClusterId,
    setActiveStrategyId,
    setActiveTraceId,
    setGlobalDate,
    strategies,
  ]);

  return <AppShellContext.Provider value={value}>{children}</AppShellContext.Provider>;
}

export function useAppShell() {
  const context = React.useContext(AppShellContext);
  if (!context) {
    throw new Error('AppShellProvider is missing');
  }
  return context;
}
