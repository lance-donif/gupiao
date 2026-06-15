import * as React from 'react';
import { Collapsible } from 'radix-ui';
import {
  ArrowRight,
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Gauge,
  GitBranch,
  Layers3,
  LineChart,
  Network,
  Radio,
  ShieldCheck,
  Sparkles,
  Star,
  Target,
  TrendingUp,
} from 'lucide-react';
import type {
  DashboardEvidenceChainItem,
  DashboardNetworkPayload,
  DashboardRecommendationItem,
  DashboardSnapshotPayload,
  DashboardStockDetailPayload,
} from '@/lib/api-types';
import { useAppShell } from '@/app/app-context';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useDashboardSnapshot,
  useStockDetail,
  useStockEvidence,
  useStockNetwork,
} from '@/hooks/use-dashboard-data';
import { buildEvidencePreview } from '@/features/dashboard/dashboard-view-model';
import { cn, formatMinute, formatPercent, formatScore } from '@/lib/utils';

const actionClasses: Record<
  DashboardStockDetailPayload['ui_summary']['decision']['action_state'],
  string
> = {
  strong_buy:
    'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300',
  watch_pullback:
    'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300',
  observe:
    'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-300',
  avoid:
    'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300',
};

const toneClasses = {
  positive:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300',
  neutral:
    'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300',
  warning:
    'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300',
};

function pickTraceId(
  snapshotTraceId: string | undefined,
  selected: DashboardRecommendationItem | null
) {
  return selected?.trace_id || snapshotTraceId || '';
}

function CopyableId({ id, label }: { id: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  const handleCopy = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(setCopied, 1500, false);
    } catch {
      // The copy affordance is optional; leave the UI stable if the browser blocks it.
    }
  };

  if (!id) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="number-figure inline-flex max-w-full items-center gap-1 rounded border border-border/50 bg-white/90 px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground shadow-[var(--shadow-control)] backdrop-blur hover:bg-white sm:bg-background"
      title={id}
    >
      <span className="truncate">{label || `${id.slice(0, 8)}...${id.slice(-6)}`}</span>
      {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function compactText(value: string | null | undefined, fallback = '--') {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : fallback;
}

function formatPrice(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)} 元` : '--';
}

function formatQuoteTime(value: string | null | undefined): string {
  if (!value) {
    return '时间未知';
  }
  return formatMinute(value);
}

function formatQuoteSource(
  source: DashboardStockDetailPayload['live_quote']['source'] | undefined
): string {
  if (source === 'tickflow') {
    return 'TickFlow 行情';
  }
  if (source === 'yahoo_finance') {
    return 'Yahoo 行情';
  }
  if (source === 'candle_fallback') {
    return '最新 K 线';
  }
  return '行情不可用';
}

function formatExternalFactLabel(item: DashboardEvidenceChainItem) {
  const fact = item.exposure.external_fact;
  const sourceName = compactText(fact.sourceName ?? fact.source_name ?? fact.source, '外部事实');
  const exposureType = compactText(
    fact.exposureType ?? fact.exposure_type ?? item.exposure.exposure_type,
    '暴露'
  );
  return `${sourceName} · ${exposureType}`;
}

function formatExternalFactMeta(item: DashboardEvidenceChainItem) {
  const fact = item.exposure.external_fact;
  const fields = [
    `source=${compactText(fact.source)}`,
    `sourceId=${compactText(fact.sourceId ?? fact.source_id)}`,
    `sourceName=${compactText(fact.sourceName ?? fact.source_name)}`,
    `exposureType=${compactText(fact.exposureType ?? fact.exposure_type ?? item.exposure.exposure_type)}`,
    `rawField=${compactText(fact.rawField ?? fact.raw_field)}`,
    `updatedAt=${compactText(fact.updatedAt ?? fact.updated_at ?? fact.observed_at)}`,
    `confidence=${formatScore(fact.confidence, 2)}`,
  ];
  return fields.join(' · ');
}

function formatEvidencePath(item: DashboardEvidenceChainItem) {
  const signal = item.signal.source_keyword || item.signal.asset_or_theme_keyword || '未知信号';
  return `${signal} → ${formatExternalFactLabel(item)} → ${item.stock_link.stock_name}`;
}

function toFiniteScore(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function RecommendationRail({
  rows,
  selectedSymbol,
  onSelect,
}: {
  rows: DashboardRecommendationItem[];
  selectedSymbol: string | null;
  onSelect: (row: DashboardRecommendationItem) => void;
}) {
  const [isOpen, setIsOpen] = React.useState(() => {
    return typeof window === 'undefined' ? true : window.innerWidth >= 1100;
  });

  return (
    <aside
      data-state={isOpen ? 'open' : 'closed'}
      className="recommendation-rail flex min-h-0 flex-col rounded-r-lg bg-card"
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/70 px-3">
        <div className="flex items-center gap-1.5">
          <div className="text-sm font-semibold leading-5">推荐列表</div>
          <Badge variant="outline" className="number-figure h-4 px-1 text-[9px]">
            {rows.length} 只
          </Badge>
        </div>
        {/* Header 顶部不保留 < 按钮 */}
      </div>

      <ScrollArea className="min-h-0 flex-1 recommendation-rail-scroll">
        <div className="space-y-2 p-2">
          {rows.map((row) => (
            <button
              key={`${row.trace_id}-${row.symbol}`}
              type="button"
              onClick={() => {
                onSelect(row);
                // 移动端/小屏点击任意股票时，抽屉自动收起，提升查看详情的体验
                if (window.innerWidth < 1100) {
                  setIsOpen(false);
                }
              }}
              className={cn(
                'workstation-control relative grid min-h-[68px] w-full grid-cols-[34px_minmax(0,1fr)_58px] items-center gap-2 rounded-md px-2.5 py-2 text-left hover:border-sky-200 hover:bg-white dark:hover:border-sky-900/60 dark:hover:bg-sky-950/20',
                selectedSymbol === row.symbol &&
                  'border-sky-300 bg-sky-50 ring-2 ring-sky-100 shadow-[var(--shadow-soft)] before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-r before:bg-sky-500 dark:border-sky-800 dark:bg-sky-950/30 dark:ring-sky-950'
              )}
              aria-pressed={selectedSymbol === row.symbol}
            >
              <div className="number-figure text-[12px] font-semibold text-muted-foreground">
                #{row.rank}
              </div>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold leading-5">{row.stock_name}</div>
                <div className="truncate text-[11px] leading-4 text-muted-foreground">
                  {row.symbol} · {row.industry}
                </div>
                {(row.win_rate_t1 != null || row.win_rate_t3 != null) && (
                  <div className="mt-0.5 flex gap-1">
                    {row.win_rate_t1 != null && (
                      <span className="rounded bg-emerald-50 px-1 py-0 text-[10px] leading-4 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400">
                        T+1 {Math.round(row.win_rate_t1 * 100)}%
                      </span>
                    )}
                    {row.win_rate_t3 != null && (
                      <span className="rounded bg-sky-50 px-1 py-0 text-[10px] leading-4 text-sky-700 dark:bg-sky-950/30 dark:text-sky-400">
                        T+3 {Math.round(row.win_rate_t3 * 100)}%
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="text-right rounded-md bg-white/72 px-1.5 py-1 shadow-[var(--shadow-control)]">
                <div className="number-figure text-[15px] font-bold leading-5 text-foreground">
                  {Math.round(row.total_score)}
                </div>
                <div className="text-[10px] leading-4 text-muted-foreground">阶段 {row.stage}</div>
              </div>
            </button>
          ))}
          {rows.length === 0 && <EmptyBlock text="当前日期暂无推荐快照" />}
        </div>
      </ScrollArea>
      <div className="h-8 shrink-0 border-t border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground">
        首屏仅显示决策字段，完整细节在中栏展开。
      </div>

      {/* 极度精美、支持原位双向随动的中置小把手拉手 */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="absolute right-[-14px] top-1/2 -translate-y-1/2 z-40 flex h-16 w-3.5 items-center justify-center rounded-r-md border-y border-r border-border bg-white shadow-[var(--shadow-control)] text-muted-foreground hover:w-5 active:scale-95 transition-all duration-150 focus-visible:outline-none"
        title={isOpen ? '收起推荐列表' : '展开推荐列表'}
      >
        <ChevronDown
          className={cn(
            'h-3 w-3 text-sky-600 transition-transform duration-200',
            isOpen ? 'rotate-90' : '-rotate-90'
          )}
        />
      </button>
    </aside>
  );
}

function PrimaryDecisionSurface({
  selected,
  detail,
  loading,
}: {
  selected: DashboardRecommendationItem;
  detail: DashboardStockDetailPayload | null;
  loading: boolean;
}) {
  const summary = detail?.ui_summary;
  return (
    <section className="workstation-panel-strong h-auto min-h-[172px] shrink-0 rounded-lg p-4 sm:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="h-5 px-1.5 text-[11px]">
              {selected.industry}
            </Badge>
            <span className="number-figure text-[11px] text-muted-foreground">
              {selected.symbol} · 排名 #{selected.rank}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <h1 className="truncate text-[30px] font-bold leading-[38px] text-foreground sm:text-[34px] sm:leading-[42px] xl:text-[40px] xl:leading-[48px]">
              {selected.stock_name}
            </h1>
            <Badge
              className={cn(
                'mb-2 h-6 shrink-0 border px-2 text-[12px]',
                summary ? actionClasses[summary.decision.action_state] : ''
              )}
              variant="outline"
            >
              {summary?.decision.action_label || (loading ? '加载中' : '待确认')}
            </Badge>
          </div>
          <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-muted-foreground">
            {summary?.decision.headline || selected.reason_summary}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded-md border border-sky-200 bg-sky-50 px-2 py-1 text-sky-700">
              <Radio className="h-3 w-3" /> 新闻因果
            </span>
            <ArrowRight className="h-3.5 w-3.5" />
            <span className="inline-flex items-center gap-1 rounded-md border border-cyan-200 bg-cyan-50 px-2 py-1 text-cyan-700">
              <Target className="h-3 w-3" /> 暴露事实
            </span>
            <ArrowRight className="h-3.5 w-3.5" />
            <span className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-amber-700">
              <TrendingUp className="h-3 w-3" /> 行情确认
            </span>
          </div>
        </div>
        <div className="decision-score-card flex w-full shrink-0 flex-col gap-3 rounded-lg border border-sky-100/80 p-3 text-left shadow-[var(--shadow-control)] sm:w-[250px]">
          <div>
            <div className="flex items-center justify-between gap-3">
              <div className="text-[12px] font-semibold leading-5 text-muted-foreground">
                综合评分
              </div>
              <Gauge className="h-4 w-4 text-sky-600" />
            </div>
            <div className="number-figure mt-1 text-[44px] font-bold leading-[48px] text-foreground xl:text-[48px] xl:leading-[52px]">
              {formatScore(selected.total_score)}
            </div>
          </div>
          <ScoreStack detail={detail} />
        </div>
      </div>
      <p className="number-figure mt-4 truncate border-t border-border/60 pt-3 text-[11px] leading-4 text-muted-foreground">
        {summary?.decision.score_formula || '证据 -- + 图谱 -- + 暴露 -- + 市场 -- = --'}
      </p>
    </section>
  );
}

function ScoreStack({ detail }: { detail: DashboardStockDetailPayload | null }) {
  const items = [
    {
      label: '证据',
      value: toFiniteScore(detail?.score_breakdown.evidence),
      max: 45,
      color: '#2563eb',
      icon: ShieldCheck,
    },
    {
      label: '图谱',
      value: toFiniteScore(detail?.score_breakdown.graph),
      max: 20,
      color: '#7c3aed',
      icon: Layers3,
    },
    {
      label: '暴露',
      value: toFiniteScore(detail?.score_breakdown.exposure),
      max: 15,
      color: '#0891b2',
      icon: Target,
    },
    {
      label: '市场',
      value: toFiniteScore(detail?.score_breakdown.market),
      max: 20,
      color: '#d97706',
      icon: LineChart,
    },
  ];

  return (
    <div className="space-y-2">
      {items.map((item) => {
        const Icon = item.icon;
        const width =
          item.value === null ? 0 : Math.max(0, Math.min(100, (item.value / item.max) * 100));
        return (
          <div
            key={item.label}
            className="grid grid-cols-[44px_minmax(0,1fr)_42px] items-center gap-2"
          >
            <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground">
              <Icon className="h-3 w-3" />
              {item.label}
            </div>
            <div className="score-bar-track">
              <div
                className="score-bar-fill"
                style={{ width: `${width}%`, backgroundColor: item.color }}
              />
            </div>
            <div className="number-figure text-right text-[11px] font-semibold">
              {item.value === null ? '--' : formatScore(item.value)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ActionPlanStrip({ detail }: { detail: DashboardStockDetailPayload | null }) {
  const trigger = detail?.ui_summary.buy_trigger;
  const quote = detail?.live_quote;
  const items = [
    {
      label: '买入条件',
      value: trigger?.trigger_label || '等待触发条件',
      icon: Target,
      tone: 'text-sky-600',
    },
    { label: '实时价', value: formatPrice(quote?.price), icon: Radio, tone: 'text-cyan-600' },
    {
      label: '今日最低',
      value: formatPrice(quote?.day_low),
      icon: LineChart,
      tone: 'text-emerald-600',
    },
    {
      label: '仓位建议',
      value: trigger?.position_label || '待计算',
      icon: Gauge,
      tone: 'text-amber-600',
    },
  ];
  return (
    <section className="grid grid-cols-2 sm:grid-cols-4 gap-2 h-auto sm:min-h-[70px] shrink-0">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <div key={item.label} className="workstation-control rounded-lg p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold leading-4 text-muted-foreground">
              <Icon className={cn('h-3.5 w-3.5', item.tone)} />
              {item.label}
            </div>
            <div className="mt-1 line-clamp-2 text-[13px] font-semibold leading-5">
              {item.value}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function ReasonGrid({ detail }: { detail: DashboardStockDetailPayload | null }) {
  const summary = detail?.ui_summary;
  return (
    <section className="grid grid-cols-1 sm:grid-cols-3 gap-2 min-h-[150px] h-auto shrink-0">
      <ReasonCard
        title="为什么是它"
        lines={[
          summary?.why_stock.conclusion || '等待详情数据',
          summary?.why_stock.key_evidence || '',
          summary?.why_stock.mapping_reason || '',
          summary?.why_stock.risk_note || '',
        ]}
      />
      <div className="workstation-control rounded-lg p-3">
        <div className="text-[14px] font-semibold leading-5">现在为什么</div>
        <div className="mt-2 space-y-1">
          {(summary?.why_now ?? []).slice(0, 3).map((item) => (
            <div
              key={item.label}
              className={cn('rounded-md border px-2 py-1', toneClasses[item.tone])}
            >
              <div className="text-[11px] font-semibold leading-4">{item.label}</div>
              <div className="line-clamp-1 text-[12px] leading-4">{item.detail}</div>
            </div>
          ))}
          {!summary && <EmptyBlock text="正在读取决策摘要" compact />}
        </div>
      </div>
      <MarketQuoteCard detail={detail} />
    </section>
  );
}

function MarketQuoteCard({ detail }: { detail: DashboardStockDetailPayload | null }) {
  const quote = detail?.live_quote;
  return (
    <div className="workstation-control rounded-lg p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[14px] font-semibold leading-5">实时行情</div>
        <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px]">
          {formatQuoteSource(quote?.source)}
        </Badge>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <MiniMetric label="实时价" value={formatPrice(quote?.price)} />
        <MiniMetric label="今日最低" value={formatPrice(quote?.day_low)} />
        <MiniMetric label="今日最高" value={formatPrice(quote?.day_high)} />
      </div>
      <div className="mt-2 truncate text-[11px] leading-4 text-muted-foreground">
        {formatQuoteTime(quote?.market_time)} ·{' '}
        {quote?.status === 'FALLBACK' ? '外部行情失败，已回退' : formatQuoteSource(quote?.source)}
      </div>
    </div>
  );
}

function SecondaryExplainSurface({
  evidence,
  network,
  detail,
  loading,
  snapshot,
}: {
  evidence: NonNullable<ReturnType<typeof useStockEvidence>['data']> | null;
  network: DashboardNetworkPayload | null;
  detail: DashboardStockDetailPayload | null;
  loading: boolean;
  snapshot: DashboardSnapshotPayload | null;
}) {
  return (
    <section className="workstation-panel min-h-0 flex-1 rounded-lg">
      <Tabs defaultValue="evidence" className="flex h-full min-h-0 flex-col">
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/70 px-4">
          <TabsList className="h-8 rounded-md">
            <TabsTrigger value="evidence" className="h-6 px-3 text-[12px]">
              核心证据
            </TabsTrigger>
            <TabsTrigger value="network" className="h-6 px-3 text-[12px]">
              亲友网络
            </TabsTrigger>
            <TabsTrigger value="forecast" className="h-6 px-3 text-[12px]">
              主题预测
            </TabsTrigger>
            <TabsTrigger value="status" className="h-6 px-3 text-[12px]">
              执行状态
            </TabsTrigger>
          </TabsList>
          <div className="text-[11px] text-muted-foreground">
            {evidence
              ? `有效 ${evidence.stats.effective_count}/${evidence.stats.total_count}`
              : loading
                ? '加载中'
                : '无证据'}
          </div>
        </div>
        <TabsContent value="evidence" className="m-0 min-h-0 flex-1 p-4">
          <EvidenceChainPanel evidence={evidence} />
        </TabsContent>
        <TabsContent value="network" className="m-0 min-h-0 flex-1 p-4">
          <NetworkPanel network={network} />
        </TabsContent>
        <TabsContent value="forecast" className="m-0 min-h-0 flex-1 p-4">
          <ThemeForecastPanel snapshot={snapshot} />
        </TabsContent>
        <TabsContent value="status" className="m-0 min-h-0 flex-1 p-4">
          <StatusPanel detail={detail} />
        </TabsContent>
      </Tabs>
    </section>
  );
}

function ThemeForecastPanel({ snapshot }: { snapshot: DashboardSnapshotPayload | null }) {
  const forecasts = snapshot?.theme_forecasts ?? [];
  const gaps = snapshot?.expectation_gaps ?? [];
  const bullish = forecasts.filter(f => f.direction === 'bullish');
  const bearish = forecasts.filter(f => f.direction === 'bearish');

  if (forecasts.length === 0 && gaps.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        暂无主题预测数据（需先运行每日推荐流水线）
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4">
        {bullish.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-1.5">
              <div className="text-[13px] font-semibold text-emerald-700 dark:text-emerald-400">看涨主题</div>
              <Badge variant="outline" className="number-figure h-4 px-1 text-[9px]">{bullish.length}</Badge>
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {bullish.map(f => (
                <div
                  key={f.theme}
                  className={cn(
                    'rounded-lg border p-3',
                    f.weak_signal
                      ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20'
                      : 'border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-950/10',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div className="text-[14px] font-semibold">{f.theme}</div>
                    <div className="number-figure text-[16px] font-bold text-emerald-600 dark:text-emerald-400">
                      {(f.probability * 100).toFixed(0)}%
                    </div>
                  </div>
                  {f.weak_signal && (
                    <Badge className="mt-1 h-4 px-1 text-[9px] text-amber-700">弱信号</Badge>
                  )}
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    <span className="text-[10px] text-muted-foreground">信号强度 {(f.signal_strength * 100).toFixed(0)}%</span>
                    <span className="text-[10px] text-muted-foreground">·</span>
                    <span className="text-[10px] text-muted-foreground">预期差 {f.expectation_gap.toFixed(3)}</span>
                  </div>
                  {f.related_symbols.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {f.related_symbols.slice(0, 5).map(s => (
                        <span key={s} className="rounded bg-white/80 px-1 py-0 text-[10px] text-muted-foreground dark:bg-slate-900/50">
                          {s}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {bearish.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-1.5">
              <div className="text-[13px] font-semibold text-rose-700 dark:text-rose-400">看跌主题</div>
              <Badge variant="outline" className="number-figure h-4 px-1 text-[9px]">{bearish.length}</Badge>
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {bearish.map(f => (
                <div key={f.theme} className="rounded-lg border border-rose-200 bg-rose-50/50 p-3 dark:border-rose-900/50 dark:bg-rose-950/10">
                  <div className="flex items-center justify-between">
                    <div className="text-[14px] font-semibold">{f.theme}</div>
                    <div className="number-figure text-[16px] font-bold text-rose-600 dark:text-rose-400">
                      {(f.probability * 100).toFixed(0)}%
                    </div>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    <span className="text-[10px] text-muted-foreground">信号强度 {(f.signal_strength * 100).toFixed(0)}%</span>
                    <span className="text-[10px] text-muted-foreground">·</span>
                    <span className="text-[10px] text-muted-foreground">预期差 {f.expectation_gap.toFixed(3)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {gaps.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-1.5">
              <div className="text-[13px] font-semibold text-amber-700 dark:text-amber-400">弱信号（预期差）</div>
              <Badge variant="outline" className="number-figure h-4 px-1 text-[9px]">{gaps.length}</Badge>
            </div>
            <div className="space-y-1.5">
              {gaps.map(g => (
                <div key={g.keyword} className="flex items-center justify-between rounded-md border border-amber-200 bg-amber-50/30 px-3 py-2 dark:border-amber-900/40 dark:bg-amber-950/10">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold">{g.keyword}</div>
                    <div className="text-[10px] text-muted-foreground">
                      图谱强度 {g.graph_strength.toFixed(3)} · 股价反应 {(g.price_reaction * 100).toFixed(2)}%
                    </div>
                  </div>
                  <div className="number-figure shrink-0 text-[14px] font-bold text-amber-600 dark:text-amber-400">
                    +{g.expectation_gap.toFixed(3)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function StockWorkspace({
  selected,
  snapshot,
  detail,
  evidence,
  network,
  loading,
  detailError,
}: {
  selected: DashboardRecommendationItem | null;
  snapshot: DashboardSnapshotPayload | null;
  detail: DashboardStockDetailPayload | null;
  evidence: NonNullable<ReturnType<typeof useStockEvidence>['data']> | null;
  network: DashboardNetworkPayload | null;
  loading: boolean;
  detailError: string | null;
}) {
  if (!selected) {
    return <SlaEmptyState snapshot={snapshot} />;
  }

  return (
    <main className="flex min-h-0 flex-col gap-2 overflow-hidden">
      <PrimaryDecisionSurface selected={selected} detail={detail} loading={loading} />
      <ActionPlanStrip detail={detail} />
      {detailError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
          详情读取失败：{detailError}
        </div>
      )}
      <ReasonGrid detail={detail} />
      <SecondaryExplainSurface
        evidence={evidence}
        network={network}
        detail={detail}
        loading={loading}
        snapshot={snapshot}
      />
    </main>
  );
}

function SlaEmptyState({ snapshot }: { snapshot: DashboardSnapshotPayload | null }) {
  const sla = snapshot?.sla;
  return (
    <main className="workstation-panel-strong flex min-h-0 flex-col gap-4 overflow-hidden rounded-lg p-5">
      <div className="flex h-auto shrink-0 flex-col gap-5 rounded-lg bg-white/70 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <Badge
            variant={sla?.status === 'failed' ? 'destructive' : 'outline'}
            className="h-6 px-2 text-[12px] shadow-[var(--shadow-control)]"
          >
            {sla?.status_label || '今日推荐状态未知'}
          </Badge>
          <h1 className="mt-4 text-[28px] font-bold leading-9 sm:text-[30px]">
            当前日期暂无推荐快照
          </h1>
          <p className="mt-2 max-w-[720px] text-[13px] leading-6 text-muted-foreground">
            {sla?.error_message || '系统未返回当天推荐结果，也没有明确失败信息。'}
          </p>
        </div>
        <div className="grid w-full gap-2 shrink-0 sm:w-[300px]">
          <MiniMetric label="SLA 截止" value={sla?.deadline_at || '--'} />
          <MiniMetric label="下次重试" value={sla?.next_retry_at || '--'} />
        </div>
      </div>
      <div className="grid shrink-0 grid-cols-1 gap-2 sm:grid-cols-3">
        <ReasonCard
          title="当前节点"
          lines={[
            sla?.failed_node_label || sla?.failed_node || snapshot?.meta.current_stage || '未启动',
            snapshot?.meta.status || '--',
          ]}
        />
        <ReasonCard
          title="执行记录"
          lines={[
            `记录数：${snapshot?.execution_history.length ?? 0}`,
            `最近状态：${snapshot?.execution_history[0]?.status || '--'}`,
            `最近时间：${formatMinute(snapshot?.execution_history[0]?.finished_at || snapshot?.execution_history[0]?.started_at)}`,
          ]}
        />
        <ReasonCard
          title="处理要求"
          lines={[
            '17:00 前必须生成推荐或明确失败。',
            '失败节点会进入 RunTrace 与 Dashboard。',
            'LLM 失败只重试或停止，不降级。',
          ]}
        />
      </div>
      <div className="workstation-sunken min-h-0 flex-1 rounded-lg p-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-[14px] font-semibold leading-5">最近执行记录</div>
            <div className="text-[11px] leading-4 text-muted-foreground">
              用于定位失败节点和重试时间
            </div>
          </div>
          <Badge variant="outline" className="number-figure h-5 shrink-0 px-1.5 text-[10px]">
            {snapshot?.execution_history.length ?? 0} 条
          </Badge>
        </div>
        <ScrollArea className="h-full max-h-[280px]">
          <div className="grid gap-2 pr-2 md:grid-cols-2">
            {(snapshot?.execution_history ?? []).slice(0, 6).map((row) => (
              <div
                key={row.trace_id}
                className="rounded-lg bg-white p-3 shadow-[var(--shadow-control)]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-semibold">{row.status}</span>
                  <span className="number-figure text-[10px] text-muted-foreground">
                    {formatMinute(row.finished_at || row.started_at)}
                  </span>
                </div>
                <div className="mt-1 line-clamp-1 text-[11px] text-muted-foreground">
                  {row.current_stage}
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <CopyableId id={row.trace_id} />
                  <span className="number-figure text-[10px] text-muted-foreground">
                    {row.target_trading_date}
                  </span>
                </div>
              </div>
            ))}
            {(snapshot?.execution_history ?? []).length === 0 && (
              <EmptyBlock text="暂无执行记录" compact />
            )}
          </div>
        </ScrollArea>
      </div>
    </main>
  );
}

function EvidenceChainPanel({
  evidence,
}: {
  evidence: NonNullable<ReturnType<typeof useStockEvidence>['data']> | null;
}) {
  const preview = buildEvidencePreview(evidence?.items ?? []);
  if (preview.mode === 'empty') {
    return <EmptyBlock text="暂无可核验证据链，当前推荐不可解释" />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="grid h-auto shrink-0 grid-cols-2 gap-2 sm:grid-cols-4">
        <MiniMetric label="覆盖率" value={formatPercent(evidence?.stats.coverage, 0)} />
        <MiniMetric label="平均置信" value={formatPercent(evidence?.stats.average_confidence, 0)} />
        <MiniMetric label="总贡献" value={formatScore(evidence?.stats.total_contribution, 2)} />
        <MiniMetric
          label="证据数"
          value={`${evidence?.stats.effective_count ?? 0}/${evidence?.stats.total_count ?? 0}`}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 pr-2">
          {preview.expanded.map((item, index) => (
            <EvidenceChainCard key={item.chain_id} item={item} index={index + 1} defaultOpen />
          ))}
          {preview.summaries.map((item, index) => (
            <EvidenceSummaryCard key={item.chain_id} item={item} index={index + 2} />
          ))}
          {preview.hiddenCount > 0 && (
            <div className="rounded-md border border-dashed border-border px-3 py-2 text-center text-[12px] text-muted-foreground">
              查看全部 {evidence?.items.length ?? 0} 条证据链
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function EvidenceSummaryCard({ item, index }: { item: DashboardEvidenceChainItem; index: number }) {
  return (
    <div className="workstation-control rounded-lg p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold leading-5">
            {index}. {item.news.title}
          </div>
          <div className="mt-1 truncate text-[12px] leading-4 text-muted-foreground">
            {formatEvidencePath(item)}
          </div>
        </div>
        <Badge variant="secondary" className="h-5 shrink-0 px-1.5 font-mono text-[10px]">
          {formatScore(item.score.final_contrib_score, 2)}
        </Badge>
      </div>
    </div>
  );
}

function EvidenceChainCard({
  item,
  index,
  defaultOpen = false,
}: {
  item: DashboardEvidenceChainItem;
  index: number;
  defaultOpen?: boolean;
}) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className="workstation-control rounded-lg">
      <Collapsible.Trigger className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-muted/50">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold leading-5">
            {index}. {item.news.title}
          </div>
          <div className="mt-1 truncate font-mono text-[11px] leading-4 text-muted-foreground">
            {formatEvidencePath(item)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="secondary" className="h-5 px-1.5 font-mono text-[10px]">
            贡献 {formatScore(item.score.final_contrib_score, 2)}
          </Badge>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </div>
      </Collapsible.Trigger>
      <Collapsible.Content className="border-t border-border/70 p-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <EvidenceStep
            title="新闻"
            text={item.news.anchor_quote || item.news.excerpt || item.news.title}
            sub={`${item.news.source} · ${formatMinute(item.news.published_at)}`}
          />
          <EvidenceStep
            title="信号"
            text={item.signal.signal_reason}
            sub={item.signal.source_keyword || item.signal.asset_or_theme_keyword || '--'}
          />
          <EvidenceStep
            title="外部事实"
            text={item.exposure.external_fact.evidence_text || item.exposure.exposure_reason}
            sub={formatExternalFactMeta(item)}
          />
          <EvidenceStep
            title={
              item.exposure.external_fact.verification_label === '异动事实已接入'
                ? '异动解读'
                : '暴露'
            }
            text={item.exposure.exposure_reason}
            sub={compactText(
              item.exposure.external_fact.rawField ??
                item.exposure.external_fact.raw_field ??
                item.exposure.exposure_type
            )}
          />
          <EvidenceStep
            title="股票"
            text={item.stock_link.link_reason}
            sub={`${item.stock_link.industry || '--'} · 置信 ${formatScore(item.exposure.external_fact.confidence, 2)}`}
          />
          <EvidenceStep
            title="评分"
            text={`最终贡献 ${formatScore(item.score.final_contrib_score, 3)}`}
            sub={`频率 ${formatScore(item.score.base_frequency_score, 3)} / 时效 ${formatScore(item.score.time_decayed_score, 3)}`}
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-3">
          {item.news.url && (
            <a
              className="inline-flex items-center gap-1 text-[11px] text-sky-600 hover:underline"
              href={item.news.url}
              target="_blank"
              rel="noreferrer"
            >
              查看原文 <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {item.exposure.external_fact.source_url && (
            <a
              className="inline-flex items-center gap-1 text-[11px] text-sky-600 hover:underline"
              href={item.exposure.external_fact.source_url}
              target="_blank"
              rel="noreferrer"
            >
              查看外部事实 <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function NetworkPanel({ network }: { network: DashboardNetworkPayload | null }) {
  const chains = React.useMemo(
    () => (network && network.nodes.length >= 2 ? buildNetworkChains(network) : []),
    [network],
  );
  const relations = React.useMemo(
    () =>
      network
        ? [...network.relations].sort((left, right) => right.strength - left.strength)
        : [],
    [network],
  );

  if (!network || network.nodes.length < 2) {
    return <EmptyBlock text="当前证据不足以形成稳定关系图" />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="workstation-control rounded-lg p-3">
        <div className="mb-3 flex items-center gap-2 text-[12px] text-muted-foreground">
          <Network className="h-4 w-4" />
          <span>{network.network_preview.explanation || '证据链路预览'}</span>
        </div>
        <div className="space-y-2">
          {chains.map((chain) => (
            <div key={chain.id} className="rounded-md border border-border/70 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <NodePill label={chain.theme} kind="theme" />
                <ChainArrow label="因果链" />
                <NodePill label={chain.keyword} kind="keyword" />
                <ChainArrow label="暴露映射" />
                <NodePill label={chain.exposure} kind="exposure" />
                <ChainArrow label="标的映射" />
                <NodePill label={network.stock_name ?? '当前标的'} kind="stock" />
              </div>
              <div className="mt-2 text-[11px] leading-4 text-muted-foreground">
                置信 {formatPercent(chain.confidence, 0)} · {chain.summary}
              </div>
            </div>
          ))}
          {chains.length === 0 && <EmptyBlock text="当前证据不足以形成稳定关系图" />}
        </div>
      </div>
      {network.related_theme_forecasts && network.related_theme_forecasts.length > 0 && (
        <div className="workstation-control shrink-0 rounded-lg p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold">
            <Sparkles className="h-3.5 w-3.5 text-violet-500" />
            关联主题预测
          </div>
          <div className="flex flex-wrap gap-1.5">
            {network.related_theme_forecasts.map(f => (
              <span
                key={f.theme}
                className={cn(
                  'rounded-md border px-2 py-1 text-[11px]',
                  f.direction === 'bullish'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-400'
                    : f.direction === 'bearish'
                      ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/20 dark:text-rose-400'
                      : 'border-border/70 bg-muted/30 text-muted-foreground',
                )}
              >
                {f.theme} {(f.probability * 100).toFixed(0)}%
                {f.weak_signal && ' · 弱信号'}
              </span>
            ))}
          </div>
        </div>
      )}
      <ScrollArea className="workstation-sunken min-h-0 flex-1 rounded-lg">
        <div className="space-y-2 p-3">
          {relations.map((row, index) => (
            <div
              key={`${row.source}-${row.target}-${index}`}
              className="rounded-md border border-border/70 p-2"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 text-[12px] font-semibold leading-4">
                  {row.source} → {row.target}
                </div>
                <Badge variant="outline" className="h-5 px-1.5 font-mono text-[10px]">
                  {formatPercent(row.strength, 0)}
                </Badge>
              </div>
              <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
                {row.relation} · {row.source_type}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function buildNetworkChains(network: DashboardNetworkPayload): Array<{
  id: string;
  theme: string;
  keyword: string;
  exposure: string;
  confidence: number;
  summary: string;
}> {
  const causalRelations = network.relations.filter((row) => row.source_type === '因果链');
  const exposureRelations = network.relations.filter((row) => row.source_type === '暴露映射');

  return causalRelations.flatMap((causal) => {
    const exposure = exposureRelations.find((row) => row.source === causal.target);
    if (!exposure) {
      return [];
    }
    return [
      {
        id: `${causal.source}-${causal.target}-${exposure.target}`,
        theme: causal.source,
        keyword: causal.target,
        exposure: exposure.target,
        confidence: Math.min(causal.strength, exposure.strength),
        summary: `${causal.relation} → ${exposure.relation}`,
      },
    ];
  });
}

function NodePill({
  label,
  kind,
}: {
  label: string;
  kind: 'theme' | 'keyword' | 'exposure' | 'stock';
}) {
  const kindClasses: Record<typeof kind, string> = {
    theme:
      'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-300',
    keyword:
      'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/50 dark:bg-violet-950/30 dark:text-violet-300',
    exposure:
      'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300',
    stock:
      'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300',
  };

  return (
    <span
      className={cn(
        'inline-flex max-w-[160px] items-center rounded-md border px-2 py-1 text-[11px] font-semibold leading-4',
        kindClasses[kind]
      )}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}

function ChainArrow({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <ArrowRight className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

function StatusPanel({ detail }: { detail: DashboardStockDetailPayload | null }) {
  const health = detail?.ui_summary.system_health;
  const rows = [
    ['数据更新时间', formatMinute(health?.data_updated_at)],
    ['Schema 检查', health?.schema_health_label || '--'],
    ['流水线状态', health?.pipeline_health_label || '--'],
    ['Trace ID', detail?.trace_id || '--'],
  ];
  return (
    <div className="grid grid-cols-2 gap-3">
      {rows.map(([label, value]) => (
        <div key={label} className="rounded-lg border border-border bg-background p-3">
          <div className="text-[11px] font-semibold leading-4 text-muted-foreground">{label}</div>
          <div className="mt-1 line-clamp-2 break-all font-mono text-[12px] leading-5">{value}</div>
        </div>
      ))}
    </div>
  );
}

function SystemRail({
  snapshot,
}: {
  snapshot: NonNullable<ReturnType<typeof useDashboardSnapshot>['data']> | null;
}) {
  const latest = snapshot?.execution_history[0] ?? null;
  return (
    <aside className="dashboard-right flex min-h-0 flex-col gap-2 overflow-hidden">
      <Card className="h-auto shrink-0">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-[14px] leading-5">推荐质量</CardTitle>
          <CardDescription className="text-[12px] leading-4">
            执行时间 {formatMinute(snapshot?.quality.execution_time)}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 p-4 pt-0">
          <Metric
            label="推荐数"
            value={String(snapshot?.quality.recommendation_count ?? 0)}
            icon={<Star className="h-3.5 w-3.5 text-amber-600" />}
          />
          <Metric
            label="有效证据"
            value={String(snapshot?.quality.effective_evidence_count ?? 0)}
            icon={<ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />}
          />
          <Metric
            label="L1 覆盖"
            value={formatPercent(snapshot?.quality.l1_coverage, 0)}
            icon={<Sparkles className="h-3.5 w-3.5 text-sky-600" />}
          />
          <Metric
            label="Schema"
            value={`${snapshot?.quality.schema_mismatch_count ?? 0}/${snapshot?.quality.schema_checked_count ?? 0}`}
            icon={<Activity className="h-3.5 w-3.5 text-rose-600" />}
          />
        </CardContent>
      </Card>
      <Card className="h-auto shrink-0">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-[14px] leading-5">最近执行</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {latest ? (
            <div className="rounded-md border border-border bg-background p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-semibold">{latest.status}</span>
                <span className="text-[11px] text-muted-foreground">
                  {formatMinute(latest.finished_at || latest.started_at)}
                </span>
              </div>
              <div className="mt-1 truncate text-[11px] text-muted-foreground">
                {latest.current_stage}
              </div>
            </div>
          ) : (
            <EmptyBlock text="暂无执行记录" compact />
          )}
        </CardContent>
      </Card>
      <Card className="min-h-0 flex-1">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-[14px] leading-5">执行记录</CardTitle>
          <CardDescription className="text-[12px] leading-4">最近 3 条</CardDescription>
        </CardHeader>
        <CardContent className="min-h-0 p-0">
          <ScrollArea className="h-full px-4 pb-4">
            <div className="space-y-2">
              {(snapshot?.execution_history ?? []).slice(0, 3).map((row) => (
                <div
                  key={row.trace_id}
                  className="rounded-lg border border-border bg-background p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-semibold">
                      {formatMinute(row.finished_at || row.started_at)}
                    </span>
                    <Badge
                      variant={row.status === '失败' ? 'destructive' : 'outline'}
                      className="h-5 px-1.5 text-[10px]"
                    >
                      {row.status}
                    </Badge>
                  </div>
                  <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
                    {row.target_trading_date} · {row.group_id} · {row.strategy_id || '全部策略'}
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <CopyableId id={row.trace_id} />
                    <span className="number-figure text-[10px] text-muted-foreground">
                      trace {row.trace_id.slice(0, 8)}…
                    </span>
                  </div>
                </div>
              ))}
              {(snapshot?.execution_history ?? []).length === 0 && (
                <EmptyBlock text="暂无执行记录" compact />
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </aside>
  );
}

function ReasonCard({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="workstation-control rounded-lg p-3">
      <div className="text-[14px] font-semibold leading-5">{title}</div>
      <div className="mt-2 space-y-1">
        {lines
          .filter(Boolean)
          .slice(0, 4)
          .map((line, index) => (
            <p
              key={`${line}-${index}`}
              className={cn(
                'text-[12px] leading-5',
                index === 0
                  ? 'line-clamp-2 font-semibold text-foreground'
                  : 'line-clamp-1 text-muted-foreground'
              )}
            >
              {line}
            </p>
          ))}
      </div>
    </div>
  );
}

function EvidenceStep({ title, text, sub }: { title: string; text: string; sub: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border/70 bg-white p-2 shadow-[var(--shadow-control)]">
      <div className="text-[11px] font-semibold leading-4">{title}</div>
      <p className="mt-1 line-clamp-3 text-[12px] leading-5 text-muted-foreground">
        {text || '--'}
      </p>
      <div className="mt-1 truncate font-mono text-[10px] leading-4 text-muted-foreground">
        {sub}
      </div>
    </div>
  );
}

function Metric({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-background p-2">
      <div className="flex items-center gap-1 text-[10px] font-semibold leading-4 text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 font-mono text-[14px] font-bold leading-5">{value}</div>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="workstation-control rounded-md px-2 py-1">
      <div className="text-[10px] leading-4 text-muted-foreground">{label}</div>
      <div className="number-figure text-[12px] font-semibold leading-4">{value}</div>
    </div>
  );
}

function EmptyBlock({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <div
      className={cn(
        'flex h-full min-h-[96px] items-center justify-center rounded-lg border border-dashed border-border bg-background text-center text-[12px] leading-5 text-muted-foreground',
        compact && 'min-h-0 px-3 py-3'
      )}
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4" />
        <span>{text}</span>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const ctx = useAppShell();
  
  const dispatchRefreshKey = React.useMemo(() => {
    return ctx.lastDispatchOutcome
      ? `${ctx.lastDispatchOutcome.trace_id}:${ctx.lastDispatchOutcome.finished_at}`
      : null;
  }, [ctx.lastDispatchOutcome]);

  const snapshotInput = React.useMemo(() => ({
    groupId: ctx.activeClusterId,
    displayDate: ctx.globalDate,
    strategyId: ctx.activeStrategyId,
    refreshKey: dispatchRefreshKey,
  }), [ctx.activeClusterId, ctx.globalDate, ctx.activeStrategyId, dispatchRefreshKey]);

  const snapshotState = useDashboardSnapshot(snapshotInput);
  const snapshot = snapshotState.data;
  const [selectedSymbol, setSelectedSymbol] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!selectedSymbol && snapshot?.default_symbol) {
      setSelectedSymbol(snapshot.default_symbol);
    }
    if (
      selectedSymbol &&
      snapshot &&
      !snapshot.recommendations.some((row) => row.symbol === selectedSymbol)
    ) {
      setSelectedSymbol(snapshot.default_symbol);
    }
  }, [selectedSymbol, snapshot]);

  const selected = React.useMemo(() => {
    if (!snapshot?.recommendations) return null;
    return (
      snapshot.recommendations.find((row) => row.symbol === selectedSymbol) ??
      snapshot.recommendations[0] ??
      null
    );
  }, [snapshot, selectedSymbol]);

  const traceId = React.useMemo(() => pickTraceId(snapshot?.meta.trace_id, selected), [snapshot?.meta.trace_id, selected]);

  React.useEffect(() => {
    if (traceId) {
      ctx.setActiveTraceId(traceId);
    }
  }, [ctx, traceId]);

  const detailInput = React.useMemo(() => ({
    symbol: selected?.symbol ?? null,
    traceId,
    groupId: ctx.activeClusterId,
    strategyId: ctx.activeStrategyId,
  }), [selected?.symbol, traceId, ctx.activeClusterId, ctx.activeStrategyId]);

  const detail = useStockDetail(detailInput);

  const evidenceInput = React.useMemo(() => ({
    symbol: selected?.symbol ?? null,
    traceId,
    groupId: ctx.activeClusterId,
  }), [selected?.symbol, traceId, ctx.activeClusterId]);

  const evidence = useStockEvidence(evidenceInput);

  const networkInput = React.useMemo(() => ({
    symbol: selected?.symbol ?? null,
    traceId,
    groupId: ctx.activeClusterId,
  }), [selected?.symbol, traceId, ctx.activeClusterId]);

  const network = useStockNetwork(networkInput);

  return (
    <div className="dashboard-grid">
      <RecommendationRail
        rows={snapshot?.recommendations ?? []}
        selectedSymbol={selected?.symbol ?? null}
        onSelect={(row) => setSelectedSymbol(row.symbol)}
      />
      <StockWorkspace
        selected={selected}
        snapshot={snapshot}
        detail={detail.data}
        evidence={evidence.data}
        network={network.data}
        loading={snapshotState.loading || detail.loading}
        detailError={detail.error}
      />
      <SystemRail snapshot={snapshot} />
      {snapshotState.error && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-[13px] text-rose-700 shadow dark:border-rose-900/50 dark:bg-rose-950 dark:text-rose-300">
          Dashboard 加载失败：{snapshotState.error}
        </div>
      )}
      <div className="fixed bottom-3 right-3 z-40 sm:bottom-4 sm:right-4">
        <CopyableId id={traceId} label="复制 Trace ID" />
      </div>

      <GitBranch className="pointer-events-none fixed bottom-3 left-4 h-4 w-4 text-muted-foreground/40 sm:bottom-4" />
    </div>
  );
}
