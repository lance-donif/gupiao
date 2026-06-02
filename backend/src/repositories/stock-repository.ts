import type { IStockRepository } from './interfaces/i-stock-repository.js';
import type {
  IPrismaCandleRecord,
  IPrismaStockRecord,
  IPrismaTransactionalClient,
} from './prisma-types.js';
import { Candle, Stock } from '../types/entities/stock.js';
import { Price } from '../types/value-objects/price.js';

import { Symbol } from '../types/value-objects/symbol.js';
import { TradeDate } from '../types/value-objects/trade-date.js';

const DEFAULT_STOCK_CLUSTER_KEY = 'global';

const resolveLatestTradeDay = (record: IPrismaStockRecord): Date | null => {
  if (record.latestTradeDay) {
    return record.latestTradeDay;
  }

  return record.candles.at(-1)?.tradingDay ?? null;
};

const mapCandleRecordToEntity = (record: IPrismaCandleRecord): Candle => {
  return new Candle(
    TradeDate.from(record.tradingDay),
    Price.from(record.open),
    Price.from(record.high),
    Price.from(record.low),
    Price.from(record.close),
    record.volume,
  );
};

const mapStockRecordToEntity = (record: IPrismaStockRecord): Stock => {
  void record.clusterKey;
  void record.runContextId;
  void record.exchange;
  void record.lastSyncedAt;
  void resolveLatestTradeDay(record);

  return new Stock(
    record.id,
    Symbol.from(record.symbol),
    record.name,
    record.industry,
    record.candles.map(mapCandleRecordToEntity),
  );
};

const mapCandleToRecord = (candle: Candle): IPrismaCandleRecord => {
  return {
    tradingDay: candle.date.toDate(),
    open: candle.open.valueOf(),
    high: candle.high.valueOf(),
    low: candle.low.valueOf(),
    close: candle.close.valueOf(),
    volume: candle.volume,
    capturedAt: candle.date.toDate(),
  };
};

const mapStockToRecord = (stock: Stock): IPrismaStockRecord => {
  const latestTradeDay = stock.candles.at(-1)?.date.toDate() ?? null;

  return {
    id: stock.id,
    symbol: stock.symbol.toString(),
    name: stock.name,
    industry: stock.industry,
    exchange: null,
    clusterKey: DEFAULT_STOCK_CLUSTER_KEY,
    runContextId: null,
    lastSyncedAt: latestTradeDay,
    latestTradeDay,
    candles: stock.candles.map(mapCandleToRecord),
  };
};

export class PrismaStockRepository implements IStockRepository {
  public constructor(private readonly prisma: Pick<IPrismaTransactionalClient, 'stock'>) {}

  public async add(stock: Stock): Promise<void> {
    await this.prisma.stock.create({
      data: mapStockToRecord(stock),
    });
  }

  public async remove(id: string): Promise<void> {
    await this.prisma.stock.delete({
      where: { id },
    });
  }

  public async findById(id: string): Promise<Stock | null> {
    const record = await this.prisma.stock.findUnique({
      where: { id },
    });

    return record ? mapStockRecordToEntity(record) : null;
  }

  public async findAll(): Promise<readonly Stock[]> {
    const records = await this.prisma.stock.findMany();

    return records.map(mapStockRecordToEntity);
  }
}
