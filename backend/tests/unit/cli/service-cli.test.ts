import { describe, expect, it } from 'vitest';

import {
  NewsIngestFailureCategory,
  ServiceCli,
  StockSyncFailureCategory,
  createServiceCli,
  type INewsIngestResult,
  type IStockSyncResult,
} from '../../../src/index.js';

const createExecutionContext = (scopeKey: string, cluster = 'unused') => {
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

class RecordingNewsIngestService {
  public readonly requests: unknown[] = [];

  public constructor(private readonly result: INewsIngestResult) {}

  public execute(request: unknown): Promise<INewsIngestResult> {
    this.requests.push(request);
    return Promise.resolve(this.result);
  }
}

class RecordingStockSyncService {
  public readonly requests: unknown[] = [];

  public constructor(private readonly result: IStockSyncResult) {}

  public execute(request: unknown): Promise<IStockSyncResult> {
    this.requests.push(request);
    return Promise.resolve(this.result);
  }
}

describe('service-cli', () => {
  it('renders help without invoking any service', async () => {
    const newsService = new RecordingNewsIngestService({
      status: 'failure',
      summary: {
        executionContext: createExecutionContext('unused-news-scope'),
        cluster: 'unused',
        query: 'unused',
        fetchedCount: 0,
        normalizedCount: 0,
        deduplicatedCount: 0,
        persistedCount: 0,
        persistedIds: [],
        stageReports: [],
        failure: {
          category: NewsIngestFailureCategory.SourceFailed,
          message: 'unused',
        },
      },
    });
    const stockService = new RecordingStockSyncService({
      status: 'failure',
      summary: {
        executionContext: createExecutionContext('unused-stock-scope'),
        cluster: 'unused',
        requestedSymbol: 'unused',
        fetchedCount: 0,
        mappedCount: 0,
        persistedCount: 0,
        persistedStockIds: [],
        decisions: { created: [], updated: [], skipped: [] },
        stageReports: [],
        failure: {
          category: StockSyncFailureCategory.SourceFailed,
          message: 'unused',
        },
      },
    });

    const cli = new ServiceCli({
      newsIngestService: newsService,
      stockSyncService: stockService,
    });

    const result = await cli.run(['--help']);

    expect(result.status).toBe('success');
    expect(result.command).toBe('help');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('service-cli');
    expect(result.output).toContain('news-ingest');
    expect(result.output).toContain('stock-sync');
    expect(newsService.requests).toEqual([]);
    expect(stockService.requests).toEqual([]);
  });

  it('parses news-ingest arguments and reuses the injected service path', async () => {
    const newsService = new RecordingNewsIngestService({
      status: 'success',
      summary: {
        executionContext: {
          runtime: {
            cluster: 'cluster-a',
            asOf: new Date('2026-03-17T10:00:00.000Z'),
            timeWindow: {
              start: new Date('2026-03-17T08:00:00.000Z'),
              end: new Date('2026-03-17T10:00:00.000Z'),
            },
          },
          idempotency: {
            scopeKey: 'cluster-a::2026-03-17T10:00:00.000Z::2026-03-17T08:00:00.000Z..2026-03-17T10:00:00.000Z::news-ingest::银行',
            replaySafe: true,
            deduplicationKey: 'cluster-a::2026-03-17T10:00:00.000Z::2026-03-17T08:00:00.000Z..2026-03-17T10:00:00.000Z::news-ingest::银行',
          },
        },
        cluster: 'cluster-a',
        query: '银行',
        fetchedCount: 2,
        normalizedCount: 2,
        deduplicatedCount: 1,
        persistedCount: 1,
        persistedIds: ['news-1'],
        stageReports: [
          {
            stage: 'fetch',
            inputCount: 0,
            outputCount: 2,
            detail: 'fetched from stub',
          },
        ],
      },
    });

    const cli = new ServiceCli({
      newsIngestService: newsService,
      stockSyncService: new RecordingStockSyncService({
        status: 'failure',
        summary: {
          executionContext: createExecutionContext('unused-stock-scope'),
          cluster: 'unused',
          requestedSymbol: 'unused',
          fetchedCount: 0,
          mappedCount: 0,
          persistedCount: 0,
          persistedStockIds: [],
          decisions: { created: [], updated: [], skipped: [] },
          stageReports: [],
          failure: {
            category: StockSyncFailureCategory.SourceFailed,
            message: 'unused',
          },
        },
      }),
    });

    const result = await cli.run([
      'news-ingest',
      '--cluster',
      'cluster-a',
      '--query',
      '银行',
      '--as-of',
      '2026-03-17T10:00:00.000Z',
      '--window-start',
      '2026-03-17T08:00:00.000Z',
      '--window-end',
      '2026-03-17T10:00:00.000Z',
      '--limit',
      '5',
      '--dry-run',
    ]);

    expect(newsService.requests).toEqual([
      {
        cluster: 'cluster-a',
        query: '银行',
        asOf: new Date('2026-03-17T10:00:00.000Z'),
        timeWindow: {
          start: new Date('2026-03-17T08:00:00.000Z'),
          end: new Date('2026-03-17T10:00:00.000Z'),
        },
        limit: 5,
      },
    ]);
    expect(result.status).toBe('success');
    expect(result.command).toBe('news-ingest');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('"status": "success"');
    expect(result.output).toContain('"command": "news-ingest"');
    expect(result.output).toContain('"persistedCount": 1');
  });

  it('returns machine-readable failures for stock-sync execution', async () => {
    const stockService = new RecordingStockSyncService({
      status: 'failure',
      summary: {
        executionContext: {
          runtime: {
            cluster: 'cluster-b',
            asOf: new Date('2026-03-17T15:01:00.000Z'),
            timeWindow: {
              start: new Date('2026-03-13T09:30:00.000Z'),
              end: new Date('2026-03-17T15:00:00.000Z'),
            },
          },
          idempotency: {
            scopeKey: 'cluster-b::2026-03-17T15:01:00.000Z::2026-03-13T09:30:00.000Z..2026-03-17T15:00:00.000Z::stock-sync::600000.SH',
            replaySafe: true,
            deduplicationKey: 'cluster-b::2026-03-17T15:01:00.000Z::2026-03-13T09:30:00.000Z..2026-03-17T15:00:00.000Z::stock-sync::600000.SH',
          },
        },
        cluster: 'cluster-b',
        requestedSymbol: '600000.SH',
        fetchedCount: 0,
        mappedCount: 0,
        persistedCount: 0,
        persistedStockIds: [],
        decisions: { created: [], updated: [], skipped: [] },
        stageReports: [],
        failure: {
          category: StockSyncFailureCategory.PersistenceFailed,
          message: 'write failed',
        },
      },
    });

    const cli = createServiceCli({
      newsIngestService: new RecordingNewsIngestService({
        status: 'failure',
        summary: {
          executionContext: createExecutionContext('unused-news-scope'),
          cluster: 'unused',
          query: 'unused',
          fetchedCount: 0,
          normalizedCount: 0,
          deduplicatedCount: 0,
          persistedCount: 0,
          persistedIds: [],
          stageReports: [],
          failure: {
            category: NewsIngestFailureCategory.SourceFailed,
            message: 'unused',
          },
        },
      }),
      stockSyncService: stockService,
    });

    const result = await cli.run([
      'stock-sync',
      '--cluster',
      'cluster-b',
      '--symbol',
      '600000.SH',
      '--as-of',
      '2026-03-17T15:01:00.000Z',
      '--window-start',
      '2026-03-13T09:30:00.000Z',
      '--window-end',
      '2026-03-17T15:00:00.000Z',
      '--stock-id',
      'stock-600000',
      '--stock-name',
      '浦发银行',
      '--industry',
      '银行',
    ]);

    expect(stockService.requests).toEqual([
      {
        cluster: 'cluster-b',
        symbol: '600000.SH',
        stockId: 'stock-600000',
        stockName: '浦发银行',
        industry: '银行',
        asOf: new Date('2026-03-17T15:01:00.000Z'),
        timeWindow: {
          start: new Date('2026-03-13T09:30:00.000Z'),
          end: new Date('2026-03-17T15:00:00.000Z'),
        },
      },
    ]);
    expect(result.status).toBe('failure');
    expect(result.command).toBe('stock-sync');
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('"failureCategory": "persistence_failed"');
    expect(result.output).toContain('"status": "failure"');
  });
});
