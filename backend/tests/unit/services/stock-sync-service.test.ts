import { describe, expect, it } from 'vitest';

import {
  Candle,
  Price,
  PrismaUnitOfWork,
  SourceFailureCategory,
  Stock,
  StockSyncFailureCategory,
  StockSyncService,
  Symbol,
  TradeDate,
  type IPrismaClient,
  type IPrismaNewsRecord,
  type IPrismaStockRecord,
  type IPrismaTransactionalClient,
  type IStockSource,
  type IStockSourceQuote,
  type IStockSourceRequest,
  type IStockSourceResult,
  type IUnitOfWork,
  type IUnitOfWorkContext,
} from '../../../src/index.js';
import type { ISourceProviderHealthStatus } from '../../../src/sources/contracts.js';
import type { IStockSyncExecutionRequest } from '../../../src/services/index.js';

class StubStockSource implements IStockSource {
  public readonly kind = 'stock';

  public readonly name = 'stub-stock-source';

  public constructor(private readonly result: IStockSourceResult) {}

  public fetch(request: IStockSourceRequest): IStockSourceResult {
    void request;
    return this.result;
  }

  public isAvailable(): boolean {
    return true;
  }

  public getHealthStatus(): ISourceProviderHealthStatus {
    return {
      available: true,
      checkedAt: new Date('2026-03-17T15:05:00.000Z'),
      detail: 'ok',
    };
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
  public readonly normalizedNewsRecord = null as any;}

class InMemoryPrismaClient implements IPrismaClient {
  private readonly newsRecords = new Map<string, IPrismaNewsRecord>();

  private readonly stockRecords = new Map<string, IPrismaStockRecord>();

  private readonly baseClient = new InMemoryTransactionalClient(this.newsRecords, this.stockRecords);

  public readonly newsItem = this.baseClient.newsItem;

  public readonly stock = this.baseClient.stock;

  public readonly rawNewsRecord = null as any;
  public readonly normalizedNewsRecord = null as any;
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

class FailingStockUnitOfWork implements IUnitOfWork {
  public readonly newsRepository;

  public readonly stockRepository;

  private readonly pendingOperations: Array<(context: IUnitOfWorkContext) => Promise<void>> = [];

  public constructor(private readonly base: IUnitOfWork) {
    this.newsRepository = base.newsRepository;
    this.stockRepository = {
      add: (stock: Stock): Promise<void> => {
        this.register(async ({ stockRepository }) => {
          await stockRepository.add(stock);
        });

        return Promise.resolve();
      },
      remove: (id: string): Promise<void> => this.base.stockRepository.remove(id),
      findById: (id: string): Promise<Stock | null> => this.base.stockRepository.findById(id),
      findAll: (): Promise<readonly Stock[]> => this.base.stockRepository.findAll(),
    };
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
    throw new Error('forced stock persistence failure');
  }

  public rollback(): Promise<void> {
    this.pendingOperations.splice(0, this.pendingOperations.length);
    return Promise.resolve();
  }
}

const createQuote = (
  overrides: Partial<IStockSourceQuote> & Pick<IStockSourceQuote, 'symbol' | 'price'>,
): IStockSourceQuote => {
  return {
    symbol: overrides.symbol,
    price: overrides.price,
    currency: overrides.currency ?? 'CNY',
    marketTime: overrides.marketTime ?? new Date('2026-03-17T15:00:00.000Z'),
    capturedAt: overrides.capturedAt ?? new Date('2026-03-17T15:00:01.000Z'),
    metadata: {
      provider: 'stub-stock-source',
      requestId: 'req-stock-1',
      providerIdentity: 'stub-stock-source',
      symbolRef: overrides.symbol,
      ...(overrides.metadata ?? {}),
    },
  };
};

const createSuccessResult = (items: readonly IStockSourceQuote[]): IStockSourceResult => {
  return {
    status: 'success',
    kind: 'stock',
    request: {
      symbol: '600000.SH',
      limit: 5,
      asOf: new Date('2026-03-17T15:01:00.000Z'),
      timeWindow: {
        start: new Date('2026-03-13T09:30:00.000Z'),
        end: new Date('2026-03-17T15:00:00.000Z'),
      },
    },
    items,
    metadata: {
      requestId: 'req-stock-1',
      providerIdentity: 'stub-stock-source',
      symbolRef: '600000.SH',
    },
  };
};

const createExecutionRequest = (): IStockSyncExecutionRequest => {
  return {
    cluster: 'cluster-a',
    symbol: '600000.SH',
    stockId: 'stock-600000',
    stockName: '浦发银行',
    industry: '银行',
    limit: 5,
  };
};

const createStock = (id: string, symbol: string, candles: readonly Candle[]): Stock => {
  return new Stock(id, Symbol.from(symbol), '浦发银行', '银行', candles);
};

const createCandle = (date: string, close: number): Candle => {
  return new Candle(
    TradeDate.from(date),
    Price.from(close),
    Price.from(close + 0.5),
    Price.from(close - 0.5),
    Price.from(close),
    0,
  );
};

describe('stock-sync-service', () => {
  it('propagates runtime context and skips quotes beyond the explicit backtest boundary', async () => {
    const prisma = new InMemoryPrismaClient();
    const observedRequests: IStockSourceRequest[] = [];

    class RecordingStockSource extends StubStockSource {
      public override fetch(request: IStockSourceRequest): IStockSourceResult {
        observedRequests.push(request);
        return super.fetch(request);
      }
    }

    const asOf = new Date('2026-03-17T15:01:00.000Z');
    const timeWindow = {
      start: new Date('2026-03-13T09:30:00.000Z'),
      end: new Date('2026-03-17T15:00:00.000Z'),
    };
    const service = new StockSyncService({
      source: new RecordingStockSource(createSuccessResult([
        createQuote({ symbol: '600000.SH', price: 12.2, marketTime: new Date('2026-03-17T15:00:00.000Z') }),
        createQuote({ symbol: '600000.SH', price: 12.4, marketTime: new Date('2026-03-18T15:00:00.000Z') }),
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
        symbol: '600000.SH',
        asOf,
        timeWindow,
        limit: 5,
      },
    ]);
    expect(result.status).toBe('success');
    expect(result.summary.cluster).toBe('cluster-backtest');
    expect(result.summary.fetchedCount).toBe(2);
    expect(result.summary.mappedCount).toBe(1);
    expect(result.summary.decisions.created).toHaveLength(1);
    expect(result.summary.decisions.created[0]).toMatchObject({
      candleTradeDay: '2026-03-17',
      reason: 'missing stock in repository',
    });
    expect(result.summary.stageReports).toEqual([
      expect.objectContaining({ stage: 'fetch', outputCount: 2 }),
      expect.objectContaining({ stage: 'map-domain', outputCount: 1, detail: expect.stringContaining('drop-future-window-quotes') }),
      expect.objectContaining({ stage: 'plan-sync', outputCount: 1 }),
      expect.objectContaining({ stage: 'persist', outputCount: 1 }),
    ]);

    const persisted = await new PrismaUnitOfWork(prisma).stockRepository.findAll();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.candles.map((candle) => candle.date.toString())).toEqual(['2026-03-17']);
  });

  it('treats repeated sync runs for the same cluster/symbol/window as idempotent', async () => {
    const prisma = new InMemoryPrismaClient();
    const service = new StockSyncService({
      source: new StubStockSource(createSuccessResult([
        createQuote({ symbol: '600000.SH', price: 12.2, marketTime: new Date('2026-03-17T15:00:00.000Z') }),
      ])),
      unitOfWork: new PrismaUnitOfWork(prisma),
    });

    const firstRun = await service.execute(createExecutionRequest());
    const secondRun = await service.execute(createExecutionRequest());

    expect(firstRun.status).toBe('success');
    expect(secondRun.status).toBe('success');
    expect(secondRun.summary.persistedCount).toBe(0);
    expect(secondRun.summary.persistedStockIds).toEqual([]);
    expect(secondRun.summary.decisions.created).toEqual([]);
    expect(secondRun.summary.decisions.updated).toEqual([]);
    expect(secondRun.summary.decisions.skipped).toHaveLength(1);
    expect(secondRun.summary.stageReports).toEqual([
      expect.objectContaining({ stage: 'fetch', outputCount: 1 }),
      expect.objectContaining({ stage: 'map-domain', outputCount: 1 }),
      expect.objectContaining({ stage: 'plan-sync', outputCount: 0, detail: expect.stringContaining('created=0, updated=0, skipped=1') }),
      expect.objectContaining({ stage: 'persist', inputCount: 0, outputCount: 0, detail: 'idempotent replay skipped persistence' }),
    ]);

    const persisted = await new PrismaUnitOfWork(prisma).stockRepository.findAll();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.candles.map((candle) => candle.date.toString())).toEqual(['2026-03-17']);
  });

  it('maps source quotes into stock domain objects and reports created/updated/skipped decisions', async () => {
    const prisma = new InMemoryPrismaClient();
    const seedUnitOfWork = new PrismaUnitOfWork(prisma);

    await seedUnitOfWork.stockRepository.add(createStock('stock-600000', '600000', [
      createCandle('2026-03-13', 12.1),
      createCandle('2026-03-17', 12.2),
    ]));
    await seedUnitOfWork.commit();

    const service = new StockSyncService({
      source: new StubStockSource(createSuccessResult([
        createQuote({ symbol: '600000.SH', price: 12.2, marketTime: new Date('2026-03-17T15:00:00.000Z') }),
        createQuote({ symbol: '600000.SH', price: 12.4, marketTime: new Date('2026-03-18T15:00:00.000Z') }),
        createQuote({ symbol: '601398.SH', price: 7.1, marketTime: new Date('2026-03-18T15:00:00.000Z') }),
      ])),
      unitOfWork: new PrismaUnitOfWork(prisma),
    });

    const result = await service.execute(createExecutionRequest());
    if (result.status !== 'success') {
      throw new Error('Expected success result');
    }
    expect(result.summary.executionContext.runtime.cluster).toBe('cluster-a');
    expect(result.summary.executionContext.idempotency.replaySafe).toBe(true);
    expect(result.summary.decisions).toEqual({
      created: [
        expect.objectContaining({
          stockId: 'stock-601398',
        }),
      ],
      updated: [
        expect.objectContaining({
          stockId: 'stock-600000',
          candleTradeDay: '2026-03-18',
        }),
      ],
      skipped: [
        expect.objectContaining({
          stockId: 'stock-600000',
          candleTradeDay: '2026-03-17',
        }),
      ],
    });

    expect(result.status).toBe('success');
    expect(result.summary.fetchedCount).toBe(3);
    expect(result.summary.decisions.created).toHaveLength(1);
    expect(result.summary.decisions.updated).toHaveLength(1);
    expect(result.summary.decisions.skipped).toHaveLength(1);
    expect(result.summary.decisions.created[0]).toMatchObject({
      stockId: 'stock-601398',
      symbol: '601398',
      reason: 'missing stock in repository',
      candleTradeDay: '2026-03-18',
    });
    expect(result.summary.decisions.updated[0]).toMatchObject({
      stockId: 'stock-600000',
      symbol: '600000',
      reason: 'new candle trade day detected',
      candleTradeDay: '2026-03-18',
    });
    expect(result.summary.decisions.skipped[0]).toMatchObject({
      stockId: 'stock-600000',
      symbol: '600000',
      reason: 'trade day already synchronized',
      candleTradeDay: '2026-03-17',
    });
    expect(result.summary.stageReports.map((report) => report.stage)).toEqual([
      'fetch',
      'map-domain',
      'plan-sync',
      'persist',
    ]);
    expect([...result.summary.persistedStockIds].sort()).toEqual(['stock-600000', 'stock-601398']);

    const stocks = await new PrismaUnitOfWork(prisma).stockRepository.findAll();
    expect(stocks.map((stock) => stock.id).sort()).toEqual(['stock-600000', 'stock-601398']);

    const reloadedExisting = await new PrismaUnitOfWork(prisma).stockRepository.findById('stock-600000');
    expect(reloadedExisting?.candles.map((candle) => candle.date.toString())).toEqual([
      '2026-03-13',
      '2026-03-17',
      '2026-03-18',
    ]);

    const createdStock = await new PrismaUnitOfWork(prisma).stockRepository.findById('stock-601398');
    expect(createdStock?.symbol.toString()).toBe('601398');
    expect(createdStock?.candles.map((candle) => candle.close.valueOf())).toEqual([7.1]);
  });

  it('returns a machine-readable failure when source fetching fails', async () => {
    const service = new StockSyncService({
      source: new StubStockSource({
        status: 'failure',
        kind: 'stock',
        request: {
          symbol: '600000.SH',
        },
        failure: {
          category: SourceFailureCategory.Unavailable,
          message: 'market source unavailable',
          metadata: {
            requestId: 'req-stock-failure',
            providerIdentity: 'stub-stock-source',
            symbolRef: '600000.SH',
          },
        },
        metadata: {
          requestId: 'req-stock-failure',
          providerIdentity: 'stub-stock-source',
          symbolRef: '600000.SH',
        },
      }),
      unitOfWork: new PrismaUnitOfWork(new InMemoryPrismaClient()),
    });

    const result = await service.execute(createExecutionRequest());

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      throw new Error('Expected failure result');
    }

    expect(result.summary.failure.category).toBe(StockSyncFailureCategory.SourceFailed);
    expect(result.summary.failure.sourceCategory).toBe(SourceFailureCategory.Unavailable);
    expect(result.summary.stageReports).toEqual([
      expect.objectContaining({ stage: 'fetch', inputCount: 0, outputCount: 0, detail: 'market source unavailable' }),
    ]);
  });

  it('does not leave partial writes when persistence fails after planning sync decisions', async () => {
    const prisma = new InMemoryPrismaClient();
    const baseUnitOfWork = new PrismaUnitOfWork(prisma);
    const service = new StockSyncService({
      source: new StubStockSource(createSuccessResult([
        createQuote({ symbol: '600000.SH', price: 12.4, marketTime: new Date('2026-03-18T15:00:00.000Z') }),
      ])),
      unitOfWork: new FailingStockUnitOfWork(baseUnitOfWork),
    });

    const result = await service.execute(createExecutionRequest());

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      throw new Error('Expected failure result');
    }

    expect(result.summary.failure.category).toBe(StockSyncFailureCategory.PersistenceFailed);
    expect(result.summary.stageReports).toEqual([
      expect.objectContaining({ stage: 'fetch', outputCount: 1 }),
      expect.objectContaining({ stage: 'map-domain', outputCount: 1 }),
      expect.objectContaining({ stage: 'plan-sync', outputCount: 1 }),
      expect.objectContaining({ stage: 'persist', outputCount: 0, detail: 'forced stock persistence failure' }),
    ]);

    const persistedStocks = await baseUnitOfWork.stockRepository.findAll();
    expect(persistedStocks).toEqual([]);
  });
});
