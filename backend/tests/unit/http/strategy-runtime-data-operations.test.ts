import { describe, expect, it } from 'vitest';

import { createTickFlowQuoteReader, RuntimeDataOperations } from '../../../src/http/runtime-data-operations.js';

describe('strategy runtime data operations', () => {
  it('reads realtime quote fields from TickFlow', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const reader = createTickFlowQuoteReader({
      apiKey: 'test-key',
      baseUrl: 'https://tickflow.test',
      fetchImpl: (async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                symbol: '600001.SH',
                last_price: 10.4,
                low: 9.8,
                high: 10.8,
                timestamp: 1780293087000,
              },
            ],
          }),
        } as Response;
      }) as typeof fetch,
    });

    const quotes = await reader.getQuotes(['600001']);

    expect(requests[0]?.url).toBe('https://tickflow.test/v1/quotes');
    expect(requests[0]?.init.method).toBe('POST');
    expect(requests[0]?.init.body).toBe(JSON.stringify({ symbols: ['600001.SH'] }));
    expect(quotes.get('600001')).toEqual({
      price: 10.4,
      day_low: 9.8,
      day_high: 10.8,
      market_time: '2026-06-01T05:51:27.000Z',
      source: 'tickflow',
      status: 'LIVE',
    });
  });

  it('merges partial strategy config updates without resetting existing fields', async () => {
    let storedConfig = {
      limit: 12,
      maxPerSignalType: 3,
      maxPrice: 28,
      exclude688: true,
      excludeST: true,
      recent5dGainMaxPct: 0.12,
      includeSignalTypes: ['半导体'],
      excludeSignalTypes: [],
      weights: {
        evidence: 1.4,
        graph: 0.9,
        exposure: 1.1,
        market: 0.7,
      },
    };

    const queries: string[] = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push(sql);
        if (sql.includes('SELECT "configJson"')) {
          return { rows: [{ configJson: storedConfig }] };
        }
        if (sql.startsWith('UPDATE "StrategyDefinition"')) {
          storedConfig = JSON.parse(String(params?.[6]));
          return { rows: [] };
        }
        if (sql.includes('FROM "StrategyDefinition" sd')) {
          return {
            rows: [{
              id: 'strategy-1',
              clusterKey: 'global',
              name: '策略一',
              description: null,
              enabled: true,
              configJson: storedConfig,
              createdAt: '2026-05-25T00:00:00.000Z',
              updatedAt: '2026-05-25T00:00:00.000Z',
              lastRunAt: null,
              lastStatus: null,
              lastErrorMessage: null,
            }],
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    const data = new RuntimeDataOperations({ options: { pgPool: pool } } as any);

    const updated = await data.updateStrategy('main', 'strategy-1', {
      config_json: {
        maxPrice: null,
        weights: { market: 2 },
      },
    });

    expect(updated.config_json.limit).toBe(12);
    expect(updated.config_json.maxPrice).toBeNull();
    expect(updated.config_json.includeSignalTypes).toEqual(['半导体']);
    expect(updated.config_json.weights).toEqual({
      evidence: 1.4,
      graph: 0.9,
      exposure: 1.1,
      market: 2,
    });
    expect(queries.some(sql => sql.startsWith('UPDATE "StrategyDefinition"'))).toBe(true);
  });

  it('keeps profit events when the stock master row is unavailable', async () => {
    let profitSql = '';
    let profitParams: unknown[] | undefined;
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT DISTINCT ON (s.symbol)')) {
          return { rows: [] };
        }
        if (sql.includes('FROM public."Stock"') || sql.includes('FROM public."StockExposureFact"')) {
          return { rows: [] };
        }
        profitSql = sql;
        profitParams = params;
        return {
          rows: [{
            strategyId: 'strategy-1',
            strategyName: '策略一',
            strategyRunId: 'run-1',
            traceId: 'trace-1',
            clusterKey: 'global',
            asOf: '2026-05-20T15:59:59.999Z',
            rank: 1,
            symbol: '600001',
            stockName: '样本股票',
            industry: '半导体',
            baseTradingDay: '2026-05-20T00:00:00.000Z',
            basePrice: '10.0000',
            currentTradingDay: null,
            currentPrice: null,
            returnPct: null,
            returnStatus: 'NO_CURRENT_PRICE',
            finalScore: '72.2500',
            scoreBreakdown: { evidenceScore: 31, marketSignalScore: 12 },
            reasons: ['命中半导体证据', '市场确认可用'],
          }],
        };
      },
    };
    const data = new RuntimeDataOperations({ options: { pgPool: pool } } as any);

    const payload = await data.getStrategyProfits('main', '2026-05-25', 'trace-1');

    expect(profitSql).toContain('LEFT JOIN "Stock"');
    expect(profitSql).toContain('e."traceId" = $3::text');
    expect(profitSql).toContain('(e."asOf" + interval');
    expect(profitParams?.[2]).toBe('trace-1');
    expect(profitSql).not.toContain('LIMIT 500');
    expect(payload.rows).toHaveLength(1);
    expect(profitSql).toContain('OFFSET 0 LIMIT 1');
    expect(profitSql).toContain('OFFSET 2 LIMIT 1');
    expect(profitSql).toContain('OFFSET 4 LIMIT 1');
    expect(payload.rows[0]?.symbol).toBe('600001');
    expect(payload.rows[0]?.recommendation_key).toBe('strategy-1:run-1:600001:2026-05-20T15:59:59.999Z');
    expect(payload.rows[0]?.return_status).toBe('NO_CURRENT_PRICE');
    expect(payload.rows[0]?.final_score).toBe(72.25);
    expect(payload.rows[0]?.score_breakdown).toEqual({ evidenceScore: 31, marketSignalScore: 12 });
    expect(payload.rows[0]?.reasons).toEqual(['命中半导体证据', '市场确认可用']);
    expect(payload.rows[0]?.horizons.live.status).toBe('NO_CURRENT_PRICE');
    expect(payload.rows[0]?.horizons.t1.status).toBe('PENDING');
  });

  it('returns separate profit rows for duplicate stocks across strategies and recommendation dates', async () => {
    const pool = {
      query: async () => ({
        rows: [
          {
            strategyId: 'strategy-a',
            strategyName: '策略A',
            strategyRunId: 'run-a-1',
            traceId: 'trace-a-1',
            clusterKey: 'global',
            asOf: '2026-05-20T15:59:59.999Z',
            rank: 1,
            symbol: '600001',
            stockName: '样本股票',
            industry: '半导体',
            baseTradingDay: '2026-05-20T00:00:00.000Z',
            basePrice: '10.0000',
            currentTradingDay: '2026-05-25T00:00:00.000Z',
            currentPrice: '11.0000',
            returnPct: '0.100000',
            returnStatus: 'LIVE',
            finalScore: '81.5000',
            scoreBreakdown: { evidenceScore: 30 },
            reasons: ['策略A首日推荐'],
          },
          {
            strategyId: 'strategy-a',
            strategyName: '策略A',
            strategyRunId: 'run-a-2',
            traceId: 'trace-a-2',
            clusterKey: 'global',
            asOf: '2026-05-22T15:59:59.999Z',
            rank: 1,
            symbol: '600001',
            stockName: '样本股票',
            industry: '半导体',
            baseTradingDay: '2026-05-22T00:00:00.000Z',
            basePrice: '10.0000',
            currentTradingDay: '2026-05-25T00:00:00.000Z',
            currentPrice: '9.5000',
            returnPct: '-0.050000',
            returnStatus: 'LIVE',
            finalScore: '77.2500',
            scoreBreakdown: { evidenceScore: 25 },
            reasons: ['策略A次日推荐'],
          },
          {
            strategyId: 'strategy-b',
            strategyName: '策略B',
            strategyRunId: 'run-b-1',
            traceId: 'trace-b-1',
            clusterKey: 'global',
            asOf: '2026-05-20T15:59:59.999Z',
            rank: 1,
            symbol: '600001',
            stockName: '样本股票',
            industry: '半导体',
            baseTradingDay: '2026-05-20T00:00:00.000Z',
            basePrice: '10.0000',
            currentTradingDay: '2026-05-25T00:00:00.000Z',
            currentPrice: '12.0000',
            returnPct: '0.200000',
            returnStatus: 'LIVE',
            finalScore: '88.0000',
            scoreBreakdown: { evidenceScore: 35 },
            reasons: ['策略B推荐'],
          },
        ],
      }),
    };
    const data = new RuntimeDataOperations({ options: { pgPool: pool } } as any);

    const payload = await data.getStrategyProfits('main', '2026-05-25');

    expect(payload.rows.map(row => `${row.symbol}-${row.strategy_name}-${row.as_of.slice(0, 10)}-${row.return_pct}`)).toEqual([
      '600001-策略A-2026-05-20-0.1',
      '600001-策略A-2026-05-22--0.05',
      '600001-策略B-2026-05-20-0.2',
    ]);
    expect(payload.rows.map(row => ({
      final_score: row.final_score,
      score_breakdown: row.score_breakdown,
      reasons: row.reasons,
    }))).toEqual([
      { final_score: 81.5, score_breakdown: { evidenceScore: 30 }, reasons: ['策略A首日推荐'] },
      { final_score: 77.25, score_breakdown: { evidenceScore: 25 }, reasons: ['策略A次日推荐'] },
      { final_score: 88, score_breakdown: { evidenceScore: 35 }, reasons: ['策略B推荐'] },
    ]);
    expect(payload.summaries.map(summary => ({
      strategy_id: summary.strategy_id,
      strategy_name: summary.strategy_name,
      run_count: summary.run_count,
      recommendation_count: summary.recommendation_count,
      avg_return_pct: summary.avg_return_pct,
      median_return_pct: summary.median_return_pct,
      win_rate: summary.win_rate,
      top_return_pct: summary.top_return_pct,
      worst_return_pct: summary.worst_return_pct,
      live: summary.horizon_summaries.live,
      t1: summary.horizon_summaries.t1,
    }))).toEqual([
      {
        strategy_id: 'strategy-b',
        strategy_name: '策略B',
        run_count: 1,
        recommendation_count: 1,
        avg_return_pct: 0.2,
        median_return_pct: 0.2,
        win_rate: 1,
        top_return_pct: 0.2,
        worst_return_pct: 0.2,
        live: { sample_count: 1, pending_count: 0, final_count: 1, avg_return_pct: 0.2, win_rate: 1, max_drawdown_pct: 0.2 },
        t1: { sample_count: 1, pending_count: 1, final_count: 0, avg_return_pct: null, win_rate: null, max_drawdown_pct: null },
      },
      {
        strategy_id: 'strategy-a',
        strategy_name: '策略A',
        run_count: 2,
        recommendation_count: 2,
        avg_return_pct: 0.025,
        median_return_pct: 0.025,
        win_rate: 0.5,
        top_return_pct: 0.1,
        worst_return_pct: -0.05,
        live: { sample_count: 2, pending_count: 0, final_count: 2, avg_return_pct: 0.025, win_rate: 0.5, max_drawdown_pct: -0.05 },
        t1: { sample_count: 2, pending_count: 2, final_count: 0, avg_return_pct: null, win_rate: null, max_drawdown_pct: null },
      },
    ]);
  });

  it('resolves English snapshot names to Chinese stock names from AKTools', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify([
      { code: '000695', name: '滨海能源' },
    ]), { status: 200 })) as typeof fetch;

    const pool = {
      query: async (sql: string) => {
        if (sql.includes('FROM "StrategyRecommendationEvent" e')) {
          return {
            rows: [{
              strategyId: 'strategy-1',
              strategyName: '策略一',
              strategyRunId: 'run-1',
              traceId: 'trace-1',
              clusterKey: 'global',
              asOf: '2026-06-01T15:59:59.999Z',
              rank: 1,
              symbol: '000695',
              stockName: 'Tianjin Binhai Energy & Development Co.,Ltd',
              industry: '电池',
              baseTradingDay: '2026-05-29T00:00:00.000Z',
              basePrice: '15.1400',
              currentTradingDay: '2026-05-29T00:00:00.000Z',
              currentPrice: '15.1400',
              finalScore: '14.1000',
              scoreBreakdown: {},
              reasons: ['命中电池证据'],
            }],
          };
        }
        if (sql.includes('FROM public."Stock"')) {
          return { rows: [{ symbol: '000695', stockName: 'Tianjin Binhai Energy & Development Co.,Ltd' }] };
        }
        if (sql.includes('FROM public."StockExposureFact"')) {
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    const data = new RuntimeDataOperations({ options: { pgPool: pool } } as any);

    try {
      const payload = await data.getStrategyProfits('main', '2026-06-01', 'trace-1');

      expect(payload.rows[0]?.stock_name).toBe('滨海能源');
    }
    finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('deduplicates dashboard recommendations by symbol using the newest execution', async () => {
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('FROM public."RecommendationSnapshot" r')) {
          return {
            rows: [
              {
                traceId: 'trace-old',
                asOf: '2026-06-01T15:59:59.999Z',
                rank: 1,
                symbol: '000695',
                stockName: '滨海能源',
                industry: '电池',
                finalScore: '10.0000',
                reasons: ['旧运行推荐'],
                scoreBreakdown: {},
                latestClose: '15.0000',
                latestTradingDay: '2026-05-29',
                evidenceCount: 2,
                l1EvidenceCount: 2,
                avgMatchConfidence: '0.8600',
                totalContribution: '0.2000',
                strategyId: null,
              },
              {
                traceId: 'trace-new',
                asOf: '2026-06-01T15:59:59.999Z',
                rank: 1,
                symbol: '000695',
                stockName: '滨海能源',
                industry: '电池',
                finalScore: '14.1000',
                reasons: ['新运行推荐'],
                scoreBreakdown: {},
                latestClose: '15.1400',
                latestTradingDay: '2026-05-29',
                evidenceCount: 2,
                l1EvidenceCount: 2,
                avgMatchConfidence: '0.8600',
                totalContribution: '0.2900',
                strategyId: null,
              },
              {
                traceId: 'trace-new',
                asOf: '2026-06-01T15:59:59.999Z',
                rank: 2,
                symbol: '002580',
                stockName: '圣阳股份',
                industry: '电池',
                finalScore: '13.6000',
                reasons: ['新运行第二名'],
                scoreBreakdown: {},
                latestClose: '24.2800',
                latestTradingDay: '2026-05-29',
                evidenceCount: 2,
                l1EvidenceCount: 2,
                avgMatchConfidence: '0.8600',
                totalContribution: '0.2900',
                strategyId: null,
              },
            ],
          };
        }
        if (sql.includes('FROM public."RunTrace" rt')) {
          return {
            rows: [
              {
                traceId: 'trace-new',
                clusterKey: 'global',
                status: 'SUCCESS',
                triggeredAt: '2026-06-01T01:57:00.000Z',
                completedAt: '2026-06-01T01:58:00.000Z',
                asOf: '2026-06-01T15:59:59.999Z',
                errorMessage: null,
                stepName: 'strategy_experiment',
                stepStatus: 'SUCCESS',
                stepErrorMessage: null,
              },
              {
                traceId: 'trace-old',
                clusterKey: 'global',
                status: 'SUCCESS',
                triggeredAt: '2026-06-01T01:55:00.000Z',
                completedAt: '2026-06-01T01:56:00.000Z',
                asOf: '2026-06-01T15:59:59.999Z',
                errorMessage: null,
                stepName: 'strategy_experiment',
                stepStatus: 'SUCCESS',
                stepErrorMessage: null,
              },
            ],
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    const data = new RuntimeDataOperations({ options: { pgPool: pool } } as any);

    const payload = await data.getDashboardSnapshot('2026-06-01', 'main');

    expect(payload.recommendations.map(row => `${row.symbol}:${row.trace_id}:${row.total_score}`)).toEqual([
      '000695:trace-new:14.1',
      '002580:trace-new:13.6',
    ]);
    expect(payload.default_symbol).toBe('000695');
    expect(payload.quality.recommendation_count).toBe(2);
  });

  it('builds stock detail without recalculating the full dashboard snapshot', async () => {
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM public."RecommendationSnapshot" r')) {
          return {
            rows: [{
              traceId: 'trace-detail-1',
              asOf: '2026-05-25T09:00:00.000Z',
              rank: 1,
              symbol: '600001',
              stockName: '样本股票',
              industry: '半导体',
              finalScore: '81.6000',
              reasons: ['半导体需求改善'],
              scoreBreakdown: {
                evidenceScore: 44.8,
                graphScore: 12,
                exposurePrecisionScore: 10.8,
                marketSignalScore: 14,
              },
              evidenceCount: 1,
              l1EvidenceCount: 1,
              avgMatchConfidence: '0.9000',
              totalContribution: '1.2000',
              latestTradingDay: '2026-05-25',
              latestClose: '10.0000',
              strategyId: null,
            }],
          };
        }
        if (sql.includes('FROM public."MarketSignalSnapshot"')) {
          return {
            rows: [{
              latestTradingDay: '2026-05-25',
              momentum5dPct: '0.0300',
              momentum20dPct: '0.0800',
              volumeRatio20d: '1.2000',
              breakout20d: true,
              volatilityCompression: false,
              recentWeekGainExceeded: false,
              reasons: ['放量突破'],
            }],
          };
        }
        if (sql.includes('SELECT DISTINCT ON (s.symbol)')) {
          return {
            rows: [{
              symbol: '600001',
              tradingDay: '2026-05-25T00:00:00.000Z',
              close: '10.0000',
              low: '9.8000',
              high: '10.2000',
              capturedAt: '2026-05-25T09:00:00.000Z',
            }],
          };
        }
        if (sql.includes('FROM public."EvidenceContribution" e')) {
          return {
            rows: [{
              chainId: 'chain-1',
              newsId: 'news-1',
              symbol: '600001',
              stockName: '样本股票',
              industry: '半导体',
              keyword: '半导体',
              sourceKeyword: '半导体',
              matchedExposureKeyword: '半导体设备',
              exposureFactId: 'fact-1',
              matchMethod: 'akshare_board_member',
              matchConfidence: '0.9000',
              baseFrequencyScore: '1.0000',
              timeDecayedScore: '0.9500',
              reprintPenaltyScore: '0.9000',
              finalContribScore: '0.8500',
              reasons: ['半导体映射到半导体设备'],
              newsTitle: '半导体设备需求改善',
              newsContent: '半导体设备订单改善',
              newsSource: 'source',
              newsUrl: '',
              newsPublishedAt: '2026-05-25T01:00:00.000Z',
              exposureType: 'industry_exposure',
              taxonomyLevel: 'eastmoney_industry',
              exposureSource: 'akshare_industry_board_em',
              exposureSourceId: '半导体设备',
              exposureSourceName: '半导体设备',
              exposureEvidenceJson: {
                provider: 'aktools',
                requestUrl: 'http://aktools.local/api/public/stock_board_industry_cons_em?symbol=x',
                confidenceReason: 'AKShare 东方财富行业板块成份包含样本股票',
              },
              exposureConfidence: '0.8200',
              exposureValidFrom: '2026-05-25T00:00:00.000Z',
              exposureUpdatedAt: '2026-05-25T00:00:00.000Z',
            }],
          };
        }
        if (sql.includes('FROM public."RunTrace"')) {
          return {
            rows: [{
              status: 'SUCCESS',
              triggeredAt: '2026-05-25T08:50:00.000Z',
              completedAt: '2026-05-25T09:00:00.000Z',
            }],
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    const data = new RuntimeDataOperations({ options: { pgPool: pool } } as any);

    const detail = await data.getDashboardStockDetail('600001', 'trace-detail-1', 'main');

    expect(detail.ui_summary.system_health.pipeline_health_label).toBe('已完成');
    expect(detail.live_quote).toEqual({
      price: 10,
      day_low: 9.8,
      day_high: 10.2,
      market_time: '2026-05-25T09:00:00.000Z',
      source: 'candle_fallback',
      status: 'FALLBACK',
    });
    expect(queries.some(sql => sql.includes('AND (r."asOf" + interval'))).toBe(false);
  });

  it('reads strategy performance reports ordered by asOf DESC and formatted as numbers', async () => {
    let lastSql = '';
    const pool = {
      query: async (sql: string) => {
        lastSql = sql;
        if (sql.includes('FROM public."StrategyPerformanceReport"')) {
          return {
            rows: [
              {
                id: 'report-1',
                strategyId: 'strategy-a',
                strategyNameSnapshot: '策略A快照',
                clusterKey: 'global',
                asOf: '2026-05-25T15:59:59.999Z',
                winRate: '0.7500',
                profitRatio: '2.5000',
                avgReturnPct: '0.038200',
                maxDrawdown: '-0.012300',
                recommendationCount: 8,
                createdAt: '2026-05-25T16:00:00.000Z',
              },
              {
                id: 'report-2',
                strategyId: 'strategy-a',
                strategyNameSnapshot: '策略A快照',
                clusterKey: 'global',
                asOf: '2026-05-20T15:59:59.999Z',
                winRate: '0.5000',
                profitRatio: '1.2000',
                avgReturnPct: '0.015000',
                maxDrawdown: '-0.008000',
                recommendationCount: 6,
                createdAt: '2026-05-20T16:00:00.000Z',
              },
            ],
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    const data = new RuntimeDataOperations({ options: { pgPool: pool } } as any);

    const rows = await data.getStrategyPerformanceReports('main', undefined, 10);

    expect(lastSql).toContain('FROM public."StrategyPerformanceReport"');
    expect(lastSql).toContain('WHERE "clusterKey" = $1');
    expect(lastSql).toContain('ORDER BY "asOf" DESC');
    expect(lastSql).toContain('LIMIT $2');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.strategy_id).toBe('strategy-a');
    expect(rows[0]?.win_rate).toBe(0.75);
    expect(rows[0]?.profit_ratio).toBe(2.5);
    expect(rows[0]?.avg_return_pct).toBeCloseTo(0.0382, 4);
    expect(rows[0]?.max_drawdown).toBeCloseTo(-0.0123, 4);
    expect(rows[0]?.recommendation_count).toBe(8);
    expect(rows[1]?.win_rate).toBe(0.5);
  });

  it('filters strategy performance reports by strategyId when provided', async () => {
    let lastSql = '';
    let lastParams: unknown[] | undefined;
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        lastSql = sql;
        lastParams = params;
        if (sql.includes('FROM public."StrategyPerformanceReport"')) {
          return {
            rows: [{
              id: 'report-3',
              strategyId: 'strategy-b',
              strategyNameSnapshot: '策略B快照',
              clusterKey: 'global',
              asOf: '2026-05-22T15:59:59.999Z',
              winRate: null,
              profitRatio: null,
              avgReturnPct: null,
              maxDrawdown: null,
              recommendationCount: 0,
              createdAt: '2026-05-22T16:00:00.000Z',
            }],
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    const data = new RuntimeDataOperations({ options: { pgPool: pool } } as any);

    const rows = await data.getStrategyPerformanceReports('main', 'strategy-b', 20);

    expect(lastSql).toContain('AND "strategyId" = $2');
    expect(lastParams).toEqual(['global', 'strategy-b', 20]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.strategy_id).toBe('strategy-b');
    expect(rows[0]?.win_rate).toBeNull();
    expect(rows[0]?.profit_ratio).toBeNull();
  });

  it('sorts dashboard network edges after collecting all candidates', async () => {
    const data = new RuntimeDataOperations({ options: {} } as any);
    const evidenceItems = [0.1, 0.2, 0.95, 0.3].map((confidence, index) => ({
      chain_id: `chain-${index}`,
      news: {
        news_id: `news-${index}`,
        title: `新闻 ${index}`,
        source: 'source',
        published_at: '2026-05-25T00:00:00.000Z',
        url: '',
        excerpt: '',
        anchor_quote: '',
      },
      signal: {
        source_keyword: `关键词${index}`,
        asset_or_theme_keyword: `主题${index}`,
        match_method: '暴露映射',
        match_confidence: confidence,
        signal_reason: `信号${index}`,
      },
      exposure: {
        matched_exposure_keyword: `暴露${index}`,
        exposure_fact_id: `fact-${index}`,
        exposure_type: 'industry_exposure',
        exposure_label: `暴露${index}`,
        exposure_reason: `理由${index}`,
        external_fact: {
          source: 'akshare_industry_board_em',
          source_id: `board-${index}`,
          source_name: `行业${index}`,
          source_provider: 'aktools',
          source_url: 'http://aktools.local/api/public/stock_board_industry_cons_em',
          observed_at: '2026-05-25T00:00:00.000Z',
          confidence,
          evidence_text: `行业${index} 成份包含样本股票`,
          verification_status: 'verified_external' as const,
          verification_label: '外部事实已核验',
        },
      },
      stock_link: {
        symbol: '600001',
        stock_name: '样本股票',
        link_reason: `命中${index}`,
        industry: `行业${index}`,
        concept_tags: [],
      },
      score: {
        base_frequency_score: 1,
        time_decayed_score: 1,
        reprint_penalty_score: 1,
        final_contrib_score: 0.2,
      },
    }));

    data.getDashboardStockEvidence = async () => ({
      trace_id: 'trace-network-1',
      group_id: 'main',
      symbol: '600001',
      stock_name: '样本股票',
      stats: {
        effective_count: evidenceItems.length,
        total_count: evidenceItems.length,
        coverage: 1,
        average_confidence: 0.4,
        total_contribution: 1,
      },
      items: evidenceItems,
    });

    const network = await data.getDashboardStockNetwork('600001', 'trace-network-1', 'main');

    expect(network.edges).toHaveLength(4);
    expect(network.edges[0]?.confidence).toBe(0.95);
    expect(network.edges.map(edge => edge.confidence)).toEqual([...network.edges.map(edge => edge.confidence)].sort((a, b) => b - a));
  });
});
