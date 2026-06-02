import type { IPrismaClient, IPrismaNewsRecord, IPrismaStockRecord, IPrismaTransactionalClient } from '../repositories/index.js';
import type { INewsSourceRequest, IProviderNewsResponse, IProviderRequestMetadata, IProviderStockResponse, ISourceProvider, ISourceProviderDependencies, ISourceProviderHealthStatus, IStockSourceRequest } from '../sources/index.js';
import type { INewsIngestExecutionRequest, INewsIngestResult } from './news-ingest-types.js';

import type { IStockSyncExecutionRequest, IStockSyncResult } from './stock-sync-types.js';
import { PrismaUnitOfWork } from '../repositories/unit-of-work.js';
import {
  createSourceRegistryFactory,
  FixedWindowRateLimiter,

} from '../sources/index.js';

import { NewsIngestService } from './news-ingest-service.js';
import { StockSyncService } from './stock-sync-service.js';

export interface INewsIngestServiceLike {
  execute: (request: INewsIngestExecutionRequest) => Promise<INewsIngestResult>;
}

export interface IStockSyncServiceLike {
  execute: (request: IStockSyncExecutionRequest) => Promise<IStockSyncResult>;
}

export interface IServiceCompositionRoot {
  readonly newsIngestService: INewsIngestServiceLike;
  readonly stockSyncService: IStockSyncServiceLike;
}

export interface IServiceCompositionOverrides {
  readonly newsIngestService?: INewsIngestServiceLike;
  readonly stockSyncService?: IStockSyncServiceLike;
  readonly prismaClient?: IPrismaClient;
  readonly sourceProviderDependencies?: ISourceProviderDependencies;
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
  };

  public readonly rawNewsRecord = null as any;
  public readonly normalizedNewsRecord = null as any;
}

class InMemoryPrismaClient implements IPrismaClient {
  private readonly newsRecords = new Map<string, IPrismaNewsRecord>();

  private readonly stockRecords = new Map<string, IPrismaStockRecord>();

  private readonly baseClient = new InMemoryTransactionalClient(this.newsRecords, this.stockRecords);

  public readonly newsItem = this.baseClient.newsItem;

  public readonly stock = this.baseClient.stock;

  public readonly rawNewsRecord = this.baseClient.rawNewsRecord;
  public readonly normalizedNewsRecord = this.baseClient.normalizedNewsRecord;

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

class StubNewsProvider implements ISourceProvider<INewsSourceRequest, IProviderNewsResponse> {
  public readonly name = 'stub-tavily-news-provider';

  public execute(request: INewsSourceRequest, _metadata: IProviderRequestMetadata): IProviderNewsResponse {
    return {
      status: 'success',
      payload: {
        kind: 'news',
        items: [
          {
            id: `${request.query}-headline-1`,
            title: `${request.query} 新闻摘要`,
            summary: `${request.query} 相关资讯`,
            url: `https://stub.example/news/${encodeURIComponent(request.query)}`,
            publishedAt: '2026-03-17T09:00:00.000Z',
            capturedAt: '2026-03-17T09:05:00.000Z',
          },
        ],
      },
      metadata: {
        requestId: `news-${request.query}`,
        providerIdentity: this.name,
        queryRef: request.query,
      },
    };
  }

  public isAvailable(): boolean {
    return true;
  }

  public getHealthStatus(): ISourceProviderHealthStatus {
    return {
      available: true,
      checkedAt: new Date('2026-03-17T09:05:00.000Z'),
      detail: 'stub-ready',
    };
  }
}

class StubStockProvider implements ISourceProvider<IStockSourceRequest, IProviderStockResponse> {
  public constructor(private readonly providerName: string) {}

  public get name(): string {
    return this.providerName;
  }

  public execute(request: IStockSourceRequest, _metadata: IProviderRequestMetadata): IProviderStockResponse {
    return {
      status: 'success',
      payload: {
        kind: 'stock',
        items: [
          {
            symbol: request.symbol,
            price: 10.5,
            currency: 'CNY',
            marketTime: '2026-03-17T15:00:00.000Z',
            capturedAt: '2026-03-17T15:00:01.000Z',
          },
        ],
      },
      metadata: {
        requestId: `stock-${request.symbol}`,
        providerIdentity: this.name,
        symbolRef: request.symbol,
      },
    };
  }

  public isAvailable(): boolean {
    return true;
  }

  public getHealthStatus(): ISourceProviderHealthStatus {
    return {
      available: true,
      checkedAt: new Date('2026-03-17T15:00:01.000Z'),
      detail: 'stub-ready',
    };
  }
}

export const createDefaultPrismaClient = (): IPrismaClient => {
  return new InMemoryPrismaClient();
};

export const createDefaultSourceProviderDependencies = (): ISourceProviderDependencies => {
  return {
    rateLimiter: new FixedWindowRateLimiter({
      maxRequests: 10,
      windowMs: 1_000,
    }),
    tavilyNewsProvider: new StubNewsProvider(),
    yahooMarketProvider: new StubStockProvider('stub-yahoo-market-provider'),
    akshareMarketProvider: new StubStockProvider('stub-akshare-market-provider'),
  };
};

const createDefaultNewsIngestService = (
  prismaClient: IPrismaClient,
  sourceProviderDependencies: ISourceProviderDependencies,
): INewsIngestServiceLike => {
  const unitOfWork = new PrismaUnitOfWork(prismaClient);
  const registryFactory = createSourceRegistryFactory(sourceProviderDependencies);
  const source = registryFactory.create('tavily-news');

  return new NewsIngestService({
    source,
    unitOfWork,
  });
};

const createDefaultStockSyncService = (
  prismaClient: IPrismaClient,
  sourceProviderDependencies: ISourceProviderDependencies,
): IStockSyncServiceLike => {
  const unitOfWork = new PrismaUnitOfWork(prismaClient);
  const registryFactory = createSourceRegistryFactory(sourceProviderDependencies);
  const source = registryFactory.create('yahoo-market');

  return new StockSyncService({
    source,
    unitOfWork,
  });
};

export const createServiceCompositionRoot = (
  overrides: IServiceCompositionOverrides = {},
): IServiceCompositionRoot => {
  const prismaClient = overrides.prismaClient ?? createDefaultPrismaClient();
  const sourceProviderDependencies = overrides.sourceProviderDependencies ?? createDefaultSourceProviderDependencies();

  return {
    newsIngestService: overrides.newsIngestService ?? createDefaultNewsIngestService(prismaClient, sourceProviderDependencies),
    stockSyncService: overrides.stockSyncService ?? createDefaultStockSyncService(prismaClient, sourceProviderDependencies),
  };
};
