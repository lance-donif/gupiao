import type { IClusterVersionRecord } from './runtime-types.js';
import type { IBackendRuntimeStoreOptions } from './types.js';
import { BackendArtifactsLoader } from './artifacts.js';
import { nowBeijingDateTime } from './beijing-time.js';
import { BackendMetricsStore } from './metrics-store.js';
import { RuntimeStateStore } from './runtime-state.js';
import { DEFAULT_CLUSTER_NAME } from './trace-builders.js';

export interface IRuntimeStoreDependencies {
  readonly options: IBackendRuntimeStoreOptions;
  readonly artifactsLoader: BackendArtifactsLoader;
  readonly runtimeStateStore: RuntimeStateStore;
  readonly metricsStore: BackendMetricsStore;
}

export const toLimit = (value: number): number => Math.max(1, Math.floor(value));

export const ensureCluster = (
  snapshot: Awaited<ReturnType<RuntimeStateStore['read']>>,
  groupId: string,
): {
  snapshot: Awaited<ReturnType<RuntimeStateStore['read']>>;
  cluster: Awaited<ReturnType<RuntimeStateStore['read']>>['clusters'][number];
} => {
  const exists = snapshot.clusters.find(cluster => cluster.id === groupId);
  if (exists) {
    return { snapshot, cluster: exists };
  }
  const now = nowBeijingDateTime();
  const appended = {
    ...snapshot,
    clusters: [
      ...snapshot.clusters,
      {
        id: groupId,
        name: groupId === 'main' ? DEFAULT_CLUSTER_NAME : groupId,
        description: '本地兼容层新增集群',
        active_version_id: `${groupId}-v1`,
        active_version: 1,
        last_batch_status: null,
        last_target_trading_date: null,
        updated_at: now,
      },
    ],
    cluster_versions: [
      ...snapshot.cluster_versions,
      {
        id: `${groupId}-v1`,
        group_id: groupId,
        version: 1,
        prompts_dir: `tmp/http-runtime/prompts/${groupId}/v1`,
        created_at: now,
        status: '已升级',
        source_feedback_id: null,
        source_feedback_reason: null,
        confirmed_by: 'system',
        confirmed_at: now,
        previous_version_id: null,
      } satisfies IClusterVersionRecord,
    ],
    horizon_policies: {
      ...snapshot.horizon_policies,
      [groupId]: snapshot.horizon_policies.main ?? {
        default_horizon: 'short',
        horizon_profiles: { short: { days: 3 }, mid: { days: 10 }, long: { days: 30 } },
      },
    },
    autopilot_policies: {
      ...snapshot.autopilot_policies,
      [groupId]: snapshot.autopilot_policies.main ?? {
        enabled: false,
        kill_switch: false,
        promote_consecutive_days: 5,
        rollback_cooldown_days: 3,
        guard_consecutive_fail_days: 2,
        guard_window_days: 5,
        slo_p95_budget_ms: 2000,
      },
    },
  };
  return { snapshot: appended, cluster: appended.clusters[appended.clusters.length - 1]! };
};

export const createRuntimeDependencies = (
  options: IBackendRuntimeStoreOptions,
): IRuntimeStoreDependencies => ({
  options,
  artifactsLoader: new BackendArtifactsLoader(options.rootDir),
  runtimeStateStore: new RuntimeStateStore(options.rootDir),
  metricsStore: new BackendMetricsStore(options.rootDir),
});
