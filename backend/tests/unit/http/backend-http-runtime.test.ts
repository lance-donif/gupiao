import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BackendRuntimeStore } from '../../../src/http/index.js';
import { PgDailyReportSnapshotReader } from '../../../src/http/daily-report-reader.js';
import { buildDailyRecommendationSpawnArgs, resolveBunExecutable, resolveDailyRecommendationScript, RuntimeDataOperations } from '../../../src/http/runtime-data-operations.js';
import { InMemoryConfigStore, writeHttpArtifacts } from './http-fixtures.js';

describe('backend http runtime store', () => {
  it('fails dispatch visibly when a real pipeline cannot be started', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gupiao-backend-runtime-'));
    await writeHttpArtifacts(root);

    const store = new BackendRuntimeStore({
      rootDir: root,
      configStore: new InMemoryConfigStore(),
      dailyReportReader: null,
    });

    const dispatch = await store.dispatchDaily({
      groupId: 'main',
      targetDate: '2026-03-18',
    });

    const batch = (await store.getBatchByTraceId(dispatch.trace_id)) as any;
    const latest = (await store.getLatestBatchByGroup('main')) as any;
    const report = (await store.getDailyReport('2026-03-18', 'main')) as {
      available: boolean;
      report_kind: string;
      recommendations: {
        A: Array<{ ticker: string }>;
        B: Array<{ ticker: string }>;
        C: Array<{ ticker: string }>;
      };
      batch_quality: { schema_checked_count: number };
      meta: { trace_id: string; status: string; created_at: string };
    };
    const traceOverview = await store.getTraceOverview(dispatch.trace_id);
    const traceSteps = await store.getTraceSteps(dispatch.trace_id, undefined, 20);
    const traceEvents = await store.getTraceEvents(dispatch.trace_id, undefined, 20);
    const metricsOverview = await store.getMetricsOverview();
    const settings = (await store.listConfigByCategory('ai')) as { items: Array<{ key: string }> };
    const ml = (await store.getMLRecommendations({
      tradeDate: '2026-03-18',
      groupId: 'main',
      topN: 100,
      forceRefresh: false,
    })) as {
      recommendations: {
        S: Array<{ ticker: string }>;
        A: Array<{ ticker: string }>;
        B: Array<{ ticker: string }>;
        C: Array<{ ticker: string }>;
      };
      analyzed_stocks: number;
    };
    const quote = await store.getRealtimeQuote('300024');
    const whatIf = (await store.runWhatIf({
      group_id: 'main',
      query: '机器人',
      cutoff_date: '2026-03-18',
      max_hops: 3,
      max_items: 5,
    })) as { items: Array<{ symbol: string }> };
    const history = (await store.listWhatIfHistory('main', 20)) as Array<{ query: string }>;
    const backtest = (await store.runBacktest({
      group_id: 'main',
      end_date: '2026-03-18',
      window_days: 20,
    })) as { curve: Array<{ date: string }> };

    expect(dispatch.trace_id).toContain('trace-main-2026-03-18');
    expect(batch?.status).toBe('FAILED');
    expect(batch?.error_code).toBe('DISPATCH_UNAVAILABLE');
    expect(batch?.error_message).toContain('真实推荐流水线');
    expect(batch?.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(latest?.trace_id).toBe(dispatch.trace_id);
    expect(report.available).toBe(false);
    expect(report.report_kind).toBe('EMPTY');
    expect(report.recommendations.A.length + report.recommendations.B.length + report.recommendations.C.length).toBe(0);
    expect(report.batch_quality.schema_checked_count).toBe(0);
    expect(report.meta.trace_id).toBe('');
    expect(report.meta.status).toBe('NO_DB_SNAPSHOT');
    expect((traceOverview as { events_total: number }).events_total).toBe(0);
    expect((traceOverview as { total_tokens: number }).total_tokens).toBe(0);
    expect(traceSteps.rows).toHaveLength(0);
    expect(traceEvents.rows).toHaveLength(0);
    expect(metricsOverview.latest_trade_date).toBe('2026-03-18');
    expect(settings.items[0]?.key).toBe('ai.model');
    expect(ml.analyzed_stocks).toBeGreaterThan(0);
    expect(quote.price).toBeNull();
    expect(whatIf.items[0]?.symbol).toBeDefined();
    expect(history[0]?.query).toBe('机器人');
    expect(backtest.curve.length).toBe(20);
  });

  it('exposes minimal batch and cluster http shell responses for web polling', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gupiao-backend-http-shell-'));
    await writeHttpArtifacts(root);

    const store = new BackendRuntimeStore({
      rootDir: root,
      configStore: new InMemoryConfigStore(),
      dailyReportReader: null,
    });

    const dispatch = await store.dispatchDaily({
      groupId: 'main',
      targetDate: '2026-03-18',
    });

    const clusters = await store.listClusters();
    const batches = await store.listBatches(10);
    const latest = (await store.getLatestBatchByGroup('main')) as any;
    const progress = await store.getLatestBatchProgress('main');

    expect(dispatch.celery_task_id).toContain(dispatch.trace_id);
    expect(clusters[0]).toMatchObject({
      id: 'main',
      name: '主集群',
      description: expect.any(String),
      active_version_id: expect.any(String),
      last_batch_status: 'FAILED',
      last_target_trading_date: '2026-03-18',
    });
    expect(batches[0]).toMatchObject({
      group_id: 'main',
      trace_id: dispatch.trace_id,
      status: 'FAILED',
      error_code: 'DISPATCH_UNAVAILABLE',
    });
    expect(latest?.trace_id).toBe(dispatch.trace_id);
    expect(progress).toMatchObject({
      trace_id: dispatch.trace_id,
      group_id: 'main',
      batch_status: 'FAILED',
      current_stage: 'failed',
    });
    expect(progress?.nodes).toHaveLength(9);
  });

  it('resolves bun executable from env, current runtime, home install, then PATH fallback', () => {
    expect(resolveBunExecutable({
      env: { BUN_EXECUTABLE: '/opt/bun', HOME: '/home/test' },
      execPath: '/usr/local/bin/node',
      existsSync: () => false,
    })).toBe('/opt/bun');

    expect(resolveBunExecutable({
      env: { HOME: '/home/test' },
      execPath: '/Users/lance/.bun/bin/bun',
      existsSync: () => false,
    })).toBe('/Users/lance/.bun/bin/bun');

    expect(resolveBunExecutable({
      env: { HOME: '/home/test' },
      execPath: '/usr/local/bin/node',
      existsSync: candidate => candidate === '/home/test/.bun/bin/bun',
    })).toBe('/home/test/.bun/bin/bun');

    expect(resolveBunExecutable({
      env: {},
      execPath: '/usr/local/bin/node',
      existsSync: () => false,
    })).toBe('bun');
  });

  it('resolves the compiled daily recommendation script inside runtime containers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gupiao-backend-runtime-script-'));
    await mkdir(path.join(root, 'dist', 'scripts'), { recursive: true });
    await writeFile(path.join(root, 'dist', 'scripts', 'run-daily-recommendation.js'), '');

    expect(resolveDailyRecommendationScript(root)).toEqual({
      relativePath: 'dist/scripts/run-daily-recommendation.js',
    });
  });

  it('passes AKTools limits from environment into daily recommendation spawn arguments', () => {
    const args = buildDailyRecommendationSpawnArgs({
      scriptPath: 'dist/scripts/run-daily-recommendation.js',
      clusterKey: 'global',
      asOf: '2026-05-28T15:59:59.999Z',
      traceId: 'trace-main-2026-05-28-test',
      env: {
        AKTOOLS_BOARD_LIMIT: '20',
        AKTOOLS_SYMBOL_LIMIT: '20',
      },
    });

    expect(args).toEqual([
      'dist/scripts/run-daily-recommendation.js',
      '--cluster',
      'global',
      '--as-of',
      '2026-05-28T15:59:59.999Z',
      '--trace-id',
      'trace-main-2026-05-28-test',
      '--aktools-board-limit',
      '20',
      '--aktools-symbol-limit',
      '20',
    ]);
  });

  it('rejects missing or invalid AKTools limits before spawning a daily recommendation', () => {
    expect(() => buildDailyRecommendationSpawnArgs({
      scriptPath: 'dist/scripts/run-daily-recommendation.js',
      clusterKey: 'global',
      asOf: '2026-05-28T15:59:59.999Z',
      traceId: 'trace-main-2026-05-28-test',
      env: {
        AKTOOLS_BOARD_LIMIT: '0',
        AKTOOLS_SYMBOL_LIMIT: '20',
      },
    })).toThrow('AKTOOLS_BOARD_LIMIT must be a positive integer');

    expect(() => buildDailyRecommendationSpawnArgs({
      scriptPath: 'dist/scripts/run-daily-recommendation.js',
      clusterKey: 'global',
      asOf: '2026-05-28T15:59:59.999Z',
      traceId: 'trace-main-2026-05-28-test',
      env: {
        AKTOOLS_BOARD_LIMIT: '20',
      },
    })).toThrow('AKTOOLS_SYMBOL_LIMIT must be a positive integer');
  });

  it('marks HTTP-triggered daily runs failed when AKTools limit env is invalid', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gupiao-backend-runtime-invalid-aktools-'));
    await writeHttpArtifacts(root);
    await mkdir(path.join(root, 'dist', 'scripts'), { recursive: true });
    await writeFile(path.join(root, 'dist', 'scripts', 'run-daily-recommendation.js'), '');
    const previousBoardLimit = process.env.AKTOOLS_BOARD_LIMIT;
    const previousSymbolLimit = process.env.AKTOOLS_SYMBOL_LIMIT;
    process.env.AKTOOLS_BOARD_LIMIT = '0';
    process.env.AKTOOLS_SYMBOL_LIMIT = '20';

    try {
      const store = new BackendRuntimeStore({
        rootDir: root,
        configStore: new InMemoryConfigStore(),
        pgPool: {
          async query<T>() {
            return { rows: [] as T[] };
          },
        },
      });

      const dispatch = await store.dispatchDaily({
        groupId: 'main',
        targetDate: '2026-05-28',
      });
      const batch = await store.getBatchByTraceId(dispatch.trace_id) as { status: string; error_code: string; error_message: string } | null;

      expect(batch).toMatchObject({
        status: 'FAILED',
        error_code: 'DISPATCH_CONFIG_INVALID',
        error_message: expect.stringContaining('AKTOOLS_BOARD_LIMIT must be a positive integer'),
      });
    }
    finally {
      if (previousBoardLimit === undefined) {
        delete process.env.AKTOOLS_BOARD_LIMIT;
      }
      else {
        process.env.AKTOOLS_BOARD_LIMIT = previousBoardLimit;
      }
      if (previousSymbolLimit === undefined) {
        delete process.env.AKTOOLS_SYMBOL_LIMIT;
      }
      else {
        process.env.AKTOOLS_SYMBOL_LIMIT = previousSymbolLimit;
      }
    }
  });

  it('filters latest batch and progress by requested trading date when supplied', async () => {
    const data = new RuntimeDataOperations({
      options: {},
      runtimeStateStore: {
        async read() {
          return {
            batches: [
              {
                id: 'batch-old',
                group_id: 'main',
                group_version_id: 'main-v1',
                target_trading_date: '2026-05-25',
                status: 'COMPLETED',
                trace_id: 'trace-old',
                run_fingerprint: 'trace-old',
                enqueued_at: 0,
                started_at: '2026-05-25 16:00:00',
                finished_at: '2026-05-25 17:00:00',
                graph_done: true,
                chroma_done: true,
                market_cached_done: true,
                schema_checked_count: 30,
                schema_mismatch_count: 0,
                schema_mismatch_rate: 0,
                promote_blocked_by_quality: false,
                quality_warnings_json: '[]',
                error_code: null,
                error_message: null,
                progress_percent: 100,
                current_stage: 'completed',
                current_stage_index: 9,
                remaining_node_count: 0,
                nodes: [],
                created_at: '2026-05-25 17:00:00',
              },
            ],
            traces: {},
          };
        },
      },
    } as any);

    expect(await data.getLatestBatchByGroup('main', '2026-05-26')).toBeNull();
    expect(await data.getLatestBatchProgress('main', '2026-05-26')).toBeNull();
    expect((await data.getLatestBatchByGroup('main', '2026-05-25') as { trace_id: string } | null)?.trace_id).toBe('trace-old');
  });

  it('lists batches from RunTrace when database traces are available', async () => {
    const traceId = 'trace-main-2026-06-02-dbfailed';
    const data = new RuntimeDataOperations({
      options: {
        pgPool: {
          async query<T>(sql: string) {
            if (sql.includes('FROM public."RunTrace"') && sql.includes('ORDER BY "triggeredAt" DESC')) {
              return {
                rows: [{
                  traceId,
                  clusterKey: 'global',
                  status: 'FAILED',
                  triggeredAt: '2026-06-02 04:39:06.933',
                  completedAt: '2026-06-02 04:46:59.017',
                  asOf: '2026-06-02 15:59:59.999',
                  errorMessage: 'Causal signal AI request failed with HTTP 502',
                }] as T[],
              };
            }
            if (sql.includes('FROM public."PipelineStepTrace"')) {
              return {
                rows: [
                  {
                    traceId,
                    stepName: 'stock_exposure_tickflow',
                    status: 'SUCCESS',
                    startedAt: '2026-06-02 04:39:19.229',
                    endedAt: '2026-06-02 04:46:54.280',
                    errorMessage: null,
                    inputSummary: null,
                    outputSummary: null,
                  },
                  {
                    traceId,
                    stepName: 'causal_signal_extraction',
                    status: 'FAILED',
                    startedAt: '2026-06-02 04:46:54.293',
                    endedAt: '2026-06-02 04:46:59.013',
                    errorMessage: 'Causal signal AI request failed with HTTP 502',
                    inputSummary: null,
                    outputSummary: null,
                  },
                ] as T[],
              };
            }
            return { rows: [] as T[] };
          },
        },
      },
      runtimeStateStore: {
        async read() {
          return {
            batches: [{
              trace_id: traceId,
              status: 'PENDING',
              current_stage: 'pending',
            }],
          };
        },
      },
    } as any);

    const batches = await data.listBatches(10) as Array<{
      trace_id: string;
      status: string;
      current_stage: string;
      error_message: string | null;
      nodes: Array<{ node_id: string; status: string }>;
    }>;

    expect(batches[0]).toMatchObject({
      trace_id: traceId,
      status: 'FAILED',
      current_stage: 'causal_signal_extraction',
      error_message: 'Causal signal AI request failed with HTTP 502',
    });
    expect(batches[0]?.nodes.find(node => node.node_id === 'stock_exposure_tickflow')?.status).toBe('completed');
    expect(batches[0]?.nodes.find(node => node.node_id === 'causal_signal_extraction')?.status).toBe('failed');
  });

  it('marks unrecorded display nodes completed when a database trace succeeds', async () => {
    const traceId = 'trace-main-2026-06-02-success';
    const data = new RuntimeDataOperations({
      options: {
        pgPool: {
          async query<T>(sql: string) {
            if (sql.includes('FROM public."RunTrace"') && sql.includes('ORDER BY "triggeredAt" DESC')) {
              return {
                rows: [{
                  traceId,
                  clusterKey: 'global',
                  status: 'SUCCESS',
                  triggeredAt: '2026-06-02 04:39:06.933',
                  completedAt: '2026-06-02 04:46:59.017',
                  asOf: '2026-06-02 15:59:59.999',
                  errorMessage: null,
                }] as T[],
              };
            }
            if (sql.includes('FROM public."PipelineStepTrace"')) {
              return {
                rows: [
                  {
                    traceId,
                    stepName: 'news_fetch',
                    status: 'SUCCESS',
                    startedAt: '2026-06-02 04:39:06.933',
                    endedAt: '2026-06-02 04:39:19.229',
                    errorMessage: null,
                    inputSummary: null,
                    outputSummary: null,
                  },
                  {
                    traceId,
                    stepName: 'strategy_experiment',
                    status: 'SUCCESS',
                    startedAt: '2026-06-02 04:45:00.000',
                    endedAt: '2026-06-02 04:46:59.017',
                    errorMessage: null,
                    inputSummary: null,
                    outputSummary: null,
                  },
                ] as T[],
              };
            }
            return { rows: [] as T[] };
          },
        },
      },
      runtimeStateStore: {
        async read() {
          return { batches: [] };
        },
      },
    } as any);

    const batches = await data.listBatches(10) as Array<{
      status: string;
      progress_percent: number;
      nodes: Array<{ node_id: string; status: string }>;
    }>;

    expect(batches[0]?.status).toBe('COMPLETED');
    expect(batches[0]?.progress_percent).toBe(100);
    expect(batches[0]?.nodes.find(node => node.node_id === 'graph_snapshot')?.status).toBe('completed');
    expect(batches[0]?.nodes.find(node => node.node_id === 'scoring_recommendation')?.status).toBe('completed');
  });

  it('lists recommendations from database snapshots when legacy artifacts are absent', async () => {
    const traceId = 'trace-main-2026-06-02-dbrec';
    const data = new RuntimeDataOperations({
      options: {
        pgPool: {
          async query<T>(sql: string) {
            if (sql.includes('FROM public."RecommendationSnapshot" r')) {
              return {
                rows: [{
                  traceId,
                  asOf: '2026-06-02 15:59:59.999',
                  rank: 1,
                  symbol: '300853',
                  stockName: '申昊科技',
                  industry: '机械设备',
                  finalScore: '51.7118',
                  reasons: ['评分组件：证据 22.3407/45'],
                  scoreBreakdown: { selectionSignalType: '机器人设备' },
                  evidenceCount: 7,
                  l1EvidenceCount: 7,
                  avgMatchConfidence: '0.9',
                  totalContribution: '0.9859',
                  latestTradingDay: '2026-06-01 00:00:00',
                  latestClose: '38.1',
                  strategyId: null,
                }] as T[],
              };
            }
            if (sql.includes('FROM public."RunTrace" rt')) {
              return {
                rows: [{
                  traceId,
                  clusterKey: 'global',
                  status: 'SUCCESS',
                  triggeredAt: '2026-06-02 06:05:37.352',
                  completedAt: '2026-06-02 06:15:19.561',
                  asOf: '2026-06-02 15:59:59.999',
                  errorMessage: null,
                  stepName: 'strategy_experiment',
                  stepStatus: 'SUCCESS',
                  stepErrorMessage: null,
                }] as T[],
              };
            }
            return { rows: [] as T[] };
          },
        },
      },
      runtimeStateStore: {
        async read() {
          return { batches: [] };
        },
      },
    } as any);

    const recommendations = await data.listRecommendations('2026-06-02', 'main') as Array<{
      trace_id: string;
      items: Array<{ symbol: string; name: string; latest_close: number; stage: string }>;
    }>;

    expect(recommendations[0]?.trace_id).toBe(traceId);
    expect(recommendations[0]?.items[0]).toMatchObject({
      symbol: '300853',
      name: '申昊科技',
      latest_close: 38.1,
      stage: 'A',
    });
  });

  it('reads trace overview from the same RunTrace source as dashboard execution history', async () => {
    const traceId = 'trace-db-completed';
    const data = new RuntimeDataOperations({
      options: {
        pgPool: {
          async query<T>(sql: string) {
            if (sql.includes('FROM public."RunTrace" rt')) {
              return {
                rows: [{
                  traceId,
                  clusterKey: 'global',
                  status: 'SUCCESS',
                  triggeredAt: '2026-05-25 16:50:00',
                  completedAt: '2026-05-25 17:00:00',
                  asOf: '2026-05-25 00:00:00',
                  errorMessage: null,
                  stepName: 'news_fetch',
                }] as T[],
              };
            }
            if (sql.includes('FROM public."RunTrace" WHERE "traceId" = $1')) {
              return {
                rows: [{
                  traceId,
                  clusterKey: 'global',
                  status: 'SUCCESS',
                  triggeredAt: '2026-05-25 16:50:00',
                  completedAt: '2026-05-25 17:00:00',
                  asOf: '2026-05-25 00:00:00',
                  errorMessage: null,
                }] as T[],
              };
            }
            if (sql.includes('FROM public."PipelineStepTrace"')) {
              return {
                rows: [{
                  stepName: 'news_fetch',
                  status: 'SUCCESS',
                  startedAt: '2026-05-25 16:50:00',
                  endedAt: '2026-05-25 16:51:00',
                  errorMessage: null,
                }] as T[],
              };
            }
            return { rows: [] as T[] };
          },
        },
      },
      runtimeStateStore: {
        async read() {
          return {
            batches: [],
            traces: {},
          };
        },
      },
    } as any);

    const dashboard = await data.getDashboardSnapshot('2026-05-25', 'main', null);
    const overview = await data.getTraceOverview(traceId);
    const steps = await data.getTraceSteps(traceId, undefined, 10) as {
      rows: Array<{ node_name: string; status: string; started_at: string; finished_at: string | null }>;
    };

    expect(dashboard.execution_history[0]).toMatchObject({
      trace_id: traceId,
      status: '已完成',
      started_at: '2026-05-25 16:50:00',
      finished_at: '2026-05-25 17:00:00',
      current_stage: 'news_fetch',
    });
    expect(overview).toMatchObject({
      trace_id: traceId,
      status: 'COMPLETED',
      latest_phase: 'completed',
      started_at: '2026-05-25 16:50:00',
      finished_at: '2026-05-25 17:00:00',
      steps_total: 1,
    });
    expect(steps.rows[0]).toMatchObject({
      node_name: 'news_fetch',
      status: 'completed',
      started_at: '2026-05-25 16:50:00',
      finished_at: '2026-05-25 16:51:00',
    });
  });

  it('returns dashboard SLA failure details when the daily recommendation snapshot is absent', async () => {
    const traceId = 'trace-db-failed';
    const data = new RuntimeDataOperations({
      options: {
        pgPool: {
          async query<T>(sql: string) {
            if (sql.includes('FROM public."RecommendationSnapshot" r') || sql.includes('FROM public."StrategyRecommendationEvent" e')) {
              return { rows: [] as T[] };
            }
            if (sql.includes('FROM public."RunTrace" rt')) {
              return {
                rows: [{
                  traceId,
                  clusterKey: 'global',
                  status: 'FAILED',
                  triggeredAt: '2026-05-25 16:50:00',
                  completedAt: '2026-05-25 16:55:00',
                  asOf: '2026-05-25 00:00:00',
                  errorMessage: 'LLM timeout',
                  stepName: 'causal_signal_extraction',
                  stepStatus: 'FAILED',
                  stepErrorMessage: 'LLM timeout',
                }] as T[],
              };
            }
            return { rows: [] as T[] };
          },
        },
      },
      runtimeStateStore: {
        async read() {
          return {
            batches: [],
            traces: {},
          };
        },
      },
    } as any);

    const dashboard = await data.getDashboardSnapshot('2026-05-25', 'main', null);

    expect(dashboard.available).toBe(false);
    expect(dashboard.sla).toMatchObject({
      status: 'failed',
      status_label: '今日推荐失败',
      failed_node: 'causal_signal_extraction',
      failed_node_label: 'AI 因果抽取',
      error_message: 'LLM timeout',
      deadline_at: '2026-05-25 17:00',
    });
    expect(typeof dashboard.sla.next_retry_at === 'string' || dashboard.sla.next_retry_at === null).toBe(true);
  });

  it('daily report reader only returns snapshots for the requested display date', async () => {
    const queries: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];
    const reader = new PgDailyReportSnapshotReader({
      async query<T>(sql: string, values?: readonly unknown[]) {
        queries.push({ sql, values });
        return { rows: [] as T[] };
      },
      async end() {},
    });

    const report = await reader.getDailyReport({ displayDate: '2026-05-26', groupId: 'main' });

    expect(report).toBeNull();
    expect(queries[0]?.sql).toContain('::date = $2::date');
    expect(queries[0]?.sql).not.toContain('r."asOf" <= $2');
    expect(queries[0]?.values).toEqual(['main', '2026-05-26']);
  });

  it('returns realtime quote fields from Candle without close-value fabrication', async () => {
    const data = new RuntimeDataOperations({
      options: {
        pgPool: {
          async query() {
            return {
              rows: [{
                open: '10.1000',
                high: '10.8000',
                low: '9.9000',
                close: '10.5000',
                volume: '123456',
                prevClose: null,
                tradingDay: '2026-05-25T00:00:00.000Z',
              }],
            };
          },
        },
      },
    } as any);

    const quote = await data.getRealtimeQuote('600001');

    expect(quote).toMatchObject({
      ticker: '600001',
      available: true,
      price: 10.5,
      close: 10.5,
      open: 10.1,
      high: 10.8,
      low: 9.9,
      volume: 123456,
      pre_close: null,
      change: null,
      change_pct: null,
      amount: null,
      market_cap: null,
      source: 'database',
    });
  });

  it('prefers same-date database recommendation snapshots for daily report when available', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gupiao-backend-runtime-db-report-'));
    await writeHttpArtifacts(root);

    const store = new BackendRuntimeStore({
      rootDir: root,
      configStore: new InMemoryConfigStore(),
      dailyReportReader: {
        async getDailyReport(query) {
          return {
            available: true,
            report_kind: 'PERSISTED',
            warnings: [],
            summary_text: '数据库推荐快照，1 条推荐',
            group_id: query.groupId,
            group_version_id: `${query.groupId}-db`,
            display_date: query.displayDate,
            as_of_trade_date: query.displayDate,
            recommendation_kind: 'TRADING',
            stage_rules_version: 'db-snapshot-v1',
            batch_quality: {
              schema_checked_count: 1,
              schema_mismatch_count: 0,
              schema_mismatch_rate: 0,
              degraded: false,
              promote_blocked_by_quality: false,
            },
            recommendations: {
              A: [{
                ticker: '002409',
                name: '雅克科技',
                stage: 'A',
                total_score: 66.2509,
                why_this_stock: { short: '真实 EvidenceContribution', detail: '真实 EvidenceContribution' },
                why_now: { detail: '最新可见行情日 2026-05-22' },
                falsification_conditions: [],
                evidence_paths: [],
                selection_reason_texts_zh: ['证据 35.9573/45'],
                latest_close: 116.5,
                evidence_tier: 'E1',
                evidence_path_count: 17,
              }],
              B: [],
              C: [],
            },
            meta: {
              batch_id: 'db-trace',
              trace_id: 'daily-global-2026-05-24-perf-quality-final',
              run_fingerprint: 'db:global:2026-05-24',
              created_at: '2026-05-24 23:59:59',
              status: 'COMPLETED',
            },
          };
        },
      },
    });

    const report = (await store.getDailyReport('2026-05-25', 'global')) as {
      report_kind: string;
      recommendations: { A: Array<{ ticker: string; latest_close: number; evidence_path_count: number }> };
      meta: { trace_id: string };
    };

    expect(report.report_kind).toBe('PERSISTED');
    expect(report.meta.trace_id).toBe('daily-global-2026-05-24-perf-quality-final');
    expect(report.recommendations.A[0]).toMatchObject({
      ticker: '002409',
      latest_close: 116.5,
      evidence_path_count: 17,
    });
  });

  it('keeps cluster feedback, promote confirmation, version switch, and rollback as one state loop', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gupiao-backend-cluster-loop-'));
    await writeHttpArtifacts(root);

    const store = new BackendRuntimeStore({
      rootDir: root,
      configStore: new InMemoryConfigStore(),
    });

    const initialVersions = await store.listClusterVersions('main') as Array<{
      id: string;
      status: string;
      previous_version_id: string | null;
    }>;
    const baseVersionId = initialVersions[0]?.id ?? 'main-v1';

    const feedback = await store.saveClusterFeedback({
      group_id: 'main',
      group_version_id: baseVersionId,
      display_date: '2026-03-18',
      ticker: '300024',
      score: -1,
      reason: '推荐收益低，需要调提示词',
      trace_id: 'trace-feedback',
    }) as { id: string; status: string };
    expect(feedback.status).toBe('待反馈');

    const promote = await store.promoteCluster({
      group_id: 'main',
      feedback_id: feedback.id,
      reason: '根据用户反馈生成新提示词',
    }) as { group_version_id: string; status: string };
    expect(promote.status).toBe('待确认');

    const pendingVersions = await store.listClusterVersions('main') as Array<{
      id: string;
      version: number;
      status: string;
      source_feedback_id: string | null;
      confirmed_by: string | null;
      previous_version_id: string | null;
    }>;
    const pendingVersion = pendingVersions.find(row => row.id === promote.group_version_id);
    const clusterBeforeConfirm = (await store.listClusters()) as Array<{ active_version_id: string | null }>;
    expect(pendingVersion).toMatchObject({
      status: '待确认',
      source_feedback_id: feedback.id,
      confirmed_by: null,
      previous_version_id: baseVersionId,
    });
    expect(clusterBeforeConfirm[0]?.active_version_id).toBe(baseVersionId);

    const confirm = await store.confirmPromoteCluster({
      group_id: 'main',
      group_version_id: promote.group_version_id,
      confirmed_by: 'tester',
    }) as { status: string; confirmed_by: string };
    expect(confirm).toMatchObject({ status: '已升级', confirmed_by: 'tester' });

    const clusterAfterConfirm = (await store.listClusters()) as Array<{ active_version_id: string | null }>;
    const confirmedVersions = await store.listClusterVersions('main') as Array<{ id: string; status: string }>;
    expect(clusterAfterConfirm[0]?.active_version_id).toBe(promote.group_version_id);
    expect(confirmedVersions.find(row => row.id === promote.group_version_id)?.status).toBe('已升级');
    expect(confirmedVersions.find(row => row.id === baseVersionId)?.status).toBe('可回滚');

    const rollback = await store.rollbackCluster({
      group_id: 'main',
      target_group_version_id: baseVersionId,
      reason: '新版本收益不稳定',
    }) as { status: string; old_version_id: string; target_group_version_id: string };
    expect(rollback).toMatchObject({
      status: '已回滚',
      old_version_id: promote.group_version_id,
      target_group_version_id: baseVersionId,
    });

    const clusterAfterRollback = (await store.listClusters()) as Array<{ active_version_id: string | null }>;
    const versionsAfterRollback = await store.listClusterVersions('main') as Array<{ id: string; status: string }>;
    expect(clusterAfterRollback[0]?.active_version_id).toBe(baseVersionId);
    expect(versionsAfterRollback.find(row => row.id === promote.group_version_id)?.status).toBe('已回滚');
    expect(versionsAfterRollback.find(row => row.id === baseVersionId)?.status).toBe('已升级');
  });

  it('keeps what-if stock analysis traceable with short Chinese states', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gupiao-backend-whatif-loop-'));
    await writeHttpArtifacts(root);

    const store = new BackendRuntimeStore({
      rootDir: root,
      configStore: new InMemoryConfigStore(),
    });

    const hit = await store.runWhatIf({
      group_id: 'main',
      query: '机器人',
      cutoff_date: '2026-03-18',
      max_hops: 3,
      max_items: 5,
    }) as {
      status: string;
      expected_output: Record<string, unknown>;
      items: Array<{
        status: string;
        symbol: string;
        match_kind: string;
        entity_path: string[];
        evidence_paths: unknown[];
        tech_details: {
          matched_signals: string[];
          matched_boards: string[];
          score_breakdown: Record<string, number>;
        };
        validation: {
          as_of_checked: boolean;
          cluster_isolated: boolean;
          replayable: boolean;
        };
      }>;
    };

    expect(hit.status).toBe('已完成');
    expect(hit.expected_output).toMatchObject({
      item: '股票 + 关键词路径 + 证据路径 + 验证字段',
    });
    expect(hit.items[0]).toMatchObject({
      status: '已完成',
      symbol: '300024',
      match_kind: '股票名称',
      validation: {
        as_of_checked: true,
        cluster_isolated: true,
        replayable: true,
      },
    });
    expect(hit.items[0]?.entity_path.length).toBeGreaterThan(0);
    expect(hit.items[0]?.evidence_paths.length).toBeGreaterThan(0);
    expect(hit.items[0]?.tech_details.matched_signals).toContain('机器人');
    expect(hit.items[0]?.tech_details.matched_boards).toContain('智能制造');
    expect(hit.items[0]?.tech_details.score_breakdown.relationshipConfidenceScore).toBe(2);

    const miss = await store.runWhatIf({
      group_id: 'main',
      query: '不存在的关键词',
      cutoff_date: '2026-03-18',
      max_hops: 3,
      max_items: 5,
    }) as {
      status: string;
      items: unknown[];
      suggestions: string[];
      hint: string | null;
    };

    expect(miss.status).toBe('无数据');
    expect(miss.items).toHaveLength(0);
    expect(miss.suggestions).toContain('机器人');
    expect(miss.hint).toBe('未命中，已返回候选建议');
  });
});
