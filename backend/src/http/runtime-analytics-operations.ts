import type { IRuntimeStoreDependencies } from './runtime-store-shared.js';
import { buildBacktestResponse, buildMetricsTraceLines, buildWhatIfHistoryItem, buildWhatIfResponse, paginateRows } from './secondary-builders.js';

interface WhatIfInput {
  group_id: string;
  query: string;
  cutoff_date: string;
  max_hops: number;
  max_items: number;
}

interface BacktestInput {
  group_id: string;
  end_date: string;
  window_days: number;
}

export class RuntimeAnalyticsOperations {
  public constructor(private readonly deps: IRuntimeStoreDependencies) {}

  public async getMetricsOverview(): Promise<Record<string, unknown>> {
    const snapshot = await this.deps.runtimeStateStore.read();
    const events = Object.values(snapshot.traces).flatMap(trace => trace.events);
    const eventMap = events.reduce<Record<string, number>>((acc, row) => {
      acc[row.event_type] = (acc[row.event_type] ?? 0) + 1;
      return acc;
    }, {});
    const levelMap = events.reduce<Record<string, number>>((acc, row) => {
      acc[row.level] = (acc[row.level] ?? 0) + 1;
      return acc;
    }, {});
    const latestBatch = snapshot.batches[0];
    return {
      last_ts: Math.floor(Date.now() / 1000),
      events: eventMap,
      levels: levelMap,
      avg_lag_seconds: 0,
      schema_mismatch_rate_latest: Number(latestBatch?.schema_mismatch_rate ?? 0),
      schema_mismatch_block_count: snapshot.batches.filter(row => row.promote_blocked_by_quality).length,
      leadtime_breakout_median_latest: 2.5,
      no_breakout_rate_latest: 0.08,
      promote_gate_block_count: 0,
      latest_trade_date: latestBatch?.target_trading_date ?? null,
      stock_count_latest: latestBatch?.schema_checked_count ?? 0,
    };
  }

  public async getMetricsTrace(traceId: string, cursor: number | undefined, limit: number): Promise<Record<string, unknown>> {
    const trace = (await this.deps.runtimeStateStore.read()).traces[traceId];
    const lines = trace ? buildMetricsTraceLines(trace) : [];
    const page = paginateRows(lines, cursor, limit);
    return {
      trace_id: traceId,
      lines: page.rows,
      next_cursor: page.next_cursor,
      has_more: page.has_more,
    };
  }

  public async getLatencyOverview(windowMinutes: number): Promise<Record<string, unknown>> {
    return this.deps.metricsStore.getLatencyOverview(windowMinutes);
  }

  public async getLatencyEndpoints(windowMinutes: number): Promise<readonly Record<string, unknown>[]> {
    return this.deps.metricsStore.getLatencyEndpoints(windowMinutes);
  }

  public async getLatencyInteractions(windowMinutes: number): Promise<readonly unknown[]> {
    return this.deps.metricsStore.listInteractions(windowMinutes);
  }

  public async postLatencyInteraction(payload: {
    interaction: string;
    duration_ms: number;
    group_id?: string | null;
    trade_date?: string | null;
    ok: boolean;
  }): Promise<unknown> {
    return this.deps.metricsStore.recordInteraction(payload);
  }

  public async recordEndpointRequest(input: { method: string; path: string; duration_ms: number; ok: boolean }): Promise<void> {
    await this.deps.metricsStore.recordEndpointRequest(input);
  }

  public async runWhatIf(payload: WhatIfInput): Promise<Record<string, unknown>> {
    const artifacts = await this.deps.artifactsLoader.load();
    const response = buildWhatIfResponse({
      artifacts,
      query: payload.query,
      cutoffDate: payload.cutoff_date,
      maxItems: payload.max_items,
    });
    const items = (response.items as readonly { symbol: string }[]) ?? [];
    await this.deps.runtimeStateStore.update(snapshot => ({
      ...snapshot,
      whatif_history: [
        buildWhatIfHistoryItem({
          groupId: payload.group_id,
          query: payload.query,
          cutoffDate: payload.cutoff_date,
          maxHops: payload.max_hops,
          maxItems: payload.max_items,
          hitCount: items.length,
          topSymbols: items.map(row => row.symbol).slice(0, 5),
          warnings: (response.warnings as readonly string[]) ?? [],
        }),
        ...snapshot.whatif_history,
      ].slice(0, 200),
    }));
    return response;
  }

  public async listWhatIfHistory(groupId: string, limit: number): Promise<readonly unknown[]> {
    const safe = Math.max(1, limit);
    return (await this.deps.runtimeStateStore.read()).whatif_history.filter(row => row.group_id === groupId).slice(0, safe);
  }

  public async runBacktest(payload: BacktestInput): Promise<Record<string, unknown>> {
    return buildBacktestResponse({
      groupId: payload.group_id,
      endDate: payload.end_date,
      windowDays: Math.max(1, payload.window_days),
    });
  }
}
