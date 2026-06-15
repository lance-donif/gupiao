import { describe, expect, it } from 'vitest';

import {
  Candle,
  Keyword,
  NewsItem,
  Price,
  PrismaNewsRepository,
  PrismaStockRepository,
  PrismaUnitOfWork,
  Stock,
  Symbol,
  Timestamp,
  TradeDate,
  type IPrismaClient,
  type IPrismaNewsRecord,
  type IPrismaStockRecord,
  type IPrismaTransactionalClient,
} from '../../../../src/index.js';

const sortedTradingDays = (stock: Stock): string[] => {
  return stock.candles.map((candle) => candle.date.toString());
};

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
    createMany: ({ data }: { data: readonly IPrismaNewsRecord[] }): Promise<{ count: number }> => {
      let count = 0;
      for (const record of data) {
        this.newsRecords.set(record.id, record);
        count += 1;
      }
      return Promise.resolve({ count });
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

const createNewsItem = (id: string): NewsItem => {
  return new NewsItem(
    id,
    `${id}-title`,
    `${id}-content`,
    'unit-test',
    Timestamp.from('2026-03-16T09:30:00.000Z'),
  );
};

const createPersistedNewsRecord = (overrides: Partial<IPrismaNewsRecord> = {}): IPrismaNewsRecord => {
  return {
    id: 'persisted-news',
    title: 'persisted-title',
    content: 'persisted-content',
    source: 'unit-test',
    keywords: ['AI', '银行'],
    sourceRef: 'source-ref-1',
    publishedAt: new Date('2026-03-16T09:30:00.000Z'),
    capturedAt: new Date('2026-03-16T09:45:00.000Z'),
    clusterKey: 'cluster-a',
    runContextId: 'run-1',
    ...overrides,
  };
};

const createStock = (id: string, symbol: string): Stock => {
  return new Stock(
    id,
    Symbol.from(symbol),
    `${symbol}-name`,
    'finance',
    [
      new Candle(
        TradeDate.from('2026-03-16'),
        Price.from(10),
        Price.from(11),
        Price.from(9.5),
        Price.from(10.5),
        1000,
      ),
    ],
  );
};

const createPersistedStockRecord = (
  overrides: Partial<IPrismaStockRecord> = {},
): IPrismaStockRecord => {
  return {
    id: 'persisted-stock',
    symbol: '600123',
    name: '样本股票',
    industry: 'finance',
    exchange: 'SSE',
    clusterKey: 'cluster-a',
    runContextId: 'run-2',
    lastSyncedAt: new Date('2026-03-16T16:00:00.000Z'),
    latestTradeDay: new Date('2026-03-16T00:00:00.000Z'),
    candles: [
      {
        id: 'candle-1',
        tradingDay: new Date('2026-03-13T00:00:00.000Z'),
        open: 9,
        high: 10,
        low: 8.5,
        close: 9.5,
        volume: 900,
        capturedAt: new Date('2026-03-13T16:00:00.000Z'),
      },
      {
        id: 'candle-2',
        tradingDay: new Date('2026-03-16T00:00:00.000Z'),
        open: 10,
        high: 11,
        low: 9.8,
        close: 10.6,
        volume: 1200,
        capturedAt: new Date('2026-03-16T16:00:00.000Z'),
      },
    ],
    ...overrides,
  };
};

describe('repository pattern', () => {
  it('provides collection-like methods for news and stock repositories', async () => {
    const prisma = new InMemoryPrismaClient();
    const newsRepository = new PrismaNewsRepository(prisma);
    const stockRepository = new PrismaStockRepository(prisma);
    const newsItem = createNewsItem('news-1');
    const stock = createStock('stock-1', '600000');

    await newsRepository.add(newsItem);
    await stockRepository.add(stock);

    expect((await newsRepository.findById('news-1'))?.title).toBe('news-1-title');
    expect((await stockRepository.findById('stock-1'))?.symbol.toString()).toBe('600000');
    expect((await newsRepository.findAll()).map((item) => item.id)).toEqual(['news-1']);
    expect((await stockRepository.findAll()).map((item) => item.id)).toEqual(['stock-1']);

    await newsRepository.remove('news-1');
    await stockRepository.remove('stock-1');

    expect(await newsRepository.findById('news-1')).toBeNull();
    expect(await stockRepository.findById('stock-1')).toBeNull();
  });

  it('preserves publishedAt semantics and drops keywords that are not persisted by repository contract', async () => {
    const prisma = new InMemoryPrismaClient();
    const newsRepository = new PrismaNewsRepository(prisma);
    const newsItem = createNewsItem('news-keywords');

    newsItem.addKeyword(new Keyword('kw-1', 'AI', 'theme'));
    newsItem.addKeyword(new Keyword('kw-2', '银行', 'industry'));

    await newsRepository.add(newsItem);

    const reloaded = await newsRepository.findById('news-keywords');

    expect(reloaded?.publishedAt.toISOString()).toBe('2026-03-16T09:30:00.000Z');
    expect(reloaded?.keywords).toEqual([]);
  });

  it('accepts richer news schema fields while keeping repository round-trip boundary explicit', async () => {
    const prisma = new InMemoryPrismaClient();
    prisma.newsItem.create({
      data: createPersistedNewsRecord({ id: 'news-rich' }),
    });

    const reloaded = await new PrismaNewsRepository(prisma).findById('news-rich');

    expect(reloaded?.id).toBe('news-rich');
    expect(reloaded?.publishedAt.toISOString()).toBe('2026-03-16T09:30:00.000Z');
    expect(reloaded?.keywords).toEqual([]);
  });

  it('reconstitutes stock candles in ascending trading-day order from persisted records', async () => {
    const prisma = new InMemoryPrismaClient();
    const stockRepository = new PrismaStockRepository(prisma);

    await stockRepository.add(
      new Stock('stock-ordered', Symbol.from('600123'), '排序样本', 'finance', [
        new Candle(
          TradeDate.from('2026-03-17'),
          Price.from(11),
          Price.from(12),
          Price.from(10),
          Price.from(11.5),
          1200,
        ),
        new Candle(
          TradeDate.from('2026-03-13'),
          Price.from(9),
          Price.from(10),
          Price.from(8.5),
          Price.from(9.8),
          900,
        ),
        new Candle(
          TradeDate.from('2026-03-16'),
          Price.from(10),
          Price.from(11),
          Price.from(9.2),
          Price.from(10.6),
          1100,
        ),
      ]),
    );

    const reloaded = await stockRepository.findById('stock-ordered');

    expect(sortedTradingDays(reloaded as Stock)).toEqual([
      '2026-03-13',
      '2026-03-16',
      '2026-03-17',
    ]);
  });

  it('accepts richer stock schema fields while preserving candle relation semantics', async () => {
    const prisma = new InMemoryPrismaClient();
    prisma.stock.create({
      data: createPersistedStockRecord({ id: 'stock-rich' }),
    });

    const reloaded = await new PrismaStockRepository(prisma).findById('stock-rich');

    expect(reloaded?.symbol.toString()).toBe('600123');
    expect(sortedTradingDays(reloaded as Stock)).toEqual(['2026-03-13', '2026-03-16']);
  });

  it('writes repository defaults for schema-only persistence metadata fields', async () => {
    const prisma = new InMemoryPrismaClient();
    const newsRepository = new PrismaNewsRepository(prisma);
    const stockRepository = new PrismaStockRepository(prisma);

    await newsRepository.add(createNewsItem('news-defaults'));
    await stockRepository.add(createStock('stock-defaults', '600777'));

    const newsRecord = await prisma.newsItem.findUnique({ where: { id: 'news-defaults' } });
    const stockRecord = await prisma.stock.findUnique({ where: { id: 'stock-defaults' } });

    expect(newsRecord).toMatchObject({
      clusterKey: 'global',
      runContextId: null,
      sourceRef: null,
      keywords: [],
    });
    expect(newsRecord?.capturedAt.toISOString()).toBe('2026-03-16T09:30:00.000Z');

    expect(stockRecord).toMatchObject({
      clusterKey: 'global',
      exchange: null,
      runContextId: null,
    });
    expect(stockRecord?.lastSyncedAt?.toISOString()).toBe('2026-03-16T00:00:00.000Z');
    expect(stockRecord?.latestTradeDay?.toISOString()).toBe('2026-03-16T00:00:00.000Z');
    expect(stockRecord?.candles[0]).toMatchObject({
      tradingDay: new Date('2026-03-16T00:00:00.000Z'),
      capturedAt: new Date('2026-03-16T00:00:00.000Z'),
    });
  });

  it('commits all registered operations atomically', async () => {
    const prisma = new InMemoryPrismaClient();
    const unitOfWork = new PrismaUnitOfWork(prisma);

    unitOfWork.register(async ({ newsRepository }) => {
      await newsRepository.add(createNewsItem('news-atomic'));
    });
    unitOfWork.register(async ({ stockRepository }) => {
      await stockRepository.add(createStock('stock-atomic', '000001'));
    });

    await unitOfWork.commit();

    expect((await unitOfWork.newsRepository.findAll()).map((item) => item.id)).toEqual([
      'news-atomic',
    ]);
    expect((await unitOfWork.stockRepository.findAll()).map((item) => item.id)).toEqual([
      'stock-atomic',
    ]);
  });

  it('tracks direct repository writes until commit is called', async () => {
    const prisma = new InMemoryPrismaClient();
    const unitOfWork = new PrismaUnitOfWork(prisma);

    await unitOfWork.newsRepository.add(createNewsItem('news-deferred'));
    await unitOfWork.stockRepository.add(createStock('stock-deferred', '600001'));

    expect(await new PrismaNewsRepository(prisma).findById('news-deferred')).toBeNull();
    expect(await new PrismaStockRepository(prisma).findById('stock-deferred')).toBeNull();

    await unitOfWork.commit();

    expect((await new PrismaNewsRepository(prisma).findAll()).map((item) => item.id)).toEqual([
      'news-deferred',
    ]);
    expect((await new PrismaStockRepository(prisma).findAll()).map((item) => item.id)).toEqual([
      'stock-deferred',
    ]);
  });

  it('discards tracked direct repository writes on rollback', async () => {
    const prisma = new InMemoryPrismaClient();
    const unitOfWork = new PrismaUnitOfWork(prisma);

    await unitOfWork.newsRepository.add(createNewsItem('news-discarded'));
    await unitOfWork.stockRepository.add(createStock('stock-discarded', '600002'));

    await unitOfWork.rollback();

    await unitOfWork.commit();

    expect(await new PrismaNewsRepository(prisma).findById('news-discarded')).toBeNull();
    expect(await new PrismaStockRepository(prisma).findById('stock-discarded')).toBeNull();
  });

  it('rolls back all pending changes when one transactional operation fails', async () => {
    const prisma = new InMemoryPrismaClient();
    const unitOfWork = new PrismaUnitOfWork(prisma);

    unitOfWork.register(async ({ newsRepository }) => {
      await newsRepository.add(createNewsItem('news-rollback'));
    });
    unitOfWork.register(() => {
      throw new Error('forced transactional failure');
    });
    unitOfWork.register(async ({ stockRepository }) => {
      await stockRepository.add(createStock('stock-rollback', '300001'));
    });

    await expect(unitOfWork.commit()).rejects.toThrowError('forced transactional failure');
    expect(await unitOfWork.newsRepository.findAll()).toEqual([]);
    expect(await unitOfWork.stockRepository.findAll()).toEqual([]);
  });
});
