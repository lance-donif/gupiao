import type { IStockHistoryCandle, IStockHistoryTarget } from './stock-history-sync-types.js';

interface IPgQueryResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

interface IPgPoolClient {
  readonly query: <Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<IPgQueryResult<Row>>;
  readonly release: () => void;
}

export interface IPgStockHistoryPool {
  readonly connect: () => Promise<IPgPoolClient>;
  readonly query: <Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<IPgQueryResult<Row>>;
  readonly end: () => Promise<void>;
}

const toUtcTradingDay = (tradingDay: string): Date => new Date(`${tradingDay}T00:00:00.000Z`);

const toStockId = (clusterKey: string, symbol: string): string => {
  const cleanCluster = clusterKey.replace(/[^\w-]/g, '_');
  return `stock-${cleanCluster}-${symbol}`;
};

const toCandleId = (stockId: string, tradingDay: string): string => {
  return `candle-${stockId}-${tradingDay}`;
};

export class PgStockHistoryRepository {
  public constructor(
    private readonly pool: IPgStockHistoryPool,
    private readonly clusterKey: string,
  ) {}

  public async saveStockHistory(
    target: IStockHistoryTarget,
    candles: readonly IStockHistoryCandle[],
  ): Promise<number> {
    if (candles.length === 0) {
      return 0;
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const stockId = await this.upsertStock(client, target, candles[candles.length - 1]!.tradingDay);
      const count = await this.upsertCandles(client, stockId, candles);
      await client.query('COMMIT');
      return count;
    }
    catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    finally {
      client.release();
    }
  }

  public async verify(): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      [
        'SELECT',
        '  COUNT(DISTINCT s.id)::int AS "stockCount",',
        '  COUNT(c.id)::int AS "candleCount",',
        '  MIN(c."tradingDay") AS "earliestTradeDay",',
        '  MAX(c."tradingDay") AS "latestTradeDay",',
        '  COUNT(DISTINCT CASE WHEN s."latestTradeDay" IS NOT NULL THEN s.id END)::int AS "pricedStockCount"',
        'FROM "Stock" s',
        'LEFT JOIN "Candle" c ON c."stockId" = s.id',
        'WHERE s."clusterKey" = $1',
      ].join(' '),
      [this.clusterKey],
    );
    return result.rows[0] ?? {};
  }

  public async getLatestTradeDays(): Promise<Map<string, string>> {
    const result = await this.pool.query<{ symbol: string; latestTradeDay: Date | string }>(
      [
        'SELECT s."symbol", MAX(c."tradingDay") AS "latestTradeDay"',
        'FROM "Stock" s',
        'LEFT JOIN "Candle" c ON c."stockId" = s.id',
        'WHERE s."clusterKey" = $1',
        'GROUP BY s."symbol"',
      ].join(' '),
      [this.clusterKey],
    );

    const map = new Map<string, string>();
    for (const row of result.rows) {
      if (row.latestTradeDay) {
        const date = new Date(row.latestTradeDay);
        const yyyy = date.getUTCFullYear();
        const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(date.getUTCDate()).padStart(2, '0');
        map.set(row.symbol, `${yyyy}-${mm}-${dd}`);
      }
    }
    return map;
  }

  private async upsertStock(
    client: IPgPoolClient,
    target: IStockHistoryTarget,
    latestTradeDay: string,
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      [
        'INSERT INTO "Stock"',
        '("id", "symbol", "name", "industry", "exchange", "clusterKey", "lastSyncedAt", "latestTradeDay", "createdAt", "updatedAt")',
        'VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, NOW(), NOW())',
        'ON CONFLICT ("clusterKey", "symbol") DO UPDATE SET',
        '  "name" = EXCLUDED."name",',
        '  "industry" = EXCLUDED."industry",',
        '  "exchange" = EXCLUDED."exchange",',
        '  "lastSyncedAt" = EXCLUDED."lastSyncedAt",',
        '  "latestTradeDay" = EXCLUDED."latestTradeDay",',
        '  "updatedAt" = NOW()',
        'RETURNING "id"',
      ].join(' '),
      [
        toStockId(this.clusterKey, target.symbol),
        target.symbol,
        target.name,
        target.industry,
        target.exchange,
        this.clusterKey,
        toUtcTradingDay(latestTradeDay),
      ],
    );
    return result.rows[0]!.id;
  }

  private async upsertCandles(
    client: IPgPoolClient,
    stockId: string,
    candles: readonly IStockHistoryCandle[],
  ): Promise<number> {
    const values: string[] = [];
    const params: Array<string | number | bigint | Date> = [];
    for (const candle of candles) {
      const start = params.length;
      params.push(
        toCandleId(stockId, candle.tradingDay),
        stockId,
        toUtcTradingDay(candle.tradingDay),
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume,
      );
      values.push(`($${start + 1}, $${start + 2}, $${start + 3}, $${start + 4}, $${start + 5}, $${start + 6}, $${start + 7}, $${start + 8}, NOW(), NOW(), NOW())`);
    }
    const result = await client.query(
      [
        'INSERT INTO "Candle"',
        '("id", "stockId", "tradingDay", "open", "high", "low", "close", "volume", "capturedAt", "createdAt", "updatedAt")',
        `VALUES ${values.join(', ')}`,
        'ON CONFLICT ("stockId", "tradingDay") DO UPDATE SET',
        '  "open" = EXCLUDED."open",',
        '  "high" = EXCLUDED."high",',
        '  "low" = EXCLUDED."low",',
        '  "close" = EXCLUDED."close",',
        '  "volume" = EXCLUDED."volume",',
        '  "capturedAt" = EXCLUDED."capturedAt",',
        '  "updatedAt" = NOW()',
      ].join(' '),
      params,
    );
    return result.rowCount ?? 0;
  }
}
