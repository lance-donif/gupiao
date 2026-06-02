import type { TraceCostOut, TraceEvent, TraceOverview, TraceStep } from '@/lib/api-types';

export interface TraceViewModel {
  trace_status_label: string;
  failure_summary: string;
  event_summary: string[];
  cost_summary: string;
}

const traceStatusLabels: Record<string, string> = {
  PENDING: '排队中',
  RUNNING: '执行中',
  COMPLETED: '已完成',
  SUCCESS: '已完成',
  DEGRADED: '降级完成',
  FAILED: '失败',
  failed: '失败',
  running: '执行中',
  success: '已完成',
};

export function buildTraceViewModel(input: {
  overview: TraceOverview | null;
  steps: TraceStep[];
  events: TraceEvent[];
  costs: TraceCostOut | null;
}): TraceViewModel {
  const failedStep = [...input.steps].reverse().find(step => step.status === 'failed' || step.status === 'FAILED');
  const errorEvent = [...input.events].reverse().find(event => event.level === 'ERROR');
  const firstCost = input.costs?.rows[0] ?? null;
  return {
    trace_status_label: input.overview ? (traceStatusLabels[input.overview.status] ?? input.overview.status) : '请选择执行记录',
    failure_summary: failedStep
      ? `${failedStep.node_name}: ${failedStep.error_code || '执行失败'}`
      : errorEvent
        ? `${errorEvent.event_type}: ${JSON.stringify(errorEvent.payload).slice(0, 80)}`
        : '未发现失败',
    event_summary: input.events.slice(-3).map(event => `${event.level} · ${event.event_type}`),
    cost_summary: input.costs && firstCost
      ? `${firstCost.model} · ${input.costs.total_tokens.toLocaleString()} tokens · $${input.costs.total_cost_usd.toFixed(4)}`
      : '暂无大模型成本统计',
  };
}
