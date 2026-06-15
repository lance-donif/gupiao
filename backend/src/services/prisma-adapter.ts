import type {
  IPrismaCandleRecord,
  IPrismaClient,
  IPrismaNewsDelegate,
  IPrismaNewsRecord,
  IPrismaStockDelegate,
  IPrismaStockRecord,
  IPrismaTransactionalClient,
} from '../repositories/prisma-types.js';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '@prisma/client';

interface IPrismaClientLike {
  readonly newsItem: {
    create: (args: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
    delete: (args: { where: { id: string } }) => Promise<Record<string, unknown>>;
    findUnique: (args: { where: { id: string } }) => Promise<Record<string, unknown> | null>;
    findMany: () => Promise<readonly Record<string, unknown>[]>;
  };
  readonly stock: {
    create: (args: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
    delete: (args: { where: { id: string } }) => Promise<Record<string, unknown>>;
    findUnique: (args: { where: { id: string } }) => Promise<Record<string, unknown> | null>;
    findMany: () => Promise<readonly Record<string, unknown>[]>;
  };
}

const isDate = (value: unknown): value is Date => {
  return value instanceof Date && !Number.isNaN(value.getTime());
};

const toDate = (value: unknown, field: string): Date => {
  if (!isDate(value)) {
    throw new Error(`Expected Date for ${field}`);
  }

  return value;
};

const toOptionalDate = (value: unknown): Date | null => {
  if (value == null) {
    return null;
  }

  return toDate(value, 'optionalDate');
};

const toStringValue = (value: unknown, field: string): string => {
  if (typeof value !== 'string') {
    throw new Error(`Expected string for ${field}`);
  }

  return value;
};

const toOptionalString = (value: unknown): string | null => {
  if (value == null) {
    return null;
  }

  return toStringValue(value, 'optionalString');
};

const toNumberValue = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Expected number for ${field}`);
  }

  return value;
};

const toBigIntValue = (value: unknown, field: string): bigint => {
  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number' && Number.isInteger(value)) {
    return BigInt(value);
  }

  throw new Error(`Expected bigint-compatible value for ${field}`);
};

const normalizeCandleRecord = (record: Record<string, unknown>): IPrismaCandleRecord => {
  return {
    id: typeof record.id === 'string' ? record.id : undefined,
    tradingDay: toDate(record.tradingDay, 'candle.tradingDay'),
    open: toNumberValue(record.open, 'candle.open'),
    high: toNumberValue(record.high, 'candle.high'),
    low: toNumberValue(record.low, 'candle.low'),
    close: toNumberValue(record.close, 'candle.close'),
    volume: Number(toBigIntValue(record.volume, 'candle.volume')),
    capturedAt: toDate(record.capturedAt, 'candle.capturedAt'),
  };
};

const normalizeNewsRecord = (record: Record<string, unknown>): IPrismaNewsRecord => {
  return {
    id: toStringValue(record.id, 'news.id'),
    title: toStringValue(record.title, 'news.title'),
    content: toStringValue(record.content, 'news.content'),
    source: toStringValue(record.source, 'news.source'),
    keywords: Array.isArray(record.keywords)
      ? record.keywords.filter((keyword): keyword is string => typeof keyword === 'string')
      : undefined,
    sourceRef: toOptionalString(record.sourceRef),
    publishedAt: toDate(record.publishedAt, 'news.publishedAt'),
    capturedAt: toDate(record.capturedAt, 'news.capturedAt'),
    clusterKey: toStringValue(record.clusterKey, 'news.clusterKey'),
    runContextId: toOptionalString(record.runContextId),
  };
};

const normalizeStockRecord = (record: Record<string, unknown>): IPrismaStockRecord => {
  const candles = Array.isArray(record.candles)
    ? record.candles.map(candle => normalizeCandleRecord(candle as Record<string, unknown>))
    : [];

  return {
    id: toStringValue(record.id, 'stock.id'),
    symbol: toStringValue(record.symbol, 'stock.symbol'),
    name: toStringValue(record.name, 'stock.name'),
    industry: toStringValue(record.industry, 'stock.industry'),
    exchange: toOptionalString(record.exchange),
    clusterKey: toStringValue(record.clusterKey, 'stock.clusterKey'),
    runContextId: toOptionalString(record.runContextId),
    lastSyncedAt: toOptionalDate(record.lastSyncedAt),
    latestTradeDay: toOptionalDate(record.latestTradeDay),
    candles,
  };
};

const toPrismaNewsCreateInput = (record: IPrismaNewsRecord): Record<string, unknown> => {
  return {
    id: record.id,
    title: record.title,
    content: record.content,
    source: record.source,
    sourceRef: record.sourceRef ?? null,
    publishedAt: record.publishedAt,
    capturedAt: record.capturedAt,
    clusterKey: record.clusterKey,
    runContextId: record.runContextId ?? null,
  };
};

const toPrismaStockCreateInput = (record: IPrismaStockRecord): Record<string, unknown> => {
  return {
    id: record.id,
    symbol: record.symbol,
    name: record.name,
    industry: record.industry,
    exchange: record.exchange ?? null,
    clusterKey: record.clusterKey,
    runContextId: record.runContextId ?? null,
    lastSyncedAt: record.lastSyncedAt ?? null,
    latestTradeDay: record.latestTradeDay ?? null,
    candles: {
      create: record.candles.map(candle => ({
        tradingDay: candle.tradingDay,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: BigInt(candle.volume),
        capturedAt: candle.capturedAt,
      })),
    },
  };
};

class PrismaNewsDelegateAdapter implements IPrismaNewsDelegate {
  public constructor(private readonly delegate: IPrismaClientLike['newsItem']) {}

  public async create(args: { data: IPrismaNewsRecord }): Promise<IPrismaNewsRecord> {
    const created = await this.delegate.create({
      data: toPrismaNewsCreateInput(args.data),
    });

    return normalizeNewsRecord(created);
  }

  public async createMany(args: { data: readonly IPrismaNewsRecord[] }): Promise<{ count: number }> {
    // 透传到底层 Prisma delegate；批量写入不需要逐条规范化返回值
    const result = await (this.delegate as unknown as {
      createMany: (args: { data: readonly Record<string, unknown>[] }) => Promise<{ count: number }>;
    }).createMany({
      data: args.data.map(toPrismaNewsCreateInput),
    });
    return result;
  }

  public async delete(args: { where: { id: string } }): Promise<IPrismaNewsRecord> {
    const deleted = await this.delegate.delete(args);
    return normalizeNewsRecord(deleted);
  }

  public async findUnique(args: { where: { id: string } }): Promise<IPrismaNewsRecord | null> {
    const found = await this.delegate.findUnique(args);
    return found ? normalizeNewsRecord(found) : null;
  }

  public async findMany(): Promise<readonly IPrismaNewsRecord[]> {
    const found = await this.delegate.findMany();
    return found.map(normalizeNewsRecord);
  }
}

class PrismaStockDelegateAdapter implements IPrismaStockDelegate {
  public constructor(private readonly delegate: IPrismaClientLike['stock']) {}

  public async create(args: { data: IPrismaStockRecord }): Promise<IPrismaStockRecord> {
    const created = await this.delegate.create({
      data: toPrismaStockCreateInput(args.data),
    });

    return normalizeStockRecord(created);
  }

  public async delete(args: { where: { id: string } }): Promise<IPrismaStockRecord> {
    const deleted = await this.delegate.delete(args);
    return normalizeStockRecord(deleted);
  }

  public async findUnique(args: { where: { id: string } }): Promise<IPrismaStockRecord | null> {
    const found = await this.delegate.findUnique(args);
    return found ? normalizeStockRecord(found) : null;
  }

  public async findMany(): Promise<readonly IPrismaStockRecord[]> {
    const found = await this.delegate.findMany();
    return found.map(normalizeStockRecord);
  }
}

class PrismaTransactionalClientAdapter implements IPrismaTransactionalClient {
  public readonly newsItem: IPrismaNewsDelegate;

  public readonly stock: IPrismaStockDelegate;

  public readonly rawNewsRecord: any;

  public readonly normalizedNewsRecord: any;

  public constructor(client: any) {
    this.newsItem = new PrismaNewsDelegateAdapter(client.newsItem);
    this.stock = new PrismaStockDelegateAdapter(client.stock);
    this.rawNewsRecord = client.rawNewsRecord;
    this.normalizedNewsRecord = client.normalizedNewsRecord;
  }
}

export class PrismaClientAdapter extends PrismaTransactionalClientAdapter implements IPrismaClient {
  public constructor(private readonly prisma: PrismaClient) {
    super(prisma as unknown as IPrismaClientLike);
  }

  public async $transaction<T>(
    callback: (transaction: IPrismaTransactionalClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (transactionClient) => {
      const adaptedClient = new PrismaTransactionalClientAdapter(transactionClient as unknown as IPrismaClientLike);
      return callback(adaptedClient);
    });
  }

  public $connect(): Promise<void> {
    return this.prisma.$connect();
  }

  public $disconnect(): Promise<void> {
    return this.prisma.$disconnect();
  }
}

export const createPrismaClientAdapter = (databaseUrl: string): PrismaClientAdapter => {
  process.env.DATABASE_URL = databaseUrl;
  const adapter = new PrismaPg({ connectionString: databaseUrl });

  return new PrismaClientAdapter(new PrismaClient({
    adapter,
  }));
};
