import * as React from 'react';
import type { ClusterSummary, StrategyDefinition } from '@/lib/api-types';
import { api } from '@/lib/api';
import { todayDate } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';
import { pollDispatchUntilTerminal, type DispatchOutcome, type PollHandle } from '@/app/dispatch-poller';

export type { DispatchOutcome };

interface AppShellContextValue {
  globalDate: string;
  activeClusterId: string;
  activeStrategyId: string;
  clusters: ClusterSummary[];
  strategies: StrategyDefinition[];
  lastDispatchOutcome: DispatchOutcome | null;
  setGlobalDate: (value: string) => void;
  setActiveClusterId: (value: string) => void;
  setActiveStrategyId: (value: string) => void;
  setActiveTraceId: (value: string) => void;
  refreshStrategies: () => Promise<void>;
  runGlobalAnalysis: () => Promise<void>;
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

export function AppShellProvider({ children }: { children: React.ReactNode }) {
  const { toast } = useToast();
  const [globalDate, setGlobalDateState] = React.useState(() => readStorage('gupiao.globalDate', todayDate()));
  const [activeClusterId, setActiveClusterIdState] = React.useState(() => readStorage('gupiao.activeClusterId', 'main'));
  const [activeStrategyId, setActiveStrategyIdState] = React.useState(() => readStorage('gupiao.activeStrategyId', 'all'));
  const [clusters, setClusters] = React.useState<ClusterSummary[]>([]);
  const [strategies, setStrategies] = React.useState<StrategyDefinition[]>([]);
  const [lastDispatchOutcome, setLastDispatchOutcome] = React.useState<DispatchOutcome | null>(null);

  const activeTraceIdRef = React.useRef(readStorage('gupiao.activeTraceId', ''));
  const pollRef = React.useRef<PollHandle | null>(null);

  // 组件卸载时必须停掉轮询，否则会对已卸载的 Provider 持续 setState。
  React.useEffect(() => () => pollRef.current?.cancel(), []);

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

  // 只写 localStorage：activeTraceId 不再暴露为 context 字段
  // （页面均无消费），Dashboard 通过 URL 参数自行管理 trace。
  const setActiveTraceId = React.useCallback((value: string) => {
    activeTraceIdRef.current = value;
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
      setActiveTraceId(response.trace_id);
      toast({ title: '推演已触发', description: response.trace_id });

      // 同一时刻只保留一个轮询，重复点击时取消旧的。
      pollRef.current?.cancel();
      pollRef.current = pollDispatchUntilTerminal({
        traceId: response.trace_id,
        onSettled: setLastDispatchOutcome,
        onError: message => toast({ title: '推演状态查询失败', description: message, variant: 'destructive' }),
        onTimeout: () => toast({
          title: '推演仍在进行',
          description: '30 分钟内未返回终态，可稍后刷新页面查看结果',
          variant: 'destructive',
        }),
      });
    }
    catch (error) {
      toast({ title: '推演失败', description: String(error), variant: 'destructive' });
    }
  }, [activeClusterId, globalDate, setActiveTraceId, toast]);

  const value = React.useMemo<AppShellContextValue>(() => ({
    globalDate,
    activeClusterId,
    activeStrategyId,
    clusters,
    strategies,
    lastDispatchOutcome,
    setGlobalDate,
    setActiveClusterId,
    setActiveStrategyId,
    setActiveTraceId,
    refreshStrategies,
    runGlobalAnalysis,
  }), [
    activeClusterId,
    activeStrategyId,
    clusters,
    globalDate,
    lastDispatchOutcome,
    refreshStrategies,
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