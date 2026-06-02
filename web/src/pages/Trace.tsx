import type * as React from 'react';
import { useParams } from 'react-router';
import { AlertTriangle, Clock, Database, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { buildTraceViewModel } from '@/features/traces/trace-view-model';
import { useTraceDetail } from '@/hooks/use-dashboard-data';
import { cn, formatMinute, formatScore } from '@/lib/utils';

export default function TracePage() {
  const params = useParams();
  const traceId = params.traceId ? decodeURIComponent(params.traceId) : '';
  const { overview, steps, events, costs } = useTraceDetail(traceId);
  const vm = buildTraceViewModel({
    overview: overview.data,
    steps: steps.data?.rows ?? [],
    events: events.data?.rows ?? [],
    costs: costs.data,
  });

  if (!traceId) {
    return (
      <div className="min-h-[calc(100vh-48px)] overflow-auto bg-background p-3 xl:h-[calc(100vh-48px)] xl:overflow-hidden">
        <Empty text="请选择执行记录" />
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-48px)] flex-col gap-3 overflow-auto bg-background p-3 text-[12px] xl:h-[calc(100vh-48px)] xl:overflow-hidden">
      <section className="grid h-auto min-h-[112px] shrink-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_160px_160px_160px]">
        <Card>
          <CardContent className="flex h-full items-center justify-between gap-4 p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-[18px] font-semibold leading-6">执行详情</h1>
                <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                  {vm.trace_status_label}
                </Badge>
              </div>
              <div className="mt-1 truncate font-mono text-[10px] leading-4 text-muted-foreground">
                {traceId}
              </div>
              <div className="mt-2 line-clamp-1 text-[12px] leading-5 text-muted-foreground">
                失败摘要：{vm.failure_summary}
              </div>
            </div>
            {overview.error && <ErrorPill text={overview.error} />}
          </CardContent>
        </Card>
        <TraceMetric
          label="阶段"
          value={overview.data?.latest_phase ?? '--'}
          icon={<Zap className="h-4 w-4 text-amber-600" />}
        />
        <TraceMetric
          label="Token"
          value={Number(overview.data?.total_tokens ?? 0).toLocaleString()}
          icon={<Database className="h-4 w-4 text-sky-600" />}
        />
        <TraceMetric
          label="成本"
          value={`$${formatScore(overview.data?.total_cost_usd ?? 0, 4)}`}
          icon={<Clock className="h-4 w-4 text-emerald-600" />}
        />
      </section>

      <section className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="min-h-0">
          <Tabs defaultValue="steps" className="flex h-full min-h-0 flex-col">
            <CardHeader className="h-12 shrink-0 border-b border-border/70 p-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-[14px]">执行时间线</CardTitle>
                <TabsList className="h-8">
                  <TabsTrigger value="steps" className="h-6 px-3 text-[12px]">
                    步骤
                  </TabsTrigger>
                  <TabsTrigger value="events" className="h-6 px-3 text-[12px]">
                    事件
                  </TabsTrigger>
                  <TabsTrigger value="costs" className="h-6 px-3 text-[12px]">
                    成本
                  </TabsTrigger>
                </TabsList>
              </div>
            </CardHeader>
            <TabsContent value="steps" className="m-0 min-h-0 flex-1">
              <StepsTable rows={steps.data?.rows ?? []} />
            </TabsContent>
            <TabsContent value="events" className="m-0 min-h-0 flex-1">
              <EventsList rows={events.data?.rows ?? []} />
            </TabsContent>
            <TabsContent value="costs" className="m-0 min-h-0 flex-1">
              <CostsList rows={costs.data?.rows ?? []} />
            </TabsContent>
          </Tabs>
        </Card>

        <aside className="flex min-h-0 flex-col gap-3 overflow-visible xl:overflow-hidden">
          <Card className="shrink-0">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-[14px]">诊断摘要</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 p-4 pt-0">
              <Summary label="状态" value={vm.trace_status_label} />
              <Summary label="失败" value={vm.failure_summary} />
              <Summary label="成本" value={vm.cost_summary} mono />
            </CardContent>
          </Card>
          <Card className="min-h-0 flex-1">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-[14px]">最近事件</CardTitle>
            </CardHeader>
            <CardContent className="min-h-0 p-4 pt-0">
              <ScrollArea className="h-full">
                <div className="space-y-2 pr-2">
                  {vm.event_summary.map((item) => (
                    <Summary key={item} label="事件" value={item} />
                  ))}
                  {vm.event_summary.length === 0 && <Empty text="暂无事件记录" />}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </aside>
      </section>
    </div>
  );
}

function StepsTable({
  rows,
}: {
  rows: NonNullable<ReturnType<typeof useTraceDetail>['steps']['data']>['rows'];
}) {
  return (
    <ScrollArea className="h-full">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>步骤</TableHead>
            <TableHead className="w-[90px]">状态</TableHead>
            <TableHead className="w-[130px]">开始</TableHead>
            <TableHead className="w-[130px]">结束</TableHead>
            <TableHead className="w-[90px] text-right">耗时</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                <div className="font-semibold">{row.node_name}</div>
                {row.error_code && (
                  <div className="mt-1 font-mono text-[10px] text-rose-600">{row.error_code}</div>
                )}
                {(Object.keys(row.input_snapshot).length > 0 ||
                  Object.keys(row.output_snapshot).length > 0) && (
                  <pre className="mt-2 max-h-24 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[10px] leading-4 text-muted-foreground">
                    {JSON.stringify(
                      { input: row.input_snapshot, output: row.output_snapshot },
                      null,
                      2
                    )}
                  </pre>
                )}
              </TableCell>
              <TableCell>
                <StatusBadge status={row.status} />
              </TableCell>
              <TableCell className="font-mono text-[11px] text-muted-foreground">
                {formatMinute(row.started_at)}
              </TableCell>
              <TableCell className="font-mono text-[11px] text-muted-foreground">
                {formatMinute(row.finished_at)}
              </TableCell>
              <TableCell className="text-right font-mono text-[11px]">
                {row.duration_ms ? `${row.duration_ms.toLocaleString()}ms` : '--'}
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                暂无步骤记录
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}

function EventsList({
  rows,
}: {
  rows: NonNullable<ReturnType<typeof useTraceDetail>['events']['data']>['rows'];
}) {
  return (
    <ScrollArea className="h-full p-4">
      <div className="space-y-2 pr-2">
        {rows.map((row) => (
          <div key={row.id} className="rounded-lg border border-border bg-background p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold">{row.event_type}</div>
              <Badge
                variant={
                  row.level === 'ERROR'
                    ? 'destructive'
                    : row.level === 'WARN'
                      ? 'secondary'
                      : 'outline'
                }
                className="h-5 px-1.5 text-[10px]"
              >
                {row.level}
              </Badge>
            </div>
            <div className="mt-1 font-mono text-[10px] text-muted-foreground">
              {formatMinute(row.created_at)}
            </div>
            {Object.keys(row.payload).length > 0 && (
              <pre className="mt-2 max-h-28 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[10px] leading-4 text-muted-foreground">
                {JSON.stringify(row.payload, null, 2)}
              </pre>
            )}
          </div>
        ))}
        {rows.length === 0 && <Empty text="暂无事件记录" />}
      </div>
    </ScrollArea>
  );
}

function CostsList({
  rows,
}: {
  rows: NonNullable<ReturnType<typeof useTraceDetail>['costs']['data']>['rows'];
}) {
  return (
    <ScrollArea className="h-full p-4">
      <div className="space-y-2 pr-2">
        {rows.map((row) => (
          <div
            key={`${row.role}-${row.model}`}
            className="rounded-lg border border-border bg-background p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold">{row.role}</div>
              <Badge variant="secondary" className="h-5 px-1.5 font-mono text-[10px]">
                {row.model}
              </Badge>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-center text-[11px] text-muted-foreground">
              <Mini label="调用" value={String(row.calls)} />
              <Mini label="Token" value={row.total_tokens.toLocaleString()} />
              <Mini label="USD" value={`$${formatScore(row.cost_usd, 4)}`} />
            </div>
          </div>
        ))}
        {rows.length === 0 && <Empty text="暂无大模型成本统计" />}
      </div>
    </ScrollArea>
  );
}

function TraceMetric({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex h-full items-center gap-3 p-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
          {icon}
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-muted-foreground">{label}</div>
          <div className="truncate font-mono text-[15px] font-bold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant={
        status === 'failed' || status === 'FAILED'
          ? 'destructive'
          : status === 'running'
            ? 'default'
            : 'outline'
      }
      className={cn(
        'h-5 px-1.5 font-mono text-[10px]',
        (status === 'success' || status === 'SUCCESS') && 'border-emerald-200 text-emerald-600'
      )}
    >
      {status}
    </Badge>
  );
}

function Summary({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="text-[11px] font-semibold text-muted-foreground">{label}</div>
      <div
        className={cn('mt-1 line-clamp-2 text-[12px] leading-5', mono && 'font-mono text-[11px]')}
      >
        {value}
      </div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border/70 p-1">
      <div className="font-mono font-semibold text-foreground">{value}</div>
      <div>{label}</div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex min-h-[120px] items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground">
      {text}
    </div>
  );
}

function ErrorPill({ text }: { text: string }) {
  return (
    <div className="flex max-w-[320px] items-center gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="line-clamp-2 text-[12px]">{text}</span>
    </div>
  );
}
