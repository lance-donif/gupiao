import type {
  GraphKind,
  IClusterSummaryRecord,
  IClusterVersionRecord,
  INodeResultPayload,
  IRuntimeBatchRecord,
  IRuntimeNode,
  ITraceCostRowRecord,
  ITraceEventRecord,
  ITraceRecord,
  ITraceStepRecord,
} from './runtime-types.js';
import type { IBackendArtifacts, IDispatchDailyInput } from './types.js';
import { nowBeijingDateTime, toEpochSeconds } from './beijing-time.js';

export const DEFAULT_CLUSTER_ID = 'main';
export const DEFAULT_CLUSTER_NAME = '主集群';
const DEFAULT_CLUSTER_DESCRIPTION = '本地兼容层默认集群';

const quoteBySymbol = (artifacts: IBackendArtifacts): Map<string, number> => {
  const map = new Map<string, number>();
  for (const row of artifacts.stockPayload.data) {
    map.set(row.symbol, row.price);
  }
  return map;
};

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

const createRuntimeNodes = (artifacts: IBackendArtifacts): readonly IRuntimeNode[] => {
  const now = nowBeijingDateTime();
  return [
    {
      node_id: 'news_ingest',
      node_label: '读取新闻快照',
      sequence_no: 1,
      status: 'completed',
      total_count: 3,
      current_index: 1,
      current_label: artifacts.graphSnapshot.sourceNewsFilePath,
      has_result: true,
      started_at: now,
      updated_at: now,
      finished_at: now,
    },
    {
      node_id: 'graph_build',
      node_label: '构建亲友网络',
      sequence_no: 2,
      status: 'completed',
      total_count: 3,
      current_index: 2,
      current_label: `${artifacts.graphSnapshot.graph.nodes.length} nodes`,
      has_result: true,
      started_at: now,
      updated_at: now,
      finished_at: now,
    },
    {
      node_id: 'recommendation',
      node_label: '生成推荐',
      sequence_no: 3,
      status: 'completed',
      total_count: 3,
      current_index: 3,
      current_label: `${artifacts.recommendationFile.recommendations.length} stocks`,
      has_result: true,
      started_at: now,
      updated_at: now,
      finished_at: now,
    },
  ];
};

const createTraceSteps = (
  traceId: string,
  batchId: string,
  groupId: string,
  nodes: readonly IRuntimeNode[],
): readonly ITraceStepRecord[] => {
  return nodes.map((node, index) => {
    const duration = 120 + index * 40;
    return {
      id: index + 1,
      trace_id: traceId,
      batch_id: batchId,
      group_id: groupId,
      flow: 'night',
      node_name: node.node_id,
      sequence_no: node.sequence_no,
      status: node.status === 'completed' ? 'ok' : node.status,
      error_code: null,
      started_at: node.started_at ?? nowBeijingDateTime(),
      finished_at: node.finished_at,
      duration_ms: duration,
      input_snapshot: {
        node_label: node.node_label,
        current_label: node.current_label,
      },
      output_snapshot: {
        status: node.status,
        has_result: node.has_result,
      },
      delta_snapshot: {
        duration_ms: duration,
      },
      metrics: {
        progress: node.total_count === 0 ? 0 : Number((node.current_index / node.total_count).toFixed(4)),
      },
      drift_report: {
        layer_level: index + 1,
        new_entities: [],
        disappeared_entities: [],
        polarity_flips: [],
        relation_shifts: [],
        drift_count: 0,
      },
    };
  });
};

const createTraceEvents = (
  traceId: string,
  batchId: string,
  groupId: string,
  nodes: readonly IRuntimeNode[],
): readonly ITraceEventRecord[] => {
  return nodes.flatMap((node, index) => {
    const base = index * 2;
    const createdAt = node.updated_at ?? nowBeijingDateTime();
    return [
      {
        id: base + 1,
        trace_id: traceId,
        batch_id: batchId,
        group_id: groupId,
        sequence_no: node.sequence_no,
        event_type: 'node_started',
        level: 'INFO',
        payload: { node_id: node.node_id, label: node.node_label },
        created_at: createdAt,
      },
      {
        id: base + 2,
        trace_id: traceId,
        batch_id: batchId,
        group_id: groupId,
        sequence_no: node.sequence_no,
        event_type: 'node_finished',
        level: 'INFO',
        payload: { node_id: node.node_id, status: node.status },
        created_at: createdAt,
      },
    ];
  });
};

const createTraceCosts = (): readonly ITraceCostRowRecord[] => {
  return [
    {
      role: 'planner',
      model: 'compat-model-v1',
      provider: 'local',
      calls: 1,
      prompt_tokens: 256,
      completion_tokens: 128,
      total_tokens: 384,
      cost_usd: 0.0012,
      budget_exceeded_calls: 0,
      degraded_calls: 0,
    },
    {
      role: 'executor',
      model: 'compat-model-v1',
      provider: 'local',
      calls: 2,
      prompt_tokens: 420,
      completion_tokens: 260,
      total_tokens: 680,
      cost_usd: 0.0021,
      budget_exceeded_calls: 0,
      degraded_calls: 0,
    },
  ];
};

const createNodeResultSections = (
  node: IRuntimeNode,
  artifacts: IBackendArtifacts,
): readonly Record<string, unknown>[] => {
  if (node.node_id === 'recommendation') {
    const prices = quoteBySymbol(artifacts);
    return artifacts.recommendationFile.recommendations.slice(0, 20).map((item, index) => ({
      rank: index + 1,
      symbol: item.symbol,
      name: item.stockName,
      score: item.score,
      industry: item.industry,
      latest_close: prices.get(item.symbol) ?? null,
      reason: item.reasons.join('；'),
    }));
  }
  if (node.node_id === 'graph_build') {
    return artifacts.graphSnapshot.graph.relationships.slice(0, 30).map(relation => ({
      source: relation.sourceKeyword,
      target: relation.targetKeyword,
      type: relation.relationType,
      confidence: relation.confidence,
      label: `${relation.sourceKeyword} -> ${relation.targetKeyword}`,
    }));
  }
  return artifacts.graphSnapshot.graph.nodes.slice(0, 30).map(item => ({
    keyword: item.keyword,
    category: item.category,
    frequency: item.frequency,
    temperature: item.temperature,
  }));
};

export const buildBatchTraceAndNodeResults = (input: {
  dispatch: IDispatchDailyInput;
  artifacts: IBackendArtifacts;
  groupVersionId: string;
}): {
  readonly batch: IRuntimeBatchRecord;
  readonly trace: ITraceRecord;
  readonly nodeResults: Record<string, INodeResultPayload>;
} => {
  const now = nowBeijingDateTime();
  const safeDate = input.dispatch.targetDate.replace(/[^0-9-]/g, '');
  const uniq = Date.now();
  const traceId = `trace-${input.dispatch.groupId}-${safeDate}-${uniq}`;
  const batchId = `batch-${input.dispatch.groupId}-${safeDate}-${uniq}`;
  const nodes = createRuntimeNodes(input.artifacts);
  const batch: IRuntimeBatchRecord = {
    id: batchId,
    group_id: input.dispatch.groupId,
    group_version_id: input.groupVersionId,
    target_trading_date: input.dispatch.targetDate,
    status: 'COMPLETED',
    trace_id: traceId,
    run_fingerprint: `${input.dispatch.groupId}:${input.dispatch.targetDate}:${uniq}`,
    enqueued_at: toEpochSeconds(now),
    started_at: now,
    finished_at: now,
    graph_done: true,
    chroma_done: true,
    market_cached_done: true,
    schema_checked_count: input.artifacts.recommendationFile.recommendations.length,
    schema_mismatch_count: 0,
    schema_mismatch_rate: 0,
    promote_blocked_by_quality: false,
    quality_warnings_json: '[]',
    error_code: null,
    error_message: null,
    progress_percent: 100,
    current_stage: 'completed',
    current_stage_index: nodes.length,
    remaining_node_count: 0,
    nodes,
    created_at: now,
  };
  const trace: ITraceRecord = {
    trace_id: traceId,
    batch_id: batchId,
    group_id: input.dispatch.groupId,
    status: 'COMPLETED',
    latest_phase: 'reflecting',
    started_at: now,
    finished_at: now,
    budget_usd: 0.5,
    budget_exceeded: false,
    steps: createTraceSteps(traceId, batchId, input.dispatch.groupId, nodes),
    events: createTraceEvents(traceId, batchId, input.dispatch.groupId, nodes),
    costs: createTraceCosts(),
  };
  const nodeResults = Object.fromEntries(
    nodes.map((node) => {
      const sectionItems = createNodeResultSections(node, input.artifacts);
      const payload: INodeResultPayload = {
        batch_id: batchId,
        node_id: node.node_id,
        node_label: node.node_label,
        status: node.status,
        source: 'node_snapshot',
        summary_cards: [
          { key: 'status', label: '状态', value: node.status },
          { key: 'updated_at', label: '更新时间', value: node.updated_at ?? now },
          { key: 'items', label: '结果条数', value: String(sectionItems.length) },
        ],
        sections: [
          {
            key: 'summary',
            label: '摘要',
            kind: 'object',
            total_count: 1,
            page: 1,
            page_size: 1,
            has_more: false,
            items: [],
            fields: {
              node_id: node.node_id,
              node_label: node.node_label,
              status: node.status,
              current_label: node.current_label,
            },
          },
          {
            key: 'items',
            label: '结果列表',
            kind: 'list',
            total_count: sectionItems.length,
            page: 1,
            page_size: Math.max(1, sectionItems.length),
            has_more: false,
            items: sectionItems,
            fields: {},
          },
        ],
      };
      return [node.node_id, payload];
    }),
  );
  return { batch, trace, nodeResults };
};

export const buildStaticGraph = (
  artifacts: IBackendArtifacts,
  maxNodes: number,
): { nodes: readonly Record<string, unknown>[]; edges: readonly Record<string, unknown>[] } => {
  const nodes = artifacts.graphSnapshot.graph.nodes.slice(0, Math.max(1, maxNodes)).map(node => ({
    id: `kw:${node.keyword}`,
    label: node.keyword,
    type: node.category,
  }));
  const nodeSet = new Set(nodes.map(node => node.id));
  const edges = artifacts.graphSnapshot.graph.relationships
    .filter(relation => nodeSet.has(`kw:${relation.sourceKeyword}`) && nodeSet.has(`kw:${relation.targetKeyword}`))
    .map(relation => ({
      source: `kw:${relation.sourceKeyword}`,
      target: `kw:${relation.targetKeyword}`,
      label: relation.relationType,
      type: relation.relationType,
      confidence: relation.confidence,
      event_ts: toEpochSeconds(relation.updatedAt),
    }));
  return { nodes, edges };
};

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
