import type { IncomingMessage, ServerResponse } from 'node:http';

import type { BackendRuntimeStore } from './runtime-store.js';
import type { GraphKind } from './runtime-types.js';
import type { IStrategyProfitQuery } from './types.js';
import { parsePositiveInteger, readJsonBody, writeJson, writeSseData, writeSseHeaders } from './http-utils.js';
import { resolveDefaultTargetDate } from './runtime-store.js';

interface RouteResult { handled: boolean; ok: boolean }

const decodePathParam = (value: string): string => decodeURIComponent(value);

const asGraphKind = (pathname: string): GraphKind => (pathname.endsWith('/causal') ? 'causal' : 'execution');

const matchPath = (pathname: string, pattern: RegExp): RegExpMatchArray | null => pathname.match(pattern);

const strategyProfitSortByValues = new Set(['execution_time', 'rank', 'live', 't1', 't3', 't5']);
const strategyProfitSortOrderValues = new Set(['asc', 'desc']);

const parseStrategyProfitSortBy = (value: string | null): IStrategyProfitQuery['sort_by'] => {
  return value && strategyProfitSortByValues.has(value) ? value as NonNullable<IStrategyProfitQuery['sort_by']> : null;
};

const parseStrategyProfitSortOrder = (value: string | null): IStrategyProfitQuery['sort_order'] => {
  return value && strategyProfitSortOrderValues.has(value) ? value as NonNullable<IStrategyProfitQuery['sort_order']> : null;
};

const parseCursor = (raw: string | null): number | undefined => {
  if (raw == null || raw.trim() === '') {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return Math.floor(parsed);
};

export const handleBackendRoute = async (
  request: IncomingMessage,
  response: ServerResponse,
  store: BackendRuntimeStore,
  host: string,
): Promise<RouteResult> => {
  const url = new URL(request.url ?? '/', `http://${host}`);
  const pathname = url.pathname;
  const method = request.method ?? 'GET';

  if (method === 'GET' && pathname === '/health') {
    writeJson(response, 200, { ok: true });
    return { handled: true, ok: true };
  }

  if (method === 'GET' && pathname === '/api/cluster/list') {
    writeJson(response, 200, await store.listClusters());
    return { handled: true, ok: true };
  }

  if (method === 'GET' && pathname === '/api/cluster/versions') {
    writeJson(response, 200, await store.listClusterVersions(url.searchParams.get('group_id') ?? 'main'));
    return { handled: true, ok: true };
  }

  if (pathname === '/api/cluster/feedback' && method === 'GET') {
    writeJson(
      response,
      200,
      await store.listClusterFeedback(
        url.searchParams.get('group_id') ?? 'main',
        url.searchParams.get('display_date') ?? resolveDefaultTargetDate(),
      ),
    );
    return { handled: true, ok: true };
  }

  if (pathname === '/api/cluster/feedback' && method === 'POST') {
    writeJson(response, 200, await store.saveClusterFeedback(await readJsonBody(request)));
    return { handled: true, ok: true };
  }

  if (pathname === '/api/cluster/promote/preflight' && method === 'GET') {
    writeJson(response, 200, await store.getPromotePreflight(url.searchParams.get('group_id') ?? 'main'));
    return { handled: true, ok: true };
  }

  if (pathname === '/api/cluster/promote' && method === 'POST') {
    writeJson(response, 200, await store.promoteCluster(await readJsonBody(request)));
    return { handled: true, ok: true };
  }

  if (pathname === '/api/cluster/promote/confirm' && method === 'POST') {
    writeJson(response, 200, await store.confirmPromoteCluster(await readJsonBody(request)));
    return { handled: true, ok: true };
  }

  if (pathname === '/api/cluster/rollback' && method === 'POST') {
    writeJson(response, 200, await store.rollbackCluster(await readJsonBody(request)));
    return { handled: true, ok: true };
  }

  const horizonMatch = matchPath(pathname, /^\/api\/strategy\/horizons\/([^/]+)$/);
  if (horizonMatch) {
    const groupId = decodePathParam(horizonMatch[1] ?? 'main');
    if (method === 'GET') {
      writeJson(response, 200, await store.getHorizonPolicy(groupId));
      return { handled: true, ok: true };
    }
    if (method === 'PUT') {
      writeJson(response, 200, await store.updateHorizonPolicy(groupId, await readJsonBody(request)));
      return { handled: true, ok: true };
    }
  }

  if (pathname === '/api/strategy/definitions' && method === 'GET') {
    writeJson(response, 200, await store.listStrategies(url.searchParams.get('group_id') ?? 'main'));
    return { handled: true, ok: true };
  }

  if (pathname === '/api/strategy/definitions' && method === 'POST') {
    const body = await readJsonBody<Record<string, unknown>>(request);
    writeJson(response, 200, await store.createStrategy(String(body.group_id ?? url.searchParams.get('group_id') ?? 'main'), body));
    return { handled: true, ok: true };
  }

  const strategyDefinitionMatch = matchPath(pathname, /^\/api\/strategy\/definitions\/([^/]+)$/);
  if (strategyDefinitionMatch) {
    const strategyId = decodePathParam(strategyDefinitionMatch[1] ?? '');
    if (method === 'PUT') {
      const body = await readJsonBody<Record<string, unknown>>(request);
      writeJson(
        response,
        200,
        await store.updateStrategy(String(body.group_id ?? url.searchParams.get('group_id') ?? 'main'), strategyId, body),
      );
      return { handled: true, ok: true };
    }
    if (method === 'DELETE') {
      writeJson(response, 200, await store.deleteStrategy(url.searchParams.get('group_id') ?? 'main', strategyId));
      return { handled: true, ok: true };
    }
  }

  const strategyCopyMatch = matchPath(pathname, /^\/api\/strategy\/definitions\/([^/]+)\/copy$/);
  if (strategyCopyMatch && method === 'POST') {
    const body = await readJsonBody<Record<string, unknown>>(request);
    writeJson(
      response,
      200,
      await store.copyStrategy(String(body.group_id ?? url.searchParams.get('group_id') ?? 'main'), decodePathParam(strategyCopyMatch[1] ?? ''), body),
    );
    return { handled: true, ok: true };
  }

  if (pathname === '/api/strategy/performance-reports' && method === 'GET') {
    writeJson(
      response,
      200,
      await store.getStrategyPerformanceReports(
        url.searchParams.get('group_id') ?? 'main',
        url.searchParams.get('strategy_id'),
        parsePositiveInteger(url.searchParams.get('limit'), 50),
      ),
    );
    return { handled: true, ok: true };
  }

  if (pathname === '/api/strategy/profits' && method === 'GET') {
    writeJson(
      response,
      200,
      await store.getStrategyProfits(
        url.searchParams.get('group_id') ?? 'main',
        url.searchParams.get('as_of') ?? resolveDefaultTargetDate(),
        {
          trace_id: url.searchParams.get('trace_id'),
          strategy_id: url.searchParams.get('strategy_id'),
          symbol_query: url.searchParams.get('symbol_query'),
          return_status: url.searchParams.get('return_status'),
          sort_by: parseStrategyProfitSortBy(url.searchParams.get('sort_by')),
          sort_order: parseStrategyProfitSortOrder(url.searchParams.get('sort_order')),
        },
      ),
    );
    return { handled: true, ok: true };
  }

  const autopilotMatch = matchPath(pathname, /^\/api\/cluster\/autopilot\/([^/]+)$/);
  if (autopilotMatch) {
    const groupId = decodePathParam(autopilotMatch[1] ?? 'main');
    if (method === 'GET') {
      writeJson(response, 200, await store.getAutopilotPolicy(groupId));
      return { handled: true, ok: true };
    }
    if (method === 'PUT') {
      writeJson(response, 200, await store.updateAutopilotPolicy(groupId, await readJsonBody(request)));
      return { handled: true, ok: true };
    }
    if (method === 'POST') {
      // 评估触发：由调度器异步执行 DB 查询并生成升级建议
      writeJson(response, 200, await store.evaluateAutopilot(groupId));
      return { handled: true, ok: true };
    }
  }

  if (pathname === '/api/dispatch/daily' && method === 'POST') {
    const body = await readJsonBody<{ group_id?: string; target_date?: string | null }>(request);
    writeJson(
      response,
      200,
      await store.dispatchDaily({
        groupId: body.group_id ?? 'main',
        targetDate: body.target_date ?? resolveDefaultTargetDate(),
      }),
    );
    return { handled: true, ok: true };
  }

  if (pathname === '/api/batches' && method === 'GET') {
    writeJson(response, 200, await store.listBatches(parsePositiveInteger(url.searchParams.get('limit'), 20)));
    return { handled: true, ok: true };
  }

  if (pathname === '/api/batches/contribution' && method === 'GET') {
    const traceId = (url.searchParams.get('traceId') ?? '').trim();
    const symbol = (url.searchParams.get('symbol') ?? '').trim();
    if (!traceId || !symbol) {
      writeJson(response, 400, { status: '待查', detail: '缺少 traceId 或 symbol' });
      return { handled: true, ok: false };
    }
    let payload: Awaited<ReturnType<BackendRuntimeStore['getContributionDetail']>>;
    try {
      payload = await store.getContributionDetail(traceId, symbol);
    }
    catch {
      writeJson(response, 500, { status: '查询失败', detail: '查询失败' });
      return { handled: true, ok: false };
    }
    if (!payload || payload.rows.length === 0) {
      writeJson(response, 200, payload ?? { traceId, symbol, totalContribution: 0, rows: [] });
      return { handled: true, ok: true };
    }
    writeJson(response, 200, payload);
    return { handled: true, ok: true };
  }

  const byTraceMatch = matchPath(pathname, /^\/api\/batches\/by-trace\/(.+)$/);
  if (byTraceMatch && method === 'GET') {
    const payload = await store.getBatchByTraceId(decodePathParam(byTraceMatch[1] ?? ''));
    writeJson(response, payload ? 200 : 404, payload ?? { detail: 'batch not found' });
    return { handled: true, ok: Boolean(payload) };
  }

  const latestProgressMatch = matchPath(pathname, /^\/api\/batches\/latest\/([^/]+)\/progress$/);
  if (latestProgressMatch && method === 'GET') {
    const payload = await store.getLatestBatchProgress(
      decodePathParam(latestProgressMatch[1] ?? 'main'),
      url.searchParams.get('target_date') ?? url.searchParams.get('display_date') ?? url.searchParams.get('trade_date'),
    );
    writeJson(response, payload ? 200 : 404, payload ?? { detail: 'batch not found' });
    return { handled: true, ok: Boolean(payload) };
  }

  const latestBatchMatch = matchPath(pathname, /^\/api\/batches\/latest\/([^/]+)$/);
  if (latestBatchMatch && method === 'GET') {
    const payload = await store.getLatestBatchByGroup(
      decodePathParam(latestBatchMatch[1] ?? 'main'),
      url.searchParams.get('target_date') ?? url.searchParams.get('display_date') ?? url.searchParams.get('trade_date'),
    );
    writeJson(response, payload ? 200 : 404, payload ?? null);
    return { handled: true, ok: Boolean(payload) };
  }

  const nodeResultMatch = matchPath(pathname, /^\/api\/batches\/([^/]+)\/nodes\/([^/]+)\/result$/);
  if (nodeResultMatch && method === 'GET') {
    const payload = await store.getBatchNodeResult(
      decodePathParam(nodeResultMatch[1] ?? ''),
      decodePathParam(nodeResultMatch[2] ?? ''),
      url.searchParams.get('section') ?? undefined,
      parsePositiveInteger(url.searchParams.get('page'), 1),
      parsePositiveInteger(url.searchParams.get('page_size'), 20),
    );
    writeJson(response, payload ? 200 : 404, payload ?? { detail: 'node result not found' });
    return { handled: true, ok: Boolean(payload) };
  }

  if (pathname === '/api/recommendations' && method === 'GET') {
    writeJson(
      response,
      200,
      await store.listRecommendations(
        url.searchParams.get('trade_date') ?? resolveDefaultTargetDate(),
        url.searchParams.get('group_id') ?? 'main',
      ),
    );
    return { handled: true, ok: true };
  }

  if (pathname === '/api/nontrading-recommendations' && method === 'GET') {
    writeJson(
      response,
      200,
      await store.listNonTradingRecommendations(
        url.searchParams.get('display_date') ?? resolveDefaultTargetDate(),
        url.searchParams.get('group_id') ?? 'main',
      ),
    );
    return { handled: true, ok: true };
  }

  if (pathname === '/api/report/daily' && method === 'GET') {
    writeJson(
      response,
      200,
      await store.getDailyReport(
        url.searchParams.get('display_date') ?? resolveDefaultTargetDate(),
        url.searchParams.get('group_id') ?? 'main',
      ),
    );
    return { handled: true, ok: true };
  }

  if (pathname === '/api/dashboard/snapshot' && method === 'GET') {
    writeJson(
      response,
      200,
      await store.getDashboardSnapshot(
        url.searchParams.get('display_date') ?? resolveDefaultTargetDate(),
        url.searchParams.get('group_id') ?? 'main',
        url.searchParams.get('strategy_id'),
      ),
    );
    return { handled: true, ok: true };
  }

  const dashboardStockDetailMatch = matchPath(pathname, /^\/api\/dashboard\/stocks\/([^/]+)\/detail$/);
  if (dashboardStockDetailMatch && method === 'GET') {
    writeJson(
      response,
      200,
      await store.getDashboardStockDetail(
        decodePathParam(dashboardStockDetailMatch[1] ?? ''),
        (url.searchParams.get('trace_id') ?? '').trim(),
        url.searchParams.get('group_id') ?? 'main',
        url.searchParams.get('strategy_id'),
      ),
    );
    return { handled: true, ok: true };
  }

  const dashboardStockEvidenceMatch = matchPath(pathname, /^\/api\/dashboard\/stocks\/([^/]+)\/evidence$/);
  if (dashboardStockEvidenceMatch && method === 'GET') {
    writeJson(
      response,
      200,
      await store.getDashboardStockEvidence(
        decodePathParam(dashboardStockEvidenceMatch[1] ?? ''),
        (url.searchParams.get('trace_id') ?? '').trim(),
        url.searchParams.get('group_id') ?? 'main',
      ),
    );
    return { handled: true, ok: true };
  }

  const dashboardStockNetworkMatch = matchPath(pathname, /^\/api\/dashboard\/stocks\/([^/]+)\/network$/);
  if (dashboardStockNetworkMatch && method === 'GET') {
    writeJson(
      response,
      200,
      await store.getDashboardStockNetwork(
        decodePathParam(dashboardStockNetworkMatch[1] ?? ''),
        (url.searchParams.get('trace_id') ?? '').trim(),
        url.searchParams.get('group_id') ?? 'main',
      ),
    );
    return { handled: true, ok: true };
  }

  if (pathname === '/api/graph' && method === 'GET') {
    writeJson(
      response,
      200,
      await store.getGraph(
        url.searchParams.get('cutoff_date') ?? resolveDefaultTargetDate(),
        url.searchParams.get('group_id') ?? 'main',
        parsePositiveInteger(url.searchParams.get('max_nodes'), 200),
      ),
    );
    return { handled: true, ok: true };
  }

  if ((pathname === '/api/graph/execution' || pathname === '/api/graph/causal') && method === 'GET') {
    writeJson(
      response,
      200,
      await store.getRuntimeGraph(
        url.searchParams.get('trace_id') ?? '',
        asGraphKind(pathname),
        parsePositiveInteger(url.searchParams.get('max_nodes'), 2000),
      ),
    );
    return { handled: true, ok: true };
  }

  const traceOverviewMatch = matchPath(pathname, /^\/api\/trace\/([^/]+)\/overview$/);
  if (traceOverviewMatch && method === 'GET') {
    writeJson(response, 200, await store.getTraceOverview(decodePathParam(traceOverviewMatch[1] ?? '')));
    return { handled: true, ok: true };
  }

  const traceStepsMatch = matchPath(pathname, /^\/api\/trace\/([^/]+)\/steps$/);
  if (traceStepsMatch && method === 'GET') {
    writeJson(
      response,
      200,
      await store.getTraceSteps(
        decodePathParam(traceStepsMatch[1] ?? ''),
        parseCursor(url.searchParams.get('cursor')),
        parsePositiveInteger(url.searchParams.get('limit'), 200),
      ),
    );
    return { handled: true, ok: true };
  }

  const traceEventsMatch = matchPath(pathname, /^\/api\/trace\/([^/]+)\/events$/);
  if (traceEventsMatch && method === 'GET') {
    writeJson(
      response,
      200,
      await store.getTraceEvents(
        decodePathParam(traceEventsMatch[1] ?? ''),
        parseCursor(url.searchParams.get('cursor')),
        parsePositiveInteger(url.searchParams.get('limit'), 500),
      ),
    );
    return { handled: true, ok: true };
  }

  const traceCostsMatch = matchPath(pathname, /^\/api\/trace\/([^/]+)\/llm-costs$/);
  if (traceCostsMatch && method === 'GET') {
    writeJson(response, 200, await store.getTraceCosts(decodePathParam(traceCostsMatch[1] ?? '')));
    return { handled: true, ok: true };
  }

  const traceStreamMatch = matchPath(pathname, /^\/api\/trace\/([^/]+)\/stream$/);
  if (traceStreamMatch && method === 'GET') {
    const traceId = decodePathParam(traceStreamMatch[1] ?? '');
    const lastEventId = Number(url.searchParams.get('last_event_id') ?? '0');
    const safeLast = Number.isFinite(lastEventId) ? Math.max(0, Math.floor(lastEventId)) : 0;
    writeSseHeaders(response);
    writeSseData(response, { event: 'ready', data: JSON.stringify({ trace_id: traceId, connected: true }) });
    const rows = await store.getTraceEventsAfter(traceId, safeLast);
    for (const row of rows) {
      writeSseData(response, { id: String(row.id ?? ''), data: JSON.stringify(row) });
    }
    const timer = setInterval(() => {
      if (response.writableEnded) {
        clearInterval(timer);
        return;
      }
      response.write(': keepalive\n\n');
    }, 15000);
    const close = () => {
      clearInterval(timer);
      if (!response.writableEnded) {
        response.end();
      }
    };
    request.on('close', close);
    response.on('close', close);
    return { handled: true, ok: true };
  }

  if (pathname === '/metrics/overview' && method === 'GET') {
    writeJson(response, 200, await store.getMetricsOverview());
    return { handled: true, ok: true };
  }

  const metricsTraceMatch = matchPath(pathname, /^\/metrics\/trace\/([^/]+)$/);
  if (metricsTraceMatch && method === 'GET') {
    writeJson(
      response,
      200,
      await store.getMetricsTrace(
        decodePathParam(metricsTraceMatch[1] ?? ''),
        parseCursor(url.searchParams.get('cursor')),
        parsePositiveInteger(url.searchParams.get('limit'), 200),
      ),
    );
    return { handled: true, ok: true };
  }

  if (pathname === '/api/metrics/latency/overview' && method === 'GET') {
    writeJson(
      response,
      200,
      await store.getLatencyOverview(parsePositiveInteger(url.searchParams.get('window_minutes'), 5)),
    );
    return { handled: true, ok: true };
  }

  if (pathname === '/api/metrics/latency/endpoints' && method === 'GET') {
    writeJson(
      response,
      200,
      await store.getLatencyEndpoints(parsePositiveInteger(url.searchParams.get('window_minutes'), 5)),
    );
    return { handled: true, ok: true };
  }

  if (pathname === '/api/metrics/latency/interactions' && method === 'GET') {
    writeJson(
      response,
      200,
      await store.getLatencyInteractions(parsePositiveInteger(url.searchParams.get('window_minutes'), 60)),
    );
    return { handled: true, ok: true };
  }

  if (pathname === '/api/metrics/latency/interactions' && method === 'POST') {
    writeJson(response, 200, await store.postLatencyInteraction(await readJsonBody(request)));
    return { handled: true, ok: true };
  }

  if (pathname === '/api/ml-recommendations' && method === 'GET') {
    writeJson(
      response,
      200,
      await store.getMLRecommendations({
        tradeDate: url.searchParams.get('trade_date') ?? resolveDefaultTargetDate(),
        groupId: url.searchParams.get('group_id') ?? 'main',
        topN: parsePositiveInteger(url.searchParams.get('top_n'), 100),
        forceRefresh: (url.searchParams.get('force_refresh') ?? 'false').toLowerCase() === 'true',
      }),
    );
    return { handled: true, ok: true };
  }

  const quoteMatch = matchPath(pathname, /^\/api\/ml-recommendations\/stocks\/([^/]+)\/realtime$/);
  if (quoteMatch && method === 'GET') {
    writeJson(response, 200, await store.getRealtimeQuote(decodePathParam(quoteMatch[1] ?? '')));
    return { handled: true, ok: true };
  }

  const configMatch = matchPath(pathname, /^\/api\/config\/([^/]+)$/);
  if (configMatch) {
    const key = decodePathParam(configMatch[1] ?? '');
    if (method === 'GET' && ['ai', 'akshare', 'strategy', 'system'].includes(key)) {
      writeJson(response, 200, await store.listConfigByCategory(key as 'ai' | 'akshare' | 'strategy' | 'system'));
      return { handled: true, ok: true };
    }
    if (method === 'PUT') {
      const body = await readJsonBody<{ value?: string }>(request);
      writeJson(response, 200, await store.updateConfig(key, String(body.value ?? '')));
      return { handled: true, ok: true };
    }
  }

  if (pathname === '/api/whatif' && method === 'POST') {
    writeJson(response, 200, await store.runWhatIf(await readJsonBody(request)));
    return { handled: true, ok: true };
  }

  if (pathname === '/api/whatif/history' && method === 'GET') {
    writeJson(
      response,
      200,
      await store.listWhatIfHistory(
        url.searchParams.get('group_id') ?? 'main',
        parsePositiveInteger(url.searchParams.get('limit'), 20),
      ),
    );
    return { handled: true, ok: true };
  }

  if (pathname === '/api/backtest' && method === 'POST') {
    writeJson(response, 200, await store.runBacktest(await readJsonBody(request)));
    return { handled: true, ok: true };
  }

  return { handled: false, ok: false };
};
