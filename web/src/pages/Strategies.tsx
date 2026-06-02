import * as React from 'react';
import { Copy, Edit, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type {
  StrategyConfig,
  StrategyDefinition,
  StrategyProfitPayload,
  StrategyProfitSummary,
} from '@/lib/api-types';
import { useAppShell } from '@/app/app-context';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { buildStrategyViewModel } from '@/features/strategies/strategy-view-model';
import { api } from '@/lib/api';
import { cn, formatPercent } from '@/lib/utils';

function defaultConfig(): StrategyConfig {
  return {
    limit: 30,
    maxPerSignalType: 5,
    maxPrice: 40,
    exclude688: true,
    excludeST: true,
    recent5dGainMaxPct: 0.2,
    minFinalScore: null,
    minEvidenceScore: null,
    minExposureScore: null,
    minMarketScore: null,
    includeSignalTypes: [],
    excludeSignalTypes: [],
    weights: { evidence: 1, graph: 1, exposure: 1, market: 1 },
  };
}

function mergeConfig(strategy?: StrategyDefinition): StrategyConfig {
  const base = defaultConfig();
  return {
    ...base,
    ...(strategy?.config_json ?? {}),
    weights: {
      ...base.weights,
      ...(strategy?.config_json?.weights ?? {}),
    },
    includeSignalTypes: [...(strategy?.config_json?.includeSignalTypes ?? [])],
    excludeSignalTypes: [...(strategy?.config_json?.excludeSignalTypes ?? [])],
  };
}

export default function StrategiesPage() {
  const ctx = useAppShell();
  const { toast } = useToast();
  const [loading, setLoading] = React.useState(false);
  const [strategies, setStrategies] = React.useState<StrategyDefinition[]>([]);
  const [profits, setProfits] = React.useState<StrategyProfitPayload | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<StrategyDefinition | null>(null);
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [enabled, setEnabled] = React.useState(true);
  const [config, setConfig] = React.useState<StrategyConfig>(defaultConfig);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [strategyPayload, profitPayload] = await Promise.all([
        api.listStrategies(ctx.activeClusterId),
        api.getStrategyProfits(ctx.activeClusterId, ctx.globalDate),
      ]);
      setStrategies(strategyPayload.items);
      setProfits(profitPayload);
      setSelectedId((current) => current ?? strategyPayload.items[0]?.id ?? null);
    } catch (error) {
      toast({ title: '读取策略失败', description: String(error), variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [ctx.activeClusterId, ctx.globalDate, toast]);

  React.useEffect(() => {
    void load();
  }, [load]);

  function openEditor(strategy?: StrategyDefinition) {
    setEditing(strategy ?? null);
    setName(strategy?.name ?? '');
    setDescription(strategy?.description ?? '');
    setEnabled(strategy?.enabled ?? true);
    setConfig(mergeConfig(strategy));
    setEditorOpen(true);
  }

  async function saveStrategy() {
    const safeName = name.trim();
    if (!safeName) {
      toast({ title: '策略名称不能为空', variant: 'destructive' });
      return;
    }
    const payload = {
      group_id: ctx.activeClusterId,
      name: safeName,
      description: description.trim() || null,
      enabled,
      config_json: config,
    };
    try {
      if (editing) {
        await api.updateStrategy(editing.id, payload);
      } else {
        await api.createStrategy(payload);
      }
      setEditorOpen(false);
      await ctx.refreshStrategies();
      await load();
    } catch (error) {
      toast({ title: '保存策略失败', description: String(error), variant: 'destructive' });
    }
  }

  async function toggleStrategy(strategy: StrategyDefinition) {
    try {
      await api.updateStrategy(strategy.id, {
        group_id: ctx.activeClusterId,
        enabled: !strategy.enabled,
        config_json: strategy.config_json,
      });
      await ctx.refreshStrategies();
      await load();
    } catch (error) {
      toast({ title: '切换失败', description: String(error), variant: 'destructive' });
    }
  }

  async function copyStrategy(strategy: StrategyDefinition) {
    try {
      await api.copyStrategy(strategy.id, {
        group_id: ctx.activeClusterId,
        name: `${strategy.name} 副本`,
        enabled: false,
      });
      await ctx.refreshStrategies();
      await load();
    } catch (error) {
      toast({ title: '复制失败', description: String(error), variant: 'destructive' });
    }
  }

  async function deleteStrategy(strategy: StrategyDefinition) {
    try {
      await api.deleteStrategy(strategy.id, ctx.activeClusterId);
      await ctx.refreshStrategies();
      await load();
    } catch (error) {
      toast({ title: '删除失败', description: String(error), variant: 'destructive' });
    }
  }

  const summaries = profits?.summaries ?? [];
  const selected = strategies.find((item) => item.id === selectedId) ?? strategies[0] ?? null;
  const selectedSummary = selected
    ? (summaries.find((item) => item.strategy_id === selected.id) ?? null)
    : null;
  const selectedVm = selected ? buildStrategyViewModel(selected, selectedSummary) : null;

  return (
    <div className="page-workbench grid min-h-[calc(100vh-48px)] grid-cols-1 gap-3 overflow-auto p-3 xl:h-[calc(100vh-48px)] xl:grid-cols-[minmax(520px,1fr)_360px] xl:overflow-hidden">
      <section className="workstation-panel-strong flex min-h-0 flex-col rounded-lg">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-border/70 px-4">
          <div>
            <h1 className="text-[18px] font-semibold leading-6">策略工作台</h1>
            <p className="number-figure text-[12px] leading-4 text-muted-foreground">
              交易日 {ctx.globalDate}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              刷新
            </Button>
            <Button size="sm" onClick={() => openEditor()}>
              <Plus className="h-3.5 w-3.5" />
              新建
            </Button>
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1 p-3 pt-2">
          <div className="space-y-2 md:hidden">
            {strategies.map((strategy) => {
              const summary = summaries.find((item) => item.strategy_id === strategy.id) ?? null;
              const vm = buildStrategyViewModel(strategy, summary);
              return (
                <div
                  key={strategy.id}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    'workstation-control w-full rounded-lg p-3 text-left transition-colors',
                    selected?.id === strategy.id && 'bg-sky-50/80 shadow-[inset_3px_0_0_#2563eb]'
                  )}
                  onClick={() => setSelectedId(strategy.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSelectedId(strategy.id);
                    }
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="line-clamp-1 text-[13px] font-semibold">{strategy.name}</div>
                      <div className="mt-1 line-clamp-1 text-[11px] text-muted-foreground">
                        {strategy.description || '无描述'}
                      </div>
                    </div>
                    <Badge
                      variant={strategy.enabled ? 'default' : 'secondary'}
                      className="h-5 shrink-0 px-1.5 text-[10px]"
                    >
                      {vm.enabled_label}
                    </Badge>
                  </div>
                  <div className="mt-3 grid gap-2">
                    <SummaryRow label="筛选" value={vm.filter_summary} />
                    <SummaryRow label="权重" value={vm.weight_summary} mono />
                  </div>
                  <div
                    className="mt-3 flex justify-end gap-1"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => openEditor(strategy)}
                      title="编辑"
                    >
                      <Edit className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => void copyStrategy(strategy)}
                      title="复制"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
            {strategies.length === 0 && <Empty text="当前集群无策略。" />}
          </div>
          <Table className="hidden overflow-hidden rounded-lg text-[12px] md:table">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[260px]">策略</TableHead>
                <TableHead>筛选摘要</TableHead>
                <TableHead>权重</TableHead>
                <TableHead className="w-[120px]">状态</TableHead>
                <TableHead className="w-[120px] text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {strategies.map((strategy) => {
                const summary = summaries.find((item) => item.strategy_id === strategy.id) ?? null;
                const vm = buildStrategyViewModel(strategy, summary);
                return (
                  <TableRow
                    key={strategy.id}
                    className={cn(
                      'cursor-pointer transition-colors hover:bg-white/80',
                      selected?.id === strategy.id &&
                        'bg-sky-50/80 shadow-[inset_3px_0_0_#2563eb] dark:bg-sky-950/20'
                    )}
                    onClick={() => setSelectedId(strategy.id)}
                  >
                    <TableCell>
                      <div className="font-semibold">{strategy.name}</div>
                      <div className="mt-1 line-clamp-1 text-[11px] text-muted-foreground">
                        {strategy.description || '无描述'}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{vm.filter_summary}</TableCell>
                    <TableCell className="number-figure text-[11px]">{vm.weight_summary}</TableCell>
                    <TableCell>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void toggleStrategy(strategy);
                        }}
                      >
                        <Badge
                          variant={strategy.enabled ? 'default' : 'secondary'}
                          className="h-5 px-1.5 text-[10px]"
                        >
                          {vm.enabled_label}
                        </Badge>
                      </button>
                    </TableCell>
                    <TableCell className="text-right">
                      <div
                        className="flex justify-end gap-1"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openEditor(strategy)}
                          title="编辑"
                        >
                          <Edit className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => void copyStrategy(strategy)}
                          title="复制"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-7 w-7" title="删除">
                              <Trash2 className="h-3.5 w-3.5 text-rose-600" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>确认删除策略？</AlertDialogTitle>
                              <AlertDialogDescription>
                                将删除「{strategy.name}」策略定义，历史收益记录保留。
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => void deleteStrategy(strategy)}
                                className="bg-rose-600 text-white hover:bg-rose-700"
                              >
                                删除
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {strategies.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    当前集群无策略。
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </section>

      <aside className="flex min-h-0 flex-col gap-3 overflow-visible xl:overflow-hidden">
        <Card className="h-auto shrink-0">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-[14px]">策略摘要</CardTitle>
            <CardDescription className="text-[12px]">
              {selectedVm?.performance_summary || '请选择策略'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 p-4 pt-0 text-[12px]">
            <SummaryRow label="筛选" value={selectedVm?.filter_summary || '--'} />
            <SummaryRow label="权重" value={selectedVm?.weight_summary || '--'} mono />
            <SummaryRow label="状态" value={selectedVm?.enabled_label || '--'} />
          </CardContent>
        </Card>
        <Card className="min-h-0 flex-1">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-[14px]">收益概览</CardTitle>
            <CardDescription className="text-[12px]">
              按已结算收益统计，未结算样本单独展示
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 p-4 pt-0 text-[12px]">
            {summaries.map((item) => (
              <SettlementCard key={item.strategy_id} item={item} />
            ))}
            {summaries.length === 0 && <Empty text="暂无收益样本" />}
          </CardContent>
        </Card>
      </aside>

      <StrategySheet
        open={editorOpen}
        onOpenChange={setEditorOpen}
        editing={editing}
        name={name}
        setName={setName}
        description={description}
        setDescription={setDescription}
        enabled={enabled}
        setEnabled={setEnabled}
        config={config}
        setConfig={setConfig}
        onSave={() => void saveStrategy()}
      />
    </div>
  );
}

function StrategySheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: StrategyDefinition | null;
  name: string;
  setName: (value: string) => void;
  description: string;
  setDescription: (value: string) => void;
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  config: StrategyConfig;
  setConfig: React.Dispatch<React.SetStateAction<StrategyConfig>>;
  onSave: () => void;
}) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent className="overflow-y-auto sm:max-w-[420px]">
        <SheetHeader className="border-b pb-4">
          <SheetTitle>{props.editing ? '编辑策略配置' : '创建新策略'}</SheetTitle>
          <SheetDescription>配置筛选条件和四维评分权重。</SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-5 pb-6 text-[12px]">
          <div className="workstation-control space-y-3 rounded-lg p-3">
            <Field label="策略名称">
              <Input value={props.name} onChange={(event) => props.setName(event.target.value)} />
            </Field>
            <Field label="描述说明">
              <Input
                value={props.description}
                onChange={(event) => props.setDescription(event.target.value)}
              />
            </Field>
          </div>
          <div className="workstation-control space-y-3 rounded-lg p-3">
            <label className="flex items-center gap-2 rounded-md bg-white px-2 py-2 shadow-[var(--shadow-control)]">
              <input
                type="checkbox"
                checked={props.enabled}
                onChange={(event) => props.setEnabled(event.target.checked)}
              />
              设为启用状态
            </label>
            <div className="grid grid-cols-2 gap-3">
              <Field label="推荐限制数量">
                <Input
                  type="number"
                  value={props.config.limit}
                  onChange={(event) =>
                    props.setConfig((current) => ({
                      ...current,
                      limit: Number(event.target.value),
                    }))
                  }
                />
              </Field>
              <Field label="股票价格上限">
                <Input
                  type="number"
                  value={props.config.maxPrice ?? ''}
                  onChange={(event) =>
                    props.setConfig((current) => ({
                      ...current,
                      maxPrice: event.target.value ? Number(event.target.value) : null,
                    }))
                  }
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <CheckBox
                label="排除 688"
                checked={props.config.exclude688}
                onChange={(value) =>
                  props.setConfig((current) => ({ ...current, exclude688: value }))
                }
              />
              <CheckBox
                label="排除 ST"
                checked={props.config.excludeST}
                onChange={(value) =>
                  props.setConfig((current) => ({ ...current, excludeST: value }))
                }
              />
            </div>
          </div>
          <div className="workstation-control rounded-lg p-3">
            <div className="mb-3 text-[12px] font-semibold">评分权重</div>
            <div className="grid grid-cols-4 gap-2">
              {(['evidence', 'graph', 'exposure', 'market'] as const).map((key) => (
                <Field
                  key={key}
                  label={
                    key === 'evidence'
                      ? '证据'
                      : key === 'graph'
                        ? '图谱'
                        : key === 'exposure'
                          ? '暴露'
                          : '市场'
                  }
                >
                  <Input
                    type="number"
                    step="0.1"
                    value={props.config.weights[key]}
                    onChange={(event) =>
                      props.setConfig((current) => ({
                        ...current,
                        weights: { ...current.weights, [key]: Number(event.target.value) },
                      }))
                    }
                  />
                </Field>
              ))}
            </div>
          </div>
          <Button className="w-full" onClick={props.onSave}>
            保存策略设置
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SummaryRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="workstation-control rounded-md p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn('mt-1 line-clamp-2 leading-5', mono && 'number-figure text-[11px]')}>
        {value}
      </div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-white p-1 shadow-[var(--shadow-control)]">
      <div className="number-figure font-semibold text-foreground">{value}</div>
      <div>{label}</div>
    </div>
  );
}

function SettlementCard({ item }: { item: StrategyProfitSummary }) {
  const settled = pickSettledHorizon(item);
  return (
    <div className="workstation-control rounded-lg p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{item.strategy_name}</span>
        <Badge variant="outline" className="number-figure h-5 px-1.5 text-[10px]">
          {item.run_count} 期
        </Badge>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Mini
          label={settled ? `${settled.label}平均收益` : '平均收益'}
          value={settled ? formatPercent(settled.summary.avg_return_pct, 2) : '--'}
        />
        <Mini
          label={settled ? `${settled.label}胜率` : '待结算'}
          value={
            settled
              ? formatPercent(settled.summary.win_rate, 0)
              : String(item.horizon_summaries?.t1.pending_count ?? item.recommendation_count)
          }
        />
      </div>
      <div className="mt-2 text-[11px] text-muted-foreground">
        T+1 {item.horizon_summaries?.t1.final_count ?? 0}/
        {item.horizon_summaries?.t1.sample_count ?? 0}，T+3{' '}
        {item.horizon_summaries?.t3.final_count ?? 0}/{item.horizon_summaries?.t3.sample_count ?? 0}
        ，T+5 {item.horizon_summaries?.t5.final_count ?? 0}/
        {item.horizon_summaries?.t5.sample_count ?? 0}
      </div>
    </div>
  );
}

function pickSettledHorizon(item: StrategyProfitSummary): {
  label: string;
  summary: NonNullable<StrategyProfitSummary['horizon_summaries']>['t1'];
} | null {
  const horizons = item.horizon_summaries;
  if (!horizons) {
    return null;
  }
  const options: Array<[string, typeof horizons.t1]> = [
    ['T+5', horizons.t5],
    ['T+3', horizons.t3],
    ['T+1', horizons.t1],
  ];
  const settled = options.find(([, summary]) => summary.final_count > 0);
  return settled ? { label: settled[0], summary: settled[1] } : null;
}

function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-6 text-center text-[12px] text-muted-foreground">
      {text}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1.5">
      <span className="block font-semibold">{label}</span>
      {children}
    </label>
  );
}

function CheckBox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 rounded-md bg-white px-2 py-2 shadow-[var(--shadow-control)]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}
