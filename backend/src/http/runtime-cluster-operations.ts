import type { IRuntimeStoreDependencies } from './runtime-store-shared.js';
import type { IClusterFeedbackRecord, IClusterRollbackRecord } from './runtime-types.js';
import type { BackendConfigCategory } from './types.js';
import { nowBeijingDateTime } from './beijing-time.js';
import { ensureCluster, toLimit } from './runtime-store-shared.js';

interface ClusterFeedbackInput {
  group_id: string;
  group_version_id: string;
  display_date: string;
  ticker: string;
  score: number;
  reason?: string | null;
  trace_id?: string;
}

interface PromoteInput {
  group_id: string;
  reason?: string | null;
  feedback_id?: string | null;
}

interface ConfirmPromoteInput {
  group_id: string;
  group_version_id: string;
  confirmed_by?: string | null;
}

interface RollbackInput {
  group_id: string;
  target_group_version_id: string;
  reason: string;
  trace_id?: string;
}

export class RuntimeClusterOperations {
  public constructor(private readonly deps: IRuntimeStoreDependencies) {}

  public async listClusters(): Promise<readonly unknown[]> {
    return (await this.deps.runtimeStateStore.read()).clusters;
  }

  public async listClusterVersions(groupId: string): Promise<readonly unknown[]> {
    return (await this.deps.runtimeStateStore.read()).cluster_versions.filter(row => row.group_id === groupId);
  }

  public async listClusterFeedback(groupId: string, displayDate: string): Promise<readonly unknown[]> {
    return (await this.deps.runtimeStateStore.read()).cluster_feedback.filter(
      row => row.group_id === groupId && row.display_date === displayDate && !row.deleted,
    );
  }

  public async saveClusterFeedback(input: ClusterFeedbackInput): Promise<IClusterFeedbackRecord> {
    const now = nowBeijingDateTime();
    const saved: IClusterFeedbackRecord = {
      id: `fb-${Date.now()}`,
      group_id: input.group_id,
      group_version_id: input.group_version_id,
      display_date: input.display_date,
      ticker: input.ticker,
      score: input.score,
      reason: input.reason ?? null,
      trace_id: input.trace_id ?? '',
      created_at: now,
      updated_at: now,
      deleted: false,
      status: '待反馈',
    };
    await this.deps.runtimeStateStore.update(snapshot => ({
      ...snapshot,
      cluster_feedback: [saved, ...snapshot.cluster_feedback].slice(0, 500),
    }));
    return saved;
  }

  public async getPromotePreflight(groupId: string): Promise<Record<string, unknown>> {
    return {
      group_id: groupId,
      stage_rules_version: 'compat-stage-v1',
      eval_rules_version: 'compat-eval-v1',
      rules_pair_key: 'compat-stage-v1|compat-eval-v1',
      gate_profile: 'compat-default',
      gate_passed: true,
      gate_failed_reasons: [],
      matured_valid_ab_tradeable_count: 8,
      c_class_rate: 0.2,
      warnings: [],
    };
  }

  public async promoteCluster(input: PromoteInput): Promise<{ trace_id: string; celery_task_id: string; group_version_id: string; status: string }> {
    const now = nowBeijingDateTime();
    let traceId = '';
    let nextVersionId = '';
    await this.deps.runtimeStateStore.update((snapshot) => {
      const normalized = ensureCluster(snapshot, input.group_id);
      const current = normalized.cluster.active_version ?? 1;
      const nextVersion = current + 1;
      nextVersionId = `${input.group_id}-v${nextVersion}`;
      traceId = `trace-promote-${input.group_id}-${Date.now()}`;
      const sourceFeedback = normalized.snapshot.cluster_feedback.find(row => row.id === input.feedback_id) ?? null;
      return {
        ...normalized.snapshot,
        cluster_feedback: normalized.snapshot.cluster_feedback.map(row =>
          row.id === input.feedback_id ? { ...row, status: '待确认', updated_at: now } : row,
        ),
        cluster_versions: [
          {
            id: nextVersionId,
            group_id: input.group_id,
            version: nextVersion,
            prompts_dir: `tmp/http-runtime/prompts/${input.group_id}/v${nextVersion}`,
            created_at: now,
            status: '待确认',
            source_feedback_id: sourceFeedback?.id ?? input.feedback_id ?? null,
            source_feedback_reason: sourceFeedback?.reason ?? input.reason ?? null,
            confirmed_by: null,
            confirmed_at: null,
            previous_version_id: normalized.cluster.active_version_id,
          },
          ...normalized.snapshot.cluster_versions,
        ],
      };
    });
    return { trace_id: traceId, celery_task_id: `local-${traceId}`, group_version_id: nextVersionId, status: '待确认' };
  }

  public async confirmPromoteCluster(input: ConfirmPromoteInput): Promise<Record<string, unknown>> {
    const now = nowBeijingDateTime();
    let previousVersionId: string | null = null;
    let status = '已升级';
    await this.deps.runtimeStateStore.update((snapshot) => {
      const normalized = ensureCluster(snapshot, input.group_id);
      const target = normalized.snapshot.cluster_versions.find(row => row.id === input.group_version_id);
      if (!target || target.status !== '待确认') {
        status = '失败';
        return normalized.snapshot;
      }
      previousVersionId = normalized.cluster.active_version_id;
      return {
        ...normalized.snapshot,
        clusters: normalized.snapshot.clusters.map(cluster =>
          cluster.id === input.group_id
            ? {
                ...cluster,
                active_version: target.version,
                active_version_id: target.id,
                updated_at: now,
              }
            : cluster,
        ),
        cluster_versions: normalized.snapshot.cluster_versions.map((row) => {
          if (row.id === target.id) {
            return {
              ...row,
              status: '已升级',
              confirmed_by: input.confirmed_by ?? 'local-user',
              confirmed_at: now,
            };
          }
          if (row.id === previousVersionId) {
            return { ...row, status: '可回滚' };
          }
          return row;
        }),
        cluster_feedback: normalized.snapshot.cluster_feedback.map(row =>
          row.id === target.source_feedback_id ? { ...row, status: '已升级', updated_at: now } : row,
        ),
      };
    });
    return {
      group_id: input.group_id,
      group_version_id: input.group_version_id,
      previous_version_id: previousVersionId,
      status,
      confirmed_by: input.confirmed_by ?? 'local-user',
      confirmed_at: status === '已升级' ? now : null,
    };
  }

  public async rollbackCluster(input: RollbackInput): Promise<Record<string, unknown>> {
    const snapshot = await this.deps.runtimeStateStore.read();
    const target = snapshot.cluster_versions.find(row => row.id === input.target_group_version_id);
    const oldVersion
      = snapshot.clusters.find(cluster => cluster.id === input.group_id)?.active_version_id ?? null;
    const now = nowBeijingDateTime();
    const traceId = input.trace_id ?? `trace-rollback-${input.group_id}-${Date.now()}`;
    if (!target || target.group_id !== input.group_id) {
      return {
        trace_id: traceId,
        group_id: input.group_id,
        old_version_id: oldVersion,
        target_group_version_id: input.target_group_version_id,
        status: '失败',
      };
    }
    await this.deps.runtimeStateStore.update(raw => ({
      ...raw,
      clusters: raw.clusters.map(cluster =>
        cluster.id === input.group_id
          ? {
              ...cluster,
              active_version_id: input.target_group_version_id,
              active_version: target?.version ?? cluster.active_version,
              updated_at: now,
            }
          : cluster,
      ),
      cluster_versions: raw.cluster_versions.map((row) => {
        if (row.id === oldVersion) {
          return { ...row, status: '已回滚' };
        }
        if (row.id === input.target_group_version_id) {
          return { ...row, status: '已升级' };
        }
        return row;
      }),
      cluster_rollbacks: [
        {
          id: `rb-${Date.now()}`,
          group_id: input.group_id,
          from_version_id: oldVersion ?? '',
          to_version_id: input.target_group_version_id,
          reason: input.reason,
          trace_id: traceId,
          created_at: now,
          status: '已回滚',
        } satisfies IClusterRollbackRecord,
        ...raw.cluster_rollbacks,
      ].slice(0, 500),
    }));
    return {
      trace_id: traceId,
      group_id: input.group_id,
      old_version_id: oldVersion,
      target_group_version_id: input.target_group_version_id,
      status: '已回滚',
    };
  }

  public async getHorizonPolicy(groupId: string): Promise<unknown> {
    return (await this.deps.runtimeStateStore.read()).horizon_policies[groupId] ?? { default_horizon: 'short', horizon_profiles: {} };
  }

  public async updateHorizonPolicy(groupId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const saved = {
      default_horizon: String(payload.default_horizon ?? 'short'),
      horizon_profiles:
        payload.horizon_profiles && typeof payload.horizon_profiles === 'object'
          ? (payload.horizon_profiles as Record<string, Record<string, unknown>>)
          : {},
    };
    await this.deps.runtimeStateStore.update(snapshot => ({
      ...snapshot,
      horizon_policies: { ...snapshot.horizon_policies, [groupId]: saved },
    }));
    return saved;
  }

  public async getAutopilotPolicy(groupId: string): Promise<unknown> {
    return (await this.deps.runtimeStateStore.read()).autopilot_policies[groupId] ?? {
      enabled: false,
      kill_switch: false,
      promote_consecutive_days: 5,
      rollback_cooldown_days: 3,
      guard_consecutive_fail_days: 2,
      guard_window_days: 5,
      slo_p95_budget_ms: 2000,
    };
  }

  public async updateAutopilotPolicy(groupId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const saved = {
      enabled: Boolean(payload.enabled),
      kill_switch: Boolean(payload.kill_switch),
      promote_consecutive_days: toLimit(Number(payload.promote_consecutive_days ?? 5)),
      rollback_cooldown_days: toLimit(Number(payload.rollback_cooldown_days ?? 3)),
      guard_consecutive_fail_days: toLimit(Number(payload.guard_consecutive_fail_days ?? 2)),
      guard_window_days: toLimit(Number(payload.guard_window_days ?? 5)),
      slo_p95_budget_ms: toLimit(Number(payload.slo_p95_budget_ms ?? 2000)),
    };
    await this.deps.runtimeStateStore.update(snapshot => ({
      ...snapshot,
      autopilot_policies: { ...snapshot.autopilot_policies, [groupId]: saved },
    }));
    return saved;
  }

  public async listConfigByCategory(category: BackendConfigCategory): Promise<{ items: readonly unknown[] }> {
    return { items: await this.deps.options.configStore.listByCategory(category) };
  }

  public async updateConfig(key: string, value: string): Promise<{ key: string; value: string; message: string }> {
    return this.deps.options.configStore.setValue(key, value);
  }
}
