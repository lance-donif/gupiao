import type {
  IAutopilotPolicyRecord,
  IClusterSummaryRecord,
  IClusterVersionRecord,
  IHorizonPolicyRecord,
  IRuntimeSnapshot,
} from './runtime-types.js';

import path from 'node:path';
import { nowBeijingDateTime } from './beijing-time.js';
import { JsonFileStore } from './json-file-store.js';
import { createDefaultCluster, createDefaultClusterVersion, DEFAULT_CLUSTER_ID } from './trace-builders.js';

const RUNTIME_FILE_NAME = 'runtime-store.json';

const defaultHorizonPolicy = (): IHorizonPolicyRecord => ({
  default_horizon: 'short',
  horizon_profiles: {
    short: { days: 3, risk: 'high' },
    mid: { days: 10, risk: 'medium' },
    long: { days: 30, risk: 'low' },
  },
});

const defaultAutopilotPolicy = (): IAutopilotPolicyRecord => ({
  enabled: false,
  kill_switch: false,
  promote_consecutive_days: 5,
  rollback_cooldown_days: 3,
  guard_consecutive_fail_days: 2,
  guard_window_days: 5,
  slo_p95_budget_ms: 2000,
});

const createDefaultSnapshot = (): IRuntimeSnapshot => {
  const defaultCluster = createDefaultCluster();
  return {
    version: 2,
    clusters: [defaultCluster],
    batches: [],
    traces: {},
    node_results: {},
    cluster_versions: [createDefaultClusterVersion(defaultCluster.id)],
    cluster_feedback: [],
    cluster_rollbacks: [],
    horizon_policies: {
      [defaultCluster.id]: defaultHorizonPolicy(),
    },
    autopilot_policies: {
      [defaultCluster.id]: defaultAutopilotPolicy(),
    },
    whatif_history: [],
  };
};

const ensureClusterVersion = (
  versions: readonly IClusterVersionRecord[],
  cluster: IClusterSummaryRecord,
): readonly IClusterVersionRecord[] => {
  if (cluster.active_version_id && versions.some(row => row.id === cluster.active_version_id)) {
    return versions;
  }
  const nextVersion = (cluster.active_version ?? 1) || 1;
  const next: IClusterVersionRecord = {
    id: cluster.active_version_id ?? `${cluster.id}-v${nextVersion}`,
    group_id: cluster.id,
    version: nextVersion,
    prompts_dir: `tmp/http-runtime/prompts/${cluster.id}/v${nextVersion}`,
    created_at: nowBeijingDateTime(),
    status: '已升级',
    source_feedback_id: null,
    source_feedback_reason: null,
    confirmed_by: 'system',
    confirmed_at: nowBeijingDateTime(),
    previous_version_id: null,
  };
  return [next, ...versions];
};

const normalizeClusterVersion = (row: IClusterVersionRecord): IClusterVersionRecord => ({
  ...row,
  status: row.status ?? '已升级',
  source_feedback_id: row.source_feedback_id ?? null,
  source_feedback_reason: row.source_feedback_reason ?? null,
  confirmed_by: row.confirmed_by ?? (row.status === '待确认' ? null : 'system'),
  confirmed_at: row.confirmed_at ?? null,
  previous_version_id: row.previous_version_id ?? null,
});

export class RuntimeStateStore {
  private readonly fileStore: JsonFileStore<IRuntimeSnapshot>;

  public constructor(rootDir: string) {
    this.fileStore = new JsonFileStore<IRuntimeSnapshot>(
      path.join(rootDir, 'tmp', 'http-runtime', RUNTIME_FILE_NAME),
      createDefaultSnapshot,
    );
  }

  public async read(): Promise<IRuntimeSnapshot> {
    const snapshot = await this.fileStore.read();
    return this.normalize(snapshot);
  }

  public async write(snapshot: IRuntimeSnapshot): Promise<void> {
    await this.fileStore.write(this.normalize(snapshot));
  }

  public async update(
    updater: (snapshot: IRuntimeSnapshot) => IRuntimeSnapshot | Promise<IRuntimeSnapshot>,
  ): Promise<IRuntimeSnapshot> {
    return this.fileStore.update(async (raw) => {
      const normalized = this.normalize(raw);
      const next = await updater(normalized);
      return this.normalize(next);
    });
  }

  private normalize(raw: IRuntimeSnapshot): IRuntimeSnapshot {
    const base = raw?.version === 2 ? raw : createDefaultSnapshot();
    const clusters = [...(base.clusters.length > 0 ? base.clusters : [createDefaultCluster()])];
    const clusterIds = new Set(clusters.map(row => row.id));
    const horizonPolicies = { ...base.horizon_policies };
    const autopilotPolicies = { ...base.autopilot_policies };
    let versions = [...base.cluster_versions.map(normalizeClusterVersion)];
    for (const cluster of clusters) {
      if (!horizonPolicies[cluster.id]) {
        horizonPolicies[cluster.id] = defaultHorizonPolicy();
      }
      if (!autopilotPolicies[cluster.id]) {
        autopilotPolicies[cluster.id] = defaultAutopilotPolicy();
      }
      versions = [...ensureClusterVersion(versions, cluster)];
    }
    if (!clusterIds.has(DEFAULT_CLUSTER_ID)) {
      const fallback = createDefaultCluster();
      clusters.unshift(fallback);
      horizonPolicies[DEFAULT_CLUSTER_ID] = horizonPolicies[DEFAULT_CLUSTER_ID] ?? defaultHorizonPolicy();
      autopilotPolicies[DEFAULT_CLUSTER_ID]
        = autopilotPolicies[DEFAULT_CLUSTER_ID] ?? defaultAutopilotPolicy();
      versions = [...ensureClusterVersion(versions, fallback)];
    }
    return {
      version: 2,
      clusters,
      batches: [...base.batches],
      traces: { ...base.traces },
      node_results: { ...base.node_results },
      cluster_versions: versions,
      cluster_feedback: base.cluster_feedback.map(row => ({
        ...row,
        status: row.status ?? '待反馈',
      })),
      cluster_rollbacks: [...(base.cluster_rollbacks ?? [])],
      horizon_policies: horizonPolicies,
      autopilot_policies: autopilotPolicies,
      whatif_history: [...base.whatif_history],
    };
  }
}
