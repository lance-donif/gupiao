import type { IInteractionLatencyPayload } from './runtime-types.js';

import path from 'node:path';
import { nowBeijingDateTime, toEpochSeconds } from './beijing-time.js';
import { JsonFileStore } from './json-file-store.js';

interface IEndpointRequestRecord {
  readonly id: number;
  readonly method: string;
  readonly path: string;
  readonly duration_ms: number;
  readonly ok: boolean;
  readonly created_at: string;
}

interface IInteractionRecord {
  readonly id: number;
  readonly interaction: string;
  readonly duration_ms: number;
  readonly group_id: string | null;
  readonly trade_date: string | null;
  readonly ok: boolean;
  readonly created_at: string;
}

interface IMetricsSnapshot {
  readonly version: 1;
  readonly endpoint_requests: readonly IEndpointRequestRecord[];
  readonly interactions: readonly IInteractionRecord[];
}

const METRICS_FILE_NAME = 'metrics.json';
const MAX_ENDPOINT_RECORDS = 2000;
const MAX_INTERACTION_RECORDS = 2000;

const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index] ?? 0;
};

const createDefaultMetrics = (): IMetricsSnapshot => ({
  version: 1,
  endpoint_requests: [],
  interactions: [],
});

export class BackendMetricsStore {
  private readonly store: JsonFileStore<IMetricsSnapshot>;
  private pendingWrite: Promise<unknown> = Promise.resolve();

  public constructor(rootDir: string) {
    this.store = new JsonFileStore<IMetricsSnapshot>(
      path.join(rootDir, 'tmp', 'http-runtime', METRICS_FILE_NAME),
      createDefaultMetrics,
    );
  }

  public async recordEndpointRequest(input: {
    method: string;
    path: string;
    duration_ms: number;
    ok: boolean;
  }): Promise<void> {
    const createdAt = nowBeijingDateTime();
    await this.enqueueWrite(() => this.store.update((snapshot) => {
      const nextId = (snapshot.endpoint_requests[0]?.id ?? 0) + 1;
      const row: IEndpointRequestRecord = {
        id: nextId,
        method: input.method,
        path: input.path,
        duration_ms: Number.isFinite(input.duration_ms) ? input.duration_ms : 0,
        ok: input.ok,
        created_at: createdAt,
      };
      return {
        version: 1,
        interactions: snapshot.interactions,
        endpoint_requests: [row, ...snapshot.endpoint_requests].slice(0, MAX_ENDPOINT_RECORDS),
      };
    }));
  }

  public async recordInteraction(input: IInteractionLatencyPayload): Promise<IInteractionRecord> {
    const createdAt = nowBeijingDateTime();
    const snapshot = await this.enqueueWrite(() => this.store.update((current) => {
      const nextId = (current.interactions[0]?.id ?? 0) + 1;
      const row: IInteractionRecord = {
        id: nextId,
        interaction: input.interaction,
        duration_ms: Number.isFinite(input.duration_ms) ? input.duration_ms : 0,
        group_id: input.group_id ?? null,
        trade_date: input.trade_date ?? null,
        ok: Boolean(input.ok),
        created_at: createdAt,
      };
      return {
        version: 1,
        endpoint_requests: current.endpoint_requests,
        interactions: [row, ...current.interactions].slice(0, MAX_INTERACTION_RECORDS),
      };
    }));
    return snapshot.interactions[0]!;
  }

  public async listInteractions(windowMinutes: number): Promise<readonly IInteractionRecord[]> {
    await this.waitForWrites();
    const snapshot = await this.store.read();
    const minEpoch = Date.now() / 1000 - Math.max(1, windowMinutes) * 60;
    return snapshot.interactions.filter(row => toEpochSeconds(row.created_at) >= minEpoch);
  }

  public async getLatencyOverview(windowMinutes: number): Promise<Record<string, unknown>> {
    await this.waitForWrites();
    const snapshot = await this.store.read();
    const minEpoch = Date.now() / 1000 - Math.max(1, windowMinutes) * 60;
    const endpointRows = snapshot.endpoint_requests.filter(
      row => toEpochSeconds(row.created_at) >= minEpoch,
    );
    const interactionRows = snapshot.interactions.filter(
      row => toEpochSeconds(row.created_at) >= minEpoch,
    );
    const durations = endpointRows.map(row => row.duration_ms);
    const interactionDurations = interactionRows.map(row => row.duration_ms);
    return {
      window_minutes: Math.max(1, windowMinutes),
      endpoint_requests: endpointRows.length,
      endpoint_errors: endpointRows.filter(row => !row.ok).length,
      endpoint_avg_ms:
        durations.length === 0 ? 0 : durations.reduce((sum, value) => sum + value, 0) / durations.length,
      endpoint_p95_ms: percentile(durations, 0.95),
      interactions: interactionRows.length,
      interactions_ok: interactionRows.filter(row => row.ok).length,
      interactions_avg_ms:
        interactionDurations.length === 0
          ? 0
          : interactionDurations.reduce((sum, value) => sum + value, 0) / interactionDurations.length,
      interactions_p95_ms: percentile(interactionDurations, 0.95),
      updated_at: nowBeijingDateTime(),
    };
  }

  public async getLatencyEndpoints(windowMinutes: number): Promise<readonly Record<string, unknown>[]> {
    await this.waitForWrites();
    const snapshot = await this.store.read();
    const minEpoch = Date.now() / 1000 - Math.max(1, windowMinutes) * 60;
    const rows = snapshot.endpoint_requests.filter(row => toEpochSeconds(row.created_at) >= minEpoch);
    const grouped = new Map<string, IEndpointRequestRecord[]>();
    for (const row of rows) {
      const key = `${row.method} ${row.path}`;
      const list = grouped.get(key) ?? [];
      list.push(row);
      grouped.set(key, list);
    }
    return [...grouped.entries()].map(([key, list]) => {
      const durations = list.map(item => item.duration_ms);
      const last = list[0];
      return {
        key,
        method: last?.method ?? 'GET',
        path: last?.path ?? '/',
        count: list.length,
        ok_count: list.filter(item => item.ok).length,
        error_count: list.filter(item => !item.ok).length,
        avg_ms:
          durations.length === 0
            ? 0
            : durations.reduce((sum, value) => sum + value, 0) / durations.length,
        p95_ms: percentile(durations, 0.95),
        last_duration_ms: durations[0] ?? 0,
        updated_at: last?.created_at ?? nowBeijingDateTime(),
      };
    });
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pendingWrite
      .catch(() => undefined)
      .then(operation);
    this.pendingWrite = next;
    return next;
  }

  private async waitForWrites(): Promise<void> {
    await this.pendingWrite.catch(() => undefined);
  }
}
