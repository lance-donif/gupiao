import { describe, expect, it } from 'vitest';

import { buildTraceViewModel } from '../../../src/features/traces/trace-view-model';
import type { TraceCostOut, TraceEvent, TraceOverview, TraceStep } from '../../../src/lib/api-types';

const overview: TraceOverview = {
  trace_id: 'trace-1',
  status: 'FAILED',
  latest_phase: 'scoring',
  steps_total: 1,
  events_total: 1,
  total_tokens: 100,
  total_cost_usd: 0.01,
};

const failedStep: TraceStep = {
  id: 1,
  trace_id: 'trace-1',
  batch_id: null,
  group_id: null,
  flow: 'daily',
  node_name: '生成推荐',
  sequence_no: 1,
  status: 'failed',
  error_code: 'EMPTY_EVIDENCE',
  started_at: '',
  finished_at: null,
  duration_ms: 0,
  input_snapshot: {},
  output_snapshot: {},
  delta_snapshot: {},
  metrics: {},
};

const event: TraceEvent = {
  id: 1,
  trace_id: 'trace-1',
  batch_id: null,
  group_id: null,
  sequence_no: 1,
  event_type: 'LLM_ERROR',
  level: 'ERROR',
  payload: { message: 'bad schema' },
  created_at: '',
};

const costs: TraceCostOut = {
  trace_id: 'trace-1',
  total_cost_usd: 0.1234,
  total_tokens: 12345,
  rows: [{
    role: 'extract',
    model: 'gpt-5.5',
    provider: 'openai',
    calls: 2,
    prompt_tokens: 10000,
    completion_tokens: 2345,
    total_tokens: 12345,
    cost_usd: 0.1234,
  }],
};

describe('buildTraceViewModel', () => {
  it('prioritizes failed step over error event and formats cost summary', () => {
    const vm = buildTraceViewModel({ overview, steps: [failedStep], events: [event], costs });
    expect(vm.trace_status_label).toBe('失败');
    expect(vm.failure_summary).toBe('生成推荐: EMPTY_EVIDENCE');
    expect(vm.event_summary).toEqual(['ERROR · LLM_ERROR']);
    expect(vm.cost_summary).toBe('gpt-5.5 · 12,345 tokens · $0.1234');
  });

  it('handles empty states', () => {
    expect(buildTraceViewModel({ overview: null, steps: [], events: [], costs: null })).toMatchObject({
      trace_status_label: '请选择执行记录',
      failure_summary: '未发现失败',
      cost_summary: '暂无大模型成本统计',
    });
  });
});
