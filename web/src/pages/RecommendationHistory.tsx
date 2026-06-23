import * as React from 'react';
import { ArrowDownUp, RefreshCw } from 'lucide-react';
import { useAppShell } from '@/app/app-context';
import { Button } from '@/components/ui/button';
import { CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { StrategyProfitPayload, StrategyProfitRow } from '@/lib/api-types';
import { cn, formatMinute, formatPercent } from '@/lib/utils';

const HORIZONS: Array<['live' | 't1' | 't3' | 't5', string]> = [
  ['live', 'LIVE'],
  ['t1', 'T+1'],
  ['t3', 'T+3'],
  ['t5', 'T+5'],
];

const HORIZON_STATUS_LABELS: Record<string, string> = {
  LIVE: '实时',
  FINAL: '已结算',
  PENDING: '待结算',
  NO_CURRENT_PRICE: '缺少现价',
  NO_BASE_PRICE: '缺少基准价',
};

type SortBy = 'execution_time' | 'rank' | 'live' | 't1' | 't3' | 't5';
type SortOrder = 'asc' | 'desc';

export default function RecommendationHistoryPage() {
  const ctx = useAppShell();
  const { toast } = useToast();
  const [loading, setLoading] = React.useState(false);
  const [profits, setProfits] = React.useState<StrategyProfitPayload | null>(null);
  const [tradeDate, setTradeDate] = React.useState(ctx.globalDate);
  const [strategyId, setStrategyId] = React.useState(ctx.activeStrategyId);
  const [traceId, setTraceId] = React.useState('');
  const [symbolQuery, setSymbolQuery] = React.useState('');
  const [returnStatus, setReturnStatus] = React.useState('all');
  const [sortBy, setSortBy] = React.useState<SortBy>('execution_time');
  const [sortOrder, setSortOrder] = React.useState<SortOrder>('desc');
  const deferredSymbolQuery = React.useDeferredValue(symbolQuery);

  React.useEffect(() => {
    setTradeDate(ctx.globalDate);
  }, [ctx.globalDate]);

  React.useEffect(() => {
    setStrategyId(ctx.activeStrategyId);
  }, [ctx.activeStrategyId]);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const payload = await api.getStrategyProfits(ctx.activeClusterId, tradeDate, {
        strategy_id: strategyId,
        trace_id: traceId.trim() || null,
        symbol_query: deferredSymbolQuery.trim() || null,
        return_status: returnStatus,
        sort_by: sortBy,
        sort_order: sortOrder,
      });
      setProfits(payload);
    } catch (error) {
      toast({ title: '读取历史推荐失败', description: String(error), variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [
    ctx.activeClusterId,
    deferredSymbolQuery,
    returnStatus,
    sortBy,
    sortOrder,
    strategyId,
    toast,
    traceId,
    tradeDate,
  ]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const rows = profits?.rows ?? [];
  const settledReturns = rows.flatMap((row) => {
    return (['t1', 't3', 't5'] as const)
      .map((key) => row.horizons?.[key]?.return_pct ?? null)
      .filter((value): value is number => value !== null);
  });

  return (
    <div className="page-workbench grid min-h-[calc(100vh-48px)] grid-cols-[minmax(0,1fr)] gap-3 overflow-auto p-3 xl:h-[calc(100vh-48px)] xl:overflow-hidden">
      <section className="workstation-panel-strong flex min-h-0 flex-col rounded-2xl">
        <div className="flex h-auto min-h-14 shrink-0 flex-col gap-3 border-b border-border/70 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-[18px] font-semibold leading-6">历史推荐</h1>
            <p className="number-figure text-[12px] leading-4 text-muted-foreground">
              保留同一天全部执行记录 · {tradeDate}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            className="w-full lg:w-auto"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            刷新
          </Button>
        </div>
        <div className="border-b border-border/70 p-3">
          <div className="workstation-sunken grid shrink-0 gap-2 rounded-xl p-2 sm:grid-cols-2 xl:grid-cols-[140px_160px_minmax(150px,1fr)_minmax(150px,1fr)_150px_150px_96px]">
            <Input
              type="date"
              value={tradeDate}
              onChange={(event) => setTradeDate(event.target.value)}
              className="number-figure h-8 text-[12px]"
            />
            <Select value={strategyId} onValueChange={setStrategyId}>
              <SelectTrigger className="h-8 text-[12px]">
                <SelectValue placeholder="全部策略" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-[12px]">
                  全部策略
                </SelectItem>
                {ctx.strategies.map((strategy) => (
                  <SelectItem key={strategy.id} value={strategy.id} className="text-[12px]">
                    {strategy.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={traceId}
              onChange={(event) => setTraceId(event.target.value)}
              placeholder="执行批次 / Trace"
              className="h-8 text-[12px]"
            />
            <Input
              value={symbolQuery}
              onChange={(event) => setSymbolQuery(event.target.value)}
              placeholder="股票代码或名称"
              className="h-8 text-[12px]"
            />
            <Select value={returnStatus} onValueChange={setReturnStatus}>
              <SelectTrigger className="h-8 text-[12px]">
                <SelectValue placeholder="收益状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-[12px]">
                  全部状态
                </SelectItem>
                <SelectItem value="gain" className="text-[12px]">
                  LIVE 盈利
                </SelectItem>
                <SelectItem value="loss" className="text-[12px]">
                  LIVE 亏损
                </SelectItem>
                <SelectItem value="LIVE" className="text-[12px]">
                  实时可算
                </SelectItem>
                <SelectItem value="FINAL" className="text-[12px]">
                  已结算
                </SelectItem>
                <SelectItem value="PENDING" className="text-[12px]">
                  待结算
                </SelectItem>
                <SelectItem value="NO_CURRENT_PRICE" className="text-[12px]">
                  缺少现价
                </SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortBy} onValueChange={(value) => setSortBy(value as SortBy)}>
              <SelectTrigger className="h-8 text-[12px]">
                <SelectValue placeholder="排序" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="execution_time" className="text-[12px]">
                  执行时间
                </SelectItem>
                <SelectItem value="rank" className="text-[12px]">
                  排名
                </SelectItem>
                <SelectItem value="live" className="text-[12px]">
                  LIVE
                </SelectItem>
                <SelectItem value="t1" className="text-[12px]">
                  T+1
                </SelectItem>
                <SelectItem value="t3" className="text-[12px]">
                  T+3
                </SelectItem>
                <SelectItem value="t5" className="text-[12px]">
                  T+5
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSortOrder((current) => (current === 'asc' ? 'desc' : 'asc'))}
              className="h-8"
            >
              <ArrowDownUp className="h-3.5 w-3.5" />
              {sortOrder === 'asc' ? '升序' : '降序'}
            </Button>
          </div>
        </div>
        <CardContent className="grid shrink-0 grid-cols-2 gap-3 border-b border-border/70 p-4 lg:grid-cols-4">
          <Metric label="推荐记录" value={String(rows.length)} />
          <Metric label="已结算" value={String(settledReturns.length)} />
          <Metric label="平均收益" value={formatPercent(avgReturn(settledReturns), 2)} />
          <Metric label="胜率" value={formatPercent(winRate(settledReturns), 0)} />
        </CardContent>
        <ScrollArea className="min-h-0 flex-1 px-3 pb-3">
          {rows.length === 0 && (
            <div className="workstation-sunken mx-auto mt-10 flex min-h-[180px] max-w-[520px] flex-col items-center justify-center rounded-xl p-6 text-center">
              <div className="text-[14px] font-semibold text-foreground">暂无历史推荐</div>
              <div className="mt-1 text-[12px] leading-5 text-muted-foreground">
                调整交易日、策略或收益状态后重新筛选。
              </div>
            </div>
          )}
          <Table className="text-[12px]">
            <TableHeader className={rows.length === 0 ? 'hidden md:table-header-group' : undefined}>
              <TableRow>
                <TableHead className="w-[96px]">日期</TableHead>
                <TableHead className="w-[150px]">执行</TableHead>
                <TableHead className="w-[130px]">策略</TableHead>
                <TableHead>标的</TableHead>
                <TableHead className="w-[96px] text-right">LIVE</TableHead>
                <TableHead className="w-[96px] text-right">T+1</TableHead>
                <TableHead className="w-[96px] text-right">T+3</TableHead>
                <TableHead className="w-[96px] text-right">T+5</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <RecommendationRow key={row.recommendation_key} row={row} />
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="hidden py-10 text-center text-muted-foreground md:table-cell"
                  >
                    <div className="workstation-sunken mx-auto flex min-h-[180px] max-w-[520px] flex-col items-center justify-center rounded-xl p-6">
                      <div className="text-[14px] font-semibold text-foreground">暂无历史推荐</div>
                      <div className="mt-1 text-[12px] leading-5 text-muted-foreground">
                        调整交易日、策略或收益状态后重新筛选。
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </section>
    </div>
  );
}

function RecommendationRow({ row }: { row: StrategyProfitRow }) {
  return (
    <TableRow>
      <TableCell className="number-figure text-[11px] text-muted-foreground">
        {row.as_of.slice(0, 10)}
      </TableCell>
      <TableCell>
        <div className="number-figure text-[11px] font-semibold">
          {formatExecutionTime(row.execution_time)}
        </div>
        <div className="number-figure text-[10px] text-muted-foreground" title={row.trace_id}>
          {row.trace_label}
        </div>
      </TableCell>
      <TableCell className="font-semibold">{row.strategy_name}</TableCell>
      <TableCell>
        <div className="font-semibold">{row.stock_name}</div>
        <div className="text-[11px] text-muted-foreground">
          {row.symbol} · {row.industry} · #{row.rank}
        </div>
      </TableCell>
      {HORIZONS.map(([key, label]) => {
        const horizon = row.horizons?.[key];
        const returnPct = horizon?.return_pct ?? null;
        const statusLabel = formatHorizonStatus(horizon?.status);
        const value = returnPct === null ? statusLabel : formatPercent(returnPct, 2);
        return (
          <TableCell
            key={key}
            className={cn(
              'number-figure text-right text-[11px] font-semibold',
              returnPct === null
                ? 'text-muted-foreground'
                : returnPct >= 0
                  ? 'text-emerald-600'
                  : 'text-rose-600'
            )}
            title={`${label} ${statusLabel} ${horizon?.settlement_note ?? ''}`}
          >
            <div>{value}</div>
            <div className="mt-0.5 text-[10px] font-normal text-muted-foreground">
              {statusLabel}
            </div>
          </TableCell>
        );
      })}
    </TableRow>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="workstation-control rounded-xl p-3">
      <div className="text-[11px] font-semibold leading-4 text-muted-foreground">{label}</div>
      <div className="number-figure mt-1 text-[16px] font-bold leading-6">{value}</div>
    </div>
  );
}

function formatExecutionTime(value: string | null): string {
  if (!value) {
    return '--';
  }
  return formatMinute(value);
}

function formatHorizonStatus(status: string | undefined): string {
  if (!status) {
    return '--';
  }
  return HORIZON_STATUS_LABELS[status] ?? status;
}

function avgReturn(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function winRate(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.filter((value) => value > 0).length / values.length;
}
