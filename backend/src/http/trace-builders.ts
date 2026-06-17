import type {
  GraphKind,
  IClusterSummaryRecord,
  IClusterVersionRecord,
  ITraceRecord,
} from './runtime-types.js';


import { nowBeijingDateTime } from './beijing-time.js';

export const DEFAULT_CLUSTER_ID = 'main';
export const DEFAULT_CLUSTER_NAME = '主集群';
const DEFAULT_CLUSTER_DESCRIPTION = '本地兼容层默认集群';

export const createDefaultCluster = (): IClusterSummaryRecord => ({
  id: DEFAULT_CLUSTER_ID,
  name: DEFAULT_CLUSTER_NAME,
  description: DEFAULT_CLUSTER_DESCRIPTION,
  active_version_id: `${DEFAULT_CLUSTER_ID}-v1`,
  active_version: 1,
  last_batch_status: null,
  last_target_trading_date: null,
  updated_at: nowBeijingDateTime(),
});

export const createDefaultClusterVersion = (groupId: string): IClusterVersionRecord => ({
  id: `${groupId}-v1`,
  group_id: groupId,
  version: 1,
  prompts_dir: `tmp/http-runtime/prompts/${groupId}/v1`,
  created_at: nowBeijingDateTime(),
  status: '已升级',
  source_feedback_id: null,
  source_feedback_reason: null,
  confirmed_by: 'system',
  confirmed_at: nowBeijingDateTime(),
  previous_version_id: null,
});




export const buildRuntimeGraph = (
  trace: ITraceRecord,
  graphKind: GraphKind,
  maxNodes: number,
): Record<string, unknown> => {
  const steps = trace.steps.slice(0, Math.max(1, maxNodes));
  const nodes = steps.map(step => ({
    id: `${step.flow}:${step.sequence_no}:${step.node_name}`,
    label: step.node_name,
    type: graphKind === 'execution' ? 'runtime_step' : 'causal_entity',
    status: step.status,
    data: {
      started_at: step.started_at,
      finished_at: step.finished_at,
      duration_ms: step.duration_ms,
      drift_count: step.drift_report.drift_count,
    },
  }));
  const edges = steps.slice(1).map((step, index) => ({
    source: `${steps[index]?.flow}:${steps[index]?.sequence_no}:${steps[index]?.node_name}`,
    target: `${step.flow}:${step.sequence_no}:${step.node_name}`,
    label: graphKind === 'execution' ? 'next' : 'influences',
    type: graphKind === 'execution' ? 'sequence' : 'causal',
    data: {
      sequence_no: step.sequence_no,
    },
  }));
  return {
    trace_id: trace.trace_id,
    graph_kind: graphKind,
    nodes,
    edges,
  };
};
