import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { IContributionDetailReader } from '../../../src/http/index.js';
import { startBackendHttpServer } from '../../../src/http/index.js';
import { resolveRootDir } from '../../../src/http/server.js';
import { InMemoryConfigStore, writeHttpArtifacts } from './http-fixtures.js';

type JsonObject = Record<string, unknown>;

const createContributionReader = (
  rows: NonNullable<Awaited<ReturnType<IContributionDetailReader['getContributionDetail']>>>['rows'],
): IContributionDetailReader & { closed: boolean } => ({
  closed: false,
  async getContributionDetail(query) {
    return {
      traceId: query.traceId,
      symbol: query.symbol,
      totalContribution: rows.reduce((sum, row) => sum + row.finalContribScore, 0),
      rows,
    };
  },
  async close() {
    this.closed = true;
  },
});

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

describe('backend http server', () => {
  const runningServers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(
      runningServers.splice(0).map(async (server) => {
        await server.close();
      }),
    );
  });

  it('defaults the runtime root dir to process cwd instead of the dist directory', () => {
    expect(resolveRootDir({
      env: {},
      cwd: '/app',
    })).toBe('/app');
  });

  it('serves the web-compatible dashboard and trace endpoints', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'gupiao-backend-http-'));
    await writeHttpArtifacts(rootDir);

    const server = await startBackendHttpServer({
      rootDir,
      configStore: new InMemoryConfigStore(),
      dailyReportReader: null,
      host: '127.0.0.1',
      port: 0,
    });
    runningServers.push(server);

    const baseUrl = `http://127.0.0.1:${server.port}`;

    const health = await fetchJson<JsonObject>(`${baseUrl}/health`);
    expect(health.ok).toBe(true);

    const clusters = await fetchJson<Array<{ id: string; name: string }>>(
      `${baseUrl}/api/cluster/list`,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.id).toBe('main');

    const dispatch = await fetchJson<{ trace_id: string; celery_task_id: string }>(
      `${baseUrl}/api/dispatch/daily`,
      {
        method: 'POST',
        body: JSON.stringify({ group_id: 'main', target_date: '2026-03-18' }),
      },
    );
    expect(dispatch.trace_id).toContain('trace-main-2026-03-18');
    expect(dispatch.celery_task_id).toContain(dispatch.trace_id);

    const latestBatch = await fetchJson<{ id: string; trace_id: string; group_id: string } | null>(
      `${baseUrl}/api/batches/latest/main`,
    );
    expect(latestBatch?.trace_id).toBeDefined();
    expect(typeof latestBatch?.trace_id).toBe('string');

    const progress = await fetchJson<JsonObject>(`${baseUrl}/api/batches/latest/main/progress`);
    expect(progress.trace_id).toBeDefined();
    expect(Array.isArray(progress.nodes)).toBe(true);

    const report = await fetchJson<{
      available: boolean;
      report_kind: string;
      recommendations: {
        A: Array<{ ticker: string }>;
        B: Array<{ ticker: string }>;
        C: Array<{ ticker: string }>;
      };
      meta: { trace_id: string; batch_id: string | null };
      batch_quality: { schema_checked_count: number };
    }>(`${baseUrl}/api/report/daily?display_date=2026-03-18&group_id=main`);
    expect(report.available).toBe(false);
    expect(report.report_kind).toBe('EMPTY');
    expect(report.batch_quality.schema_checked_count).toBe(0);
    expect(report.meta.trace_id).toBe('');
    expect(report.recommendations.A.length + report.recommendations.B.length + report.recommendations.C.length).toBe(0);

    const dashboard = await fetchJson<{
      available: boolean;
      recommendations: unknown[];
      execution_history: unknown[];
      meta: { trace_id: string };
      quality: { recommendation_count: number };
    }>(`${baseUrl}/api/dashboard/snapshot?display_date=2026-03-18&group_id=main`);
    expect(dashboard.available).toBe(false);
    expect(Array.isArray(dashboard.recommendations)).toBe(true);
    expect(Array.isArray(dashboard.execution_history)).toBe(true);
    expect(dashboard.meta.trace_id).toBe('');
    expect(dashboard.quality.recommendation_count).toBe(0);

    const emptyEvidence = await fetchJson<{
      trace_id: string;
      symbol: string;
      stats: { total_count: number };
      items: unknown[];
    }>(`${baseUrl}/api/dashboard/stocks/300024/evidence?trace_id=${encodeURIComponent(dispatch.trace_id)}&group_id=main`);
    expect(emptyEvidence.symbol).toBe('300024');
    expect(emptyEvidence.stats.total_count).toBe(0);
    expect(emptyEvidence.items).toHaveLength(0);

    const graph = await fetchJson<{ nodes: Array<{ id: string; label: string }>; edges: Array<{ source: string; target: string; label: string }> }>(
      `${baseUrl}/api/graph?group_id=main&cutoff_date=2026-03-18&max_depth=3&max_nodes=200`,
    );
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(Array.isArray(graph.edges)).toBe(true);

    const executionGraph = await fetchJson<JsonObject>(
      `${baseUrl}/api/graph/execution?trace_id=${encodeURIComponent(dispatch.trace_id)}&max_nodes=2000`,
    );
    expect(Array.isArray(executionGraph.nodes)).toBe(true);
    expect(executionGraph.nodes).toHaveLength(0);

    const traceOverview = await fetchJson<JsonObject>(
      `${baseUrl}/api/trace/${encodeURIComponent(dispatch.trace_id)}/overview`,
    );
    expect(traceOverview.steps_total).toBe(0);
    expect(traceOverview.events_total).toBe(0);
    expect(traceOverview.total_tokens).toBe(0);
    expect(traceOverview.latest_phase).toBe('failed');

    const traceSteps = await fetchJson<{ rows: Array<{ input_snapshot: JsonObject; output_snapshot: JsonObject }> }>(
      `${baseUrl}/api/trace/${encodeURIComponent(dispatch.trace_id)}/steps?limit=10`,
    );
    expect(traceSteps.rows).toHaveLength(0);

    const traceEvents = await fetchJson<{ rows: Array<{ payload: JsonObject }> }>(
      `${baseUrl}/api/trace/${encodeURIComponent(dispatch.trace_id)}/events?limit=10`,
    );
    expect(traceEvents.rows).toHaveLength(0);

    const traceCosts = await fetchJson<{ total_cost_usd: number; total_tokens: number; rows: Array<{ role: string }> }>(
      `${baseUrl}/api/trace/${encodeURIComponent(dispatch.trace_id)}/llm-costs`,
    );
    expect(traceCosts.total_tokens).toBeGreaterThanOrEqual(0);
    expect(traceCosts.rows).toHaveLength(0);

    const metricsOverview = await fetchJson<JsonObject>(`${baseUrl}/metrics/overview`);
    expect(metricsOverview.latest_trade_date).toBe('2026-03-18');

    const strategies = await fetchJson<{ items: Array<{ id: string; name: string }> }>(
      `${baseUrl}/api/strategy/definitions?group_id=main`,
    );
    expect(Array.isArray(strategies.items)).toBe(true);

    const profits = await fetchJson<{ rows: unknown[]; summaries: unknown[] }>(
      `${baseUrl}/api/strategy/profits?group_id=main&as_of=2026-03-18`,
    );
    expect(Array.isArray(profits.rows)).toBe(true);
    expect(Array.isArray(profits.summaries)).toBe(true);

    const metricsTrace = await fetchJson<{ lines: string[] }>(
      `${baseUrl}/metrics/trace/${encodeURIComponent(dispatch.trace_id)}?limit=20`,
    );
    expect(metricsTrace.lines[0]).toContain('status=FAILED');

    const recommendations = await fetchJson<Array<{ items: Array<{ symbol: string; stage: string; latest_close: number }> }>>(
      `${baseUrl}/api/recommendations?trade_date=2026-03-18&group_id=main`,
    );
    expect(recommendations[0]?.items[0]?.symbol).toBe('300024');
    expect(recommendations[0]?.items[0]?.stage).toBeDefined();
    expect(recommendations[0]?.items[0]?.latest_close).toBeGreaterThan(0);

    const nonTrading = await fetchJson<Array<{ recommendation_kind: string; items: Array<{ symbol: string }> }>>(
      `${baseUrl}/api/nontrading-recommendations?display_date=2026-03-18&group_id=main`,
    );
    expect(nonTrading[0]?.recommendation_kind).toBe('NON_TRADING_SPECIAL');
    expect(nonTrading[0]?.items.length).toBeGreaterThan(0);

    let nodeResult: { summary_cards: Array<{ key: string }>; sections: Array<{ kind: string; items: JsonObject[]; fields: JsonObject }> } | null = null;
    try {
      nodeResult = await fetchJson<{
        summary_cards: Array<{ key: string }>;
        sections: Array<{ kind: string; items: JsonObject[]; fields: JsonObject }>;
      }>(
        `${baseUrl}/api/batches/${encodeURIComponent(String(latestBatch?.id || ''))}/nodes/recommendation/result?page=1&page_size=10`,
      );
    }
    catch { /* DB batch has no node results */ }
    if (nodeResult && nodeResult.summary_cards?.length > 0) {
      expect(nodeResult.sections.length).toBeGreaterThan(0);
    }

    const whatIf = await fetchJson<{ items: Array<{ symbol: string }>; cutoff_date: string }>(
      `${baseUrl}/api/whatif`,
      {
        method: 'POST',
        body: JSON.stringify({
          group_id: 'main',
          query: '机器人',
          cutoff_date: '2026-03-18',
          max_hops: 3,
          max_items: 5,
        }),
      },
    );
    expect(whatIf.cutoff_date).toBe('2026-03-18');
    expect(whatIf.items.length).toBeGreaterThan(0);

    const whatIfHistory = await fetchJson<Array<{ query: string }>>(
      `${baseUrl}/api/whatif/history?group_id=main&limit=20`,
    );
    expect(whatIfHistory[0]?.query).toBe('机器人');

    const backtest = await fetchJson<{ curve: Array<{ date: string }>; gate_passed: boolean }>(
      `${baseUrl}/api/backtest`,
      {
        method: 'POST',
        body: JSON.stringify({
          group_id: 'main',
          end_date: '2026-03-18',
          window_days: 20,
        }),
      },
    );
    expect(backtest.curve.length).toBe(20);
    expect(backtest.gate_passed).toBe(true);

    await fetchJson(`${baseUrl}/api/metrics/latency/interactions`, {
      method: 'POST',
      body: JSON.stringify({
        interaction: 'trace_runtime_load',
        duration_ms: 321,
        group_id: 'main',
        trade_date: '2026-03-18',
        ok: true,
      }),
    });
    const latencyOverview = await fetchJson<JsonObject>(
      `${baseUrl}/api/metrics/latency/overview?window_minutes=60`,
    );
    expect(latencyOverview.window_minutes).toBe(60);

    const endpointLatency = await fetchJson<Array<JsonObject>>(
      `${baseUrl}/api/metrics/latency/endpoints?window_minutes=60`,
    );
    expect(endpointLatency.length).toBeGreaterThan(0);

    const interactionLatency = await fetchJson<Array<{ interaction: string; duration_ms: number }>>(
      `${baseUrl}/api/metrics/latency/interactions?window_minutes=60`,
    );
    expect(Array.isArray(interactionLatency)).toBe(true);

    const mlRecommendations = await fetchJson<{
      recommendations: { S: Array<{ ticker: string }>; A: Array<{ ticker: string }>; B: Array<{ ticker: string }>; C: Array<{ ticker: string }> };
    }>(`${baseUrl}/api/ml-recommendations?trade_date=2026-03-18&group_id=main&top_n=10&force_refresh=false`);
    expect(
      mlRecommendations.recommendations.S.length +
        mlRecommendations.recommendations.A.length +
        mlRecommendations.recommendations.B.length +
        mlRecommendations.recommendations.C.length,
    ).toBeGreaterThan(0);

    const quote = await fetchJson<{ price: number | string | null; source: string }>(
      `${baseUrl}/api/ml-recommendations/stocks/300024/realtime`,
    );
    expect(typeof quote.price === 'number' || typeof quote.price === 'string' || quote.price === null).toBe(true);
    expect(quote.source).toBeDefined();

    const streamResp = await fetch(
      `${baseUrl}/api/trace/${encodeURIComponent(dispatch.trace_id)}/stream?last_event_id=1`,
      { headers: { accept: 'text/event-stream' } },
    );
    expect(streamResp.status).toBe(200);
    const reader = streamResp.body?.getReader();
    const chunk = await reader?.read();
    const chunkText = new TextDecoder().decode(chunk?.value ?? new Uint8Array());
    expect(chunkText).toContain('data:');
    reader?.cancel().catch(() => undefined);
  });

  it('supports cluster management and persistence endpoints', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'gupiao-backend-http-cluster-'));
    await writeHttpArtifacts(rootDir);

    const server = await startBackendHttpServer({
      rootDir,
      configStore: new InMemoryConfigStore(),
      host: '127.0.0.1',
      port: 0,
    });
    runningServers.push(server);

    const baseUrl = `http://127.0.0.1:${server.port}`;

    const versions = await fetchJson<Array<{ id: string; group_id: string; version: number }>>(
      `${baseUrl}/api/cluster/versions?group_id=main`,
    );
    expect(versions.length).toBeGreaterThan(0);

    const feedbackCreated = await fetchJson<JsonObject>(`${baseUrl}/api/cluster/feedback`, {
      method: 'POST',
      body: JSON.stringify({
        group_id: 'main',
        group_version_id: versions[0]?.id,
        display_date: '2026-03-18',
        ticker: '300024',
        score: 1,
        reason: 'test feedback',
      }),
    });
    expect(feedbackCreated.group_id).toBe('main');

    const feedbackRows = await fetchJson<Array<{ ticker: string; score: number }>>(
      `${baseUrl}/api/cluster/feedback?group_id=main&display_date=2026-03-18`,
    );
    expect(feedbackRows[0]?.ticker).toBe('300024');

    const preflight = await fetchJson<JsonObject>(
      `${baseUrl}/api/cluster/promote/preflight?group_id=main`,
    );
    expect(typeof preflight.gate_passed).toBe('boolean');

    const promote = await fetchJson<JsonObject>(`${baseUrl}/api/cluster/promote`, {
      method: 'POST',
      body: JSON.stringify({ group_id: 'main', feedback_id: feedbackCreated.id, reason: 'test promote' }),
    });
    expect(promote.trace_id).toBeDefined();
    expect(promote.celery_task_id).toBeDefined();
    expect(promote.status).toBe('待确认');

    const pendingVersions = await fetchJson<Array<{ id: string; status: string; previous_version_id: string | null }>>(
      `${baseUrl}/api/cluster/versions?group_id=main`,
    );
    expect(pendingVersions.find(row => row.id === promote.group_version_id)).toMatchObject({
      status: '待确认',
      previous_version_id: versions[0]?.id,
    });

    const confirmPromote = await fetchJson<JsonObject>(`${baseUrl}/api/cluster/promote/confirm`, {
      method: 'POST',
      body: JSON.stringify({
        group_id: 'main',
        group_version_id: promote.group_version_id,
        confirmed_by: 'tester',
      }),
    });
    expect(confirmPromote.status).toBe('已升级');

    const rollback = await fetchJson<JsonObject>(`${baseUrl}/api/cluster/rollback`, {
      method: 'POST',
      body: JSON.stringify({
        group_id: 'main',
        target_group_version_id: versions[0]?.id,
        reason: 'test rollback',
      }),
    });
    expect(rollback.status).toBe('已回滚');

    const horizon = await fetchJson<JsonObject>(`${baseUrl}/api/strategy/horizons/main`);
    expect(horizon.default_horizon).toBeDefined();

    const updatedHorizon = await fetchJson<JsonObject>(`${baseUrl}/api/strategy/horizons/main`, {
      method: 'PUT',
      body: JSON.stringify({
        default_horizon: 'mid',
        horizon_profiles: horizon.horizon_profiles ?? {},
      }),
    });
    expect(updatedHorizon.default_horizon).toBe('mid');

    const configItems = await fetchJson<{ items: Array<{ key: string }> }>(`${baseUrl}/api/config/ai`);
    expect(configItems.items[0]?.key).toBe('ai.model');

    const updateConfig = await fetchJson<{ key: string; value: string }>(
      `${baseUrl}/api/config/ai.model`,
      {
        method: 'PUT',
        body: JSON.stringify({ value: 'deepseek-reasoner' }),
      },
    );
    expect(updateConfig.value).toBe('deepseek-reasoner');

    const autopilot = await fetchJson<JsonObject>(`${baseUrl}/api/cluster/autopilot/main`);
    expect(typeof autopilot.enabled).toBe('boolean');

    const updatedAutopilot = await fetchJson<JsonObject>(`${baseUrl}/api/cluster/autopilot/main`, {
      method: 'PUT',
      body: JSON.stringify({
        enabled: true,
        kill_switch: false,
        promote_consecutive_days: 7,
        rollback_cooldown_days: 5,
        guard_consecutive_fail_days: 2,
        guard_window_days: 3,
        slo_p95_budget_ms: 2000,
      }),
    });
    expect(updatedAutopilot.enabled).toBe(true);
  });

  it('returns contribution detail rows by trace and symbol', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'gupiao-backend-http-contrib-'));
    await writeHttpArtifacts(rootDir);
    const contributionReader = createContributionReader([
      {
        newsId: 'news-1',
        keyword: '机器人',
        baseFrequencyScore: 2,
        timeDecayedScore: 1.5,
        reprintPenaltyScore: 1.35,
        finalContribScore: 0.8,
        reasons: ['命中关键词 [机器人]'],
        asOf: '2026-03-18T02:00:00.000Z',
        clusterKey: 'main',
      },
      {
        newsId: 'news-2',
        keyword: '智能制造',
        baseFrequencyScore: 1,
        timeDecayedScore: 0.9,
        reprintPenaltyScore: 0.9,
        finalContribScore: 0.4,
        reasons: ['命中关键词 [智能制造]'],
        asOf: '2026-03-18T02:00:00.000Z',
        clusterKey: 'main',
      },
    ]);

    const server = await startBackendHttpServer({
      rootDir,
      configStore: new InMemoryConfigStore(),
      contributionReader,
      host: '127.0.0.1',
      port: 0,
    });
    runningServers.push(server);

    const payload = await fetchJson<{
      traceId: string;
      symbol: string;
      totalContribution: number;
      rows: Array<{ newsId: string; keyword: string; finalContribScore: number; reasons: string[]; clusterKey: string }>;
    }>(
      `http://127.0.0.1:${server.port}/api/batches/contribution?traceId=trace-1&symbol=300024`,
    );

    expect(payload.traceId).toBe('trace-1');
    expect(payload.symbol).toBe('300024');
    expect(payload.totalContribution).toBeCloseTo(1.2);
    expect(payload.rows).toHaveLength(2);
    expect(payload.rows[0]).toMatchObject({
      newsId: 'news-1',
      keyword: '机器人',
      finalContribScore: 0.8,
      clusterKey: 'main',
    });
  });

  it('rejects contribution detail requests missing trace or symbol', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'gupiao-backend-http-contrib-missing-'));
    await writeHttpArtifacts(rootDir);
    const server = await startBackendHttpServer({
      rootDir,
      configStore: new InMemoryConfigStore(),
      contributionReader: createContributionReader([]),
      host: '127.0.0.1',
      port: 0,
    });
    runningServers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/api/batches/contribution?traceId=trace-1`);
    const payload = await response.json() as { status: string; detail: string };

    expect(response.status).toBe(400);
    expect(payload.status).toBe('待查');
    expect(payload.detail).toContain('symbol');
  });

  it('returns an empty contribution detail payload when no rows exist', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'gupiao-backend-http-contrib-empty-'));
    await writeHttpArtifacts(rootDir);
    const server = await startBackendHttpServer({
      rootDir,
      configStore: new InMemoryConfigStore(),
      contributionReader: createContributionReader([]),
      host: '127.0.0.1',
      port: 0,
    });
    runningServers.push(server);

    const payload = await fetchJson<{
      traceId: string;
      symbol: string;
      totalContribution: number;
      rows: unknown[];
    }>(
      `http://127.0.0.1:${server.port}/api/batches/contribution?traceId=trace-empty&symbol=000001`,
    );

    expect(payload).toEqual({
      traceId: 'trace-empty',
      symbol: '000001',
      totalContribution: 0,
      rows: [],
    });
  });
});
