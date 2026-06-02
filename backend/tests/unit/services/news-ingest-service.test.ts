import { describe, expect, it } from 'vitest';

import {
  NewsItem,
  PrismaUnitOfWork,
  SourceFailureCategory,
  type IServiceTimeWindow,
  type INewsSource,
  type INewsSourceArticle,
  type INewsSourceRequest,
  type INewsSourceResult,
  type IPrismaClient,
  type IPrismaNewsRecord,
  type IPrismaStockRecord,
  type IPrismaTransactionalClient,
  type IUnitOfWork,
  type IUnitOfWorkContext,
} from '../../../src/index.js';
import {
  NewsIngestFailureCategory,
  NewsIngestService,
  type INewsIngestExecutionRequest,
} from '../../../src/services/index.js';

class StubNewsSource implements INewsSource {
  public readonly kind = 'news';

  public readonly name = 'stub-news-source';

  public constructor(private readonly result: INewsSourceResult) {}

  public fetch(request: INewsSourceRequest): INewsSourceResult {
    void request;
    return this.result;
  }

  public isAvailable(): boolean {
    return true;
  }

  public getHealthStatus(): {
    readonly available: boolean;
    readonly checkedAt: Date;
    readonly detail: string;
  } {
    return {
      available: true,
      checkedAt: new Date('2026-03-17T08:00:00.000Z'),
      detail: 'ok',
    } as const;
  }
}

class InMemoryTransactionalClient implements IPrismaTransactionalClient {
  public constructor(
    private readonly newsRecords: Map<string, IPrismaNewsRecord>,
    private readonly stockRecords: Map<string, IPrismaStockRecord>,
  ) {}

  public readonly newsItem = {
    create: ({ data }: { data: IPrismaNewsRecord }): Promise<IPrismaNewsRecord> => {
      this.newsRecords.set(data.id, data);
      return Promise.resolve(data);
    },
    delete: ({ where }: { where: { id: string } }): Promise<IPrismaNewsRecord> => {
      const record = this.newsRecords.get(where.id);

      if (!record) {
        throw new Error(`NewsItem not found: ${where.id}`);
      }

      this.newsRecords.delete(where.id);
      return Promise.resolve(record);
    },
    findUnique: ({ where }: { where: { id: string } }): Promise<IPrismaNewsRecord | null> => {
      return Promise.resolve(this.newsRecords.get(where.id) ?? null);
    },
    findMany: (): Promise<readonly IPrismaNewsRecord[]> => {
      return Promise.resolve([...this.newsRecords.values()]);
    },
  };

  public readonly rawNewsRecord = {
    create: ({ data }: { data: any }): Promise<any> => Promise.resolve(data),
  };

  public readonly normalizedNewsRecord = {
    create: ({ data }: { data: any }): Promise<any> => Promise.resolve(data),
  };

  public readonly stock = {
    create: ({ data }: { data: IPrismaStockRecord }): Promise<IPrismaStockRecord> => {
      this.stockRecords.set(data.id, data);
      return Promise.resolve(data);
    },
    delete: ({ where }: { where: { id: string } }): Promise<IPrismaStockRecord> => {
      const record = this.stockRecords.get(where.id);

      if (!record) {
        throw new Error(`Stock not found: ${where.id}`);
      }

      this.stockRecords.delete(where.id);
      return Promise.resolve(record);
    },
    findUnique: ({ where }: { where: { id: string } }): Promise<IPrismaStockRecord | null> => {
      return Promise.resolve(this.stockRecords.get(where.id) ?? null);
    },
    findMany: (): Promise<readonly IPrismaStockRecord[]> => {
      return Promise.resolve([...this.stockRecords.values()]);
    },
  };}

class InMemoryPrismaClient implements IPrismaClient {
  private readonly newsRecords = new Map<string, IPrismaNewsRecord>();

  private readonly stockRecords = new Map<string, IPrismaStockRecord>();

  private readonly baseClient = new InMemoryTransactionalClient(this.newsRecords, this.stockRecords);

  public readonly newsItem = this.baseClient.newsItem;

  public readonly rawNewsRecord = this.baseClient.rawNewsRecord;

  public readonly normalizedNewsRecord = this.baseClient.normalizedNewsRecord;

  public readonly stock = this.baseClient.stock;
  public async $transaction<T>(
    callback: (transaction: IPrismaTransactionalClient) => Promise<T>,
  ): Promise<T> {
    const newsSnapshot = new Map(this.newsRecords);
    const stockSnapshot = new Map(this.stockRecords);
    const transactionClient = new InMemoryTransactionalClient(newsSnapshot, stockSnapshot);

    const result = await callback(transactionClient);

    this.newsRecords.clear();
    this.stockRecords.clear();

    for (const [key, value] of newsSnapshot.entries()) {
      this.newsRecords.set(key, value);
    }

    for (const [key, value] of stockSnapshot.entries()) {
      this.stockRecords.set(key, value);
    }

    return result;
  }
}

class FailingUnitOfWork implements IUnitOfWork {
  public readonly newsRepository;

  public readonly stockRepository;

  private readonly pendingOperations: Array<(context: IUnitOfWorkContext) => Promise<void>> = [];

  public constructor(private readonly base: IUnitOfWork) {
    this.newsRepository = {
      add: (item: NewsItem): Promise<void> => {
        this.register(async ({ newsRepository }) => {
          await newsRepository.add(item);
        });

        return Promise.resolve();
      },
      addRawRecord: (record: any): Promise<void> => {
        this.register(async ({ newsRepository }) => {
          await newsRepository.addRawRecord(record);
        });
        return Promise.resolve();
      },
      addNormalizedRecord: (record: any): Promise<void> => {
        this.register(async ({ newsRepository }) => {
          await newsRepository.addNormalizedRecord(record);
        });
        return Promise.resolve();
      },
      remove: (id: string): Promise<void> => this.base.newsRepository.remove(id),
      findById: (id: string): Promise<NewsItem | null> => this.base.newsRepository.findById(id),
      findAll: (): Promise<readonly NewsItem[]> => this.base.newsRepository.findAll(),
    };

    this.stockRepository = base.stockRepository;
  }

  public register(operation: (context: IUnitOfWorkContext) => Promise<void>): void {
    this.pendingOperations.push(operation);
  }

  public async commit(): Promise<void> {
    for (const operation of this.pendingOperations) {
      await operation({
        newsRepository: this.base.newsRepository,
        stockRepository: this.base.stockRepository,
      });
    }

    this.pendingOperations.splice(0, this.pendingOperations.length);
    throw new Error('forced persistence failure');
  }

  public rollback(): Promise<void> {
    this.pendingOperations.splice(0, this.pendingOperations.length);
    return Promise.resolve();
  }
}

const createArticle = (
  overrides: Partial<INewsSourceArticle> & Pick<INewsSourceArticle, 'title' | 'summary' | 'url'>,
): INewsSourceArticle => {
  const overrideMetadata = overrides.metadata;
  const provider = overrideMetadata?.provider ?? 'stub-news-source';
  const requestId = overrideMetadata?.requestId ?? 'req-1';
  const providerIdentity = overrideMetadata?.providerIdentity ?? 'stub-news-source';
  const recordId = (overrideMetadata as Record<string, unknown> | undefined)?.['recordId'] ?? overrides.url;

  return {
    title: overrides.title,
    summary: overrides.summary,
    url: overrides.url,
    publishedAt: overrides.publishedAt ?? new Date('2026-03-17T09:00:00.000Z'),
    capturedAt: overrides.capturedAt ?? new Date('2026-03-17T09:05:00.000Z'),
    metadata: {
      provider,
      requestId,
      providerIdentity,
      recordId,
      ...overrideMetadata,
    },
  };
};

const createSuccessSourceResult = (items: readonly INewsSourceArticle[]): INewsSourceResult => {
  return {
    status: 'success',
    kind: 'news',
    request: {
      query: '银行',
      limit: 10,
      asOf: new Date('2026-03-17T10:00:00.000Z'),
      timeWindow: {
        start: new Date('2026-03-17T08:00:00.000Z'),
        end: new Date('2026-03-17T10:00:00.000Z'),
      },
    },
    items,
    metadata: {
      requestId: 'req-1',
      providerIdentity: 'stub-news-source',
      queryRef: '银行',
    },
  };
};

const createExecutionRequest = (): INewsIngestExecutionRequest => {
  return {
    cluster: 'cluster-a',
    query: '银行',
    asOf: new Date('2026-03-17T10:00:00.000Z'),
    timeWindow: {
      start: new Date('2026-03-17T08:00:00.000Z'),
      end: new Date('2026-03-17T10:00:00.000Z'),
    },
    limit: 10,
  };
};

describe('news-ingest-service', () => {
  it('propagates explicit runtime context and persists only items inside the backtest window', async () => {
    const prisma = new InMemoryPrismaClient();
    const observedRequests: INewsSourceRequest[] = [];
    const timeWindow: IServiceTimeWindow = {
      start: new Date('2026-03-17T08:00:00.000Z'),
      end: new Date('2026-03-17T10:00:00.000Z'),
    };
    const asOf = new Date('2026-03-17T10:00:00.000Z');

    class RecordingNewsSource extends StubNewsSource {
      public override fetch(request: INewsSourceRequest): INewsSourceResult {
        observedRequests.push(request);
        return super.fetch(request);
      }
    }

    const service = new NewsIngestService({
      source: new RecordingNewsSource(createSuccessSourceResult([
        createArticle({
          title: '窗口内新闻',
          summary: '这条新闻发生在允许的回测窗口内',
          url: 'https://example.com/news-in-window',
          publishedAt: new Date('2026-03-17T09:30:00.000Z'),
        }),
        createArticle({
          title: '未来新闻',
          summary: '这条新闻晚于 asOf，不应被持久化',
          url: 'https://example.com/news-future',
          publishedAt: new Date('2026-03-17T10:30:00.000Z'),
        }),
      ])),
      unitOfWork: new PrismaUnitOfWork(prisma),
    });

    const result = await service.execute({
      ...createExecutionRequest(),
      cluster: 'cluster-backtest',
      asOf,
      timeWindow,
    });

    expect(observedRequests).toEqual([
      {
        query: '银行',
        asOf,
        timeWindow,
        limit: 10,
      },
    ]);
    expect(result.status).toBe('success');
    expect(result.summary.cluster).toBe('cluster-backtest');
    expect(result.summary.deduplicatedCount).toBe(1);
    expect(result.summary.persistedCount).toBe(1);
    expect(result.summary.stageReports).toEqual([
      expect.objectContaining({ stage: 'fetch', outputCount: 2 }),
      expect.objectContaining({ stage: 'normalize', outputCount: 2 }),
      expect.objectContaining({ stage: 'deduplicate', outputCount: 1, detail: expect.stringContaining('drop-future-window-items') }),
      expect.objectContaining({ stage: 'persist', outputCount: 1 }),
    ]);

    const persisted = await new PrismaUnitOfWork(prisma).newsRepository.findAll();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.title).toBe('窗口内新闻');
  });

  it('treats repeated ingest runs for the same cluster/query/window as idempotent at the persistence boundary', async () => {
    const prisma = new InMemoryPrismaClient();
    const service = new NewsIngestService({
      source: new StubNewsSource(createSuccessSourceResult([
        createArticle({
          title: '银行板块异动',
          summary: '多家银行股早盘上涨',
          url: 'https://example.com/news-1',
          metadata: {
            provider: 'stub-news-source',
            requestId: 'req-1',
            providerIdentity: 'stub-news-source',
            recordId: 'stable-news-1',
          },
        }),
      ])),
      unitOfWork: new PrismaUnitOfWork(prisma),
    });

    const firstRun = await service.execute(createExecutionRequest());
    const secondRun = await service.execute(createExecutionRequest());

    expect(firstRun.status).toBe('success');
    expect(secondRun.status).toBe('success');
    expect(secondRun.summary.persistedCount).toBe(0);
    expect(secondRun.summary.persistedIds).toEqual([]);
    expect(secondRun.summary.stageReports).toEqual([
      expect.objectContaining({ stage: 'fetch', outputCount: 1 }),
      expect.objectContaining({ stage: 'normalize', outputCount: 1 }),
      expect.objectContaining({ stage: 'deduplicate', inputCount: 1, outputCount: 0, detail: expect.stringContaining('drop-already-persisted-items') }),
      expect.objectContaining({ stage: 'persist', inputCount: 0, outputCount: 0, detail: 'idempotent replay skipped persistence' }),
    ]);

    const persisted = await new PrismaUnitOfWork(prisma).newsRepository.findAll();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.id).toBe('stable-news-1');
  });

  it('orchestrates fetch, normalize/deduplicate, and persistence into observable stages', async () => {
    const prisma = new InMemoryPrismaClient();
    const service = new NewsIngestService({
      source: new StubNewsSource(createSuccessSourceResult([
        createArticle({
          title: '  银行板块  异动  ',
          summary: '  多家 银行股   早盘上涨  ',
          url: 'https://example.com/news-1',
          metadata: {
            provider: 'stub-news-source',
            requestId: 'req-1',
            providerIdentity: 'stub-news-source',
            recordId: 'same-1',
          },
        }),
        createArticle({
          title: '银行板块异动',
          summary: '多家银行股早盘上涨',
          url: 'https://example.com/news-1',
          metadata: {
            provider: 'stub-news-source',
            requestId: 'req-1',
            providerIdentity: 'stub-news-source',
            recordId: 'same-1',
          },
        }),
        createArticle({
          title: '券商板块拉升',
          summary: '券商股午后继续活跃',
          url: 'https://example.com/news-2',
          metadata: {
            provider: 'stub-news-source',
            requestId: 'req-1',
            providerIdentity: 'stub-news-source',
            recordId: 'unique-2',
          },
        }),
      ])),
      unitOfWork: new PrismaUnitOfWork(prisma),
    });

    const result = await service.execute(createExecutionRequest());

    expect(result.status).toBe('success');
    expect(result.summary.fetchedCount).toBe(3);
    expect(result.summary.normalizedCount).toBe(3);
    expect(result.summary.deduplicatedCount).toBe(2);
    expect(result.summary.persistedCount).toBe(2);
    expect(result.summary.persistedIds).toHaveLength(2);
    expect(result.summary.stageReports.map((report) => report.stage)).toEqual([
      'fetch',
      'normalize',
      'deduplicate',
      'persist',
    ]);
    expect(result.summary.stageReports).toEqual([
      expect.objectContaining({ stage: 'fetch', inputCount: 0, outputCount: 3 }),
      expect.objectContaining({ stage: 'normalize', inputCount: 3, outputCount: 3 }),
      expect.objectContaining({ stage: 'deduplicate', inputCount: 3, outputCount: 2 }),
      expect.objectContaining({ stage: 'persist', inputCount: 2, outputCount: 2 }),
    ]);

    const persisted = await new PrismaUnitOfWork(prisma).newsRepository.findAll();
    expect(persisted).toHaveLength(2);
    expect(persisted[0]?.title).toBe('银行板块 异动');
    expect(persisted[0]?.content).toBe('多家 银行股 早盘上涨');
    expect(persisted[1]?.title).toBe('券商板块拉升');
  });

  it('fails without partial writes when persistence stage errors', async () => {
    const prisma = new InMemoryPrismaClient();
    const baseUnitOfWork = new PrismaUnitOfWork(prisma);
    const service = new NewsIngestService({
      source: new StubNewsSource(createSuccessSourceResult([
        createArticle({
          title: '银行板块异动',
          summary: '多家银行股早盘上涨',
          url: 'https://example.com/news-1',
        }),
        createArticle({
          title: '券商板块拉升',
          summary: '券商股午后继续活跃',
          url: 'https://example.com/news-2',
        }),
      ])),
      unitOfWork: new FailingUnitOfWork(baseUnitOfWork),
    });

    const result = await service.execute(createExecutionRequest());

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      throw new Error('Expected failure result');
    }

    expect(result.summary.failure.category).toBe(NewsIngestFailureCategory.PersistenceFailed);
    expect(result.summary.persistedCount).toBe(0);
    expect(result.summary.stageReports).toEqual([
      expect.objectContaining({ stage: 'fetch', outputCount: 2 }),
      expect.objectContaining({ stage: 'normalize', outputCount: 2 }),
      expect.objectContaining({ stage: 'deduplicate', outputCount: 2 }),
      expect.objectContaining({ stage: 'persist', outputCount: 0, detail: 'forced persistence failure' }),
    ]);

    const persisted = await baseUnitOfWork.newsRepository.findAll();
    expect(persisted).toEqual([]);
  });

  it('maps source failures into machine-readable ingest failures before persistence', async () => {
    const service = new NewsIngestService({
      source: new StubNewsSource({
        status: 'failure',
        kind: 'news',
        request: {
          query: '银行',
        },
        failure: {
          category: SourceFailureCategory.Unavailable,
          message: 'provider unavailable',
          metadata: {
            requestId: 'req-failure',
            providerIdentity: 'stub-news-source',
          },
        },
        metadata: {
          requestId: 'req-failure',
          providerIdentity: 'stub-news-source',
        },
      }),
      unitOfWork: new PrismaUnitOfWork(new InMemoryPrismaClient()),
    });

    const result = await service.execute(createExecutionRequest());

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      throw new Error('Expected failure result');
    }

    expect(result.summary.failure.category).toBe(NewsIngestFailureCategory.SourceFailed);
    expect(result.summary.failure.sourceCategory).toBe(SourceFailureCategory.Unavailable);
    expect(result.summary.stageReports).toEqual([
      expect.objectContaining({ stage: 'fetch', inputCount: 0, outputCount: 0, detail: 'provider unavailable' }),
    ]);
  });
});
