import { describe, expect, it } from 'vitest';

import {
  createServiceCompositionRoot,
  createServiceCli,
  NewsIngestFailureCategory,
  type INewsIngestResult,
  type IStockSyncResult,
  StockSyncFailureCategory,
} from '../../../src/index.js';

const createExecutionContext = (scopeKey: string, cluster = 'override-cluster') => {
  return {
    runtime: {
      cluster,
      asOf: undefined,
      timeWindow: undefined,
    },
    idempotency: {
      scopeKey,
      replaySafe: true,
      deduplicationKey: scopeKey,
    },
  } as const;
};

class OverrideNewsService {
  public readonly requests: unknown[] = [];

  public execute(request: unknown): Promise<INewsIngestResult> {
    this.requests.push(request);
    return Promise.resolve({
      status: 'failure',
      summary: {
        executionContext: createExecutionContext('override-news-scope'),
        cluster: 'override-cluster',
        query: 'override-query',
        fetchedCount: 0,
        normalizedCount: 0,
        deduplicatedCount: 0,
        persistedCount: 0,
        persistedIds: [],
        stageReports: [],
        failure: {
          category: NewsIngestFailureCategory.SourceFailed,
          message: 'override-news-service',
        },
      },
    });
  }
}

class OverrideStockService {
  public readonly requests: unknown[] = [];

  public execute(request: unknown): Promise<IStockSyncResult> {
    this.requests.push(request);
    return Promise.resolve({
      status: 'failure',
      summary: {
        executionContext: createExecutionContext('override-stock-scope'),
        cluster: 'override-cluster',
        requestedSymbol: 'override-symbol',
        fetchedCount: 0,
        mappedCount: 0,
        persistedCount: 0,
        persistedStockIds: [],
        decisions: {
          created: [],
          updated: [],
          skipped: [],
        },
        stageReports: [],
        failure: {
          category: StockSyncFailureCategory.SourceFailed,
          message: 'override-stock-service',
        },
      },
    });
  }
}

describe('service composition root', () => {
  it('exposes default production-style wiring from the public barrel', async () => {
    const root = createServiceCompositionRoot();

    const newsResult = await root.newsIngestService.execute({
      cluster: 'cluster-a',
      query: '银行',
      asOf: new Date('2026-03-17T10:00:00.000Z'),
      timeWindow: {
        start: new Date('2026-03-17T08:00:00.000Z'),
        end: new Date('2026-03-17T10:00:00.000Z'),
      },
      limit: 1,
    });
    const stockResult = await root.stockSyncService.execute({
      cluster: 'cluster-a',
      symbol: '600000.SH',
      stockId: 'stock-600000',
      stockName: '浦发银行',
      industry: '银行',
      asOf: new Date('2026-03-17T15:01:00.000Z'),
      timeWindow: {
        start: new Date('2026-03-13T09:30:00.000Z'),
        end: new Date('2026-03-17T15:00:00.000Z'),
      },
      limit: 1,
    });

    expect(newsResult.summary.cluster).toBe('cluster-a');
    expect(newsResult.summary.executionContext.runtime.cluster).toBe('cluster-a');
    expect(newsResult.summary.executionContext.idempotency.replaySafe).toBe(true);
    expect(newsResult.summary.stageReports.map((report) => report.stage)).toEqual([
      'fetch',
      'normalize',
      'deduplicate',
      'persist',
    ]);
    expect(stockResult.summary.cluster).toBe('cluster-a');
    expect(stockResult.summary.executionContext.runtime.cluster).toBe('cluster-a');
    expect(stockResult.summary.executionContext.idempotency.replaySafe).toBe(true);
    expect(stockResult.summary.stageReports.map((report) => report.stage)).toEqual([
      'fetch',
      'map-domain',
      'plan-sync',
      'persist',
    ]);
  });

  it('allows tests and other callers to replace wired services without touching CLI logic', async () => {
    const overrideNewsService = new OverrideNewsService();
    const overrideStockService = new OverrideStockService();
    const root = createServiceCompositionRoot({
      newsIngestService: overrideNewsService,
      stockSyncService: overrideStockService,
    });
    const cli = createServiceCli(root);

    const newsResult = await cli.run([
      'news-ingest',
      '--cluster',
      'cluster-test',
      '--query',
      '券商',
    ]);
    const stockResult = await cli.run([
      'stock-sync',
      '--cluster',
      'cluster-test',
      '--symbol',
      '601398.SH',
      '--stock-id',
      'stock-601398',
      '--stock-name',
      '工商银行',
      '--industry',
      '银行',
    ]);

    expect(overrideNewsService.requests).toEqual([
      {
        cluster: 'cluster-test',
        query: '券商',
        asOf: undefined,
        timeWindow: undefined,
        limit: undefined,
      },
    ]);
    expect(overrideStockService.requests).toEqual([
      {
        cluster: 'cluster-test',
        symbol: '601398.SH',
        stockId: 'stock-601398',
        stockName: '工商银行',
        industry: '银行',
        asOf: undefined,
        timeWindow: undefined,
        limit: undefined,
      },
    ]);
    expect(newsResult.status).toBe('failure');
    expect(stockResult.status).toBe('failure');
    expect(newsResult.output).toContain('override-news-service');
    expect(stockResult.output).toContain('override-stock-service');
  });
});
