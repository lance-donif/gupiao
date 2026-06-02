import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import YahooFinance from 'yahoo-finance2';

import { loadBackendEnv } from '../src/services/load-backend-env.js';
import {
  DEFAULT_CLUSTER_KEY,
  parseArgs,
  readDateArg,
  readNumberArg,
  runCli,
  writeJson,
} from './limitup-cli-utils.js';

loadBackendEnv();

interface IYahooQuote {
  readonly regularMarketPrice?: number;
  readonly regularMarketTime?: Date | string | number | null;
  readonly currency?: string | null;
}

const toYahooSymbol = (symbol: string): string => {
  if (symbol.startsWith('6')) {
    return `${symbol}.SS`;
  }
  if (symbol.startsWith('0') || symbol.startsWith('3')) {
    return `${symbol}.SZ`;
  }
  if (symbol.startsWith('4') || symbol.startsWith('8') || symbol.startsWith('920')) {
    return `${symbol}.BJ`;
  }
  return symbol;
};

const startOfUtcDate = (date: Date): Date => {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
};

const toTradingDay = (asOf: Date): Date => {
  const beijing = new Date(asOf.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  return startOfUtcDate(beijing);
};

const chunk = <T>(rows: readonly T[], size: number): readonly T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push([...rows.slice(index, index + size)]);
  }
  return chunks;
};

const parseQuoteTime = (value: Date | string | number | null | undefined, fallback: Date): Date => {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) {
      return parsed;
    }
  }
  return fallback;
};

runCli(async () => {
  const args = parseArgs();
  const clusterKey = args.cluster ?? DEFAULT_CLUSTER_KEY;
  const asOf = readDateArg(args['as-of'], new Date());
  const limit = readNumberArg(args.limit, 0);
  const batchSize = readNumberArg(args['batch-size'], 50);
  const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://gupiao:password@localhost:5432/gupiaodb';
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const yahoo = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  const tradingDay = toTradingDay(asOf);
  const capturedAt = new Date();

  try {
    const stocks = await prisma.stock.findMany({
      where: { clusterKey },
      orderBy: { symbol: 'asc' },
      take: limit > 0 ? limit : undefined,
      select: {
        id: true,
        symbol: true,
      },
    });
    let successCount = 0;
    let failedCount = 0;
    const failedSymbols: string[] = [];

    for (const group of chunk(stocks, batchSize)) {
      const yahooSymbols = group.map(stock => toYahooSymbol(stock.symbol));
      let quotes: IYahooQuote[];
      try {
        const response = await yahoo.quote(yahooSymbols, {
          fields: ['regularMarketPrice', 'regularMarketTime', 'currency'],
        });
        quotes = Array.isArray(response) ? response as IYahooQuote[] : [response as IYahooQuote];
      }
      catch {
        failedCount += group.length;
        failedSymbols.push(...group.map(stock => stock.symbol));
        continue;
      }

      for (let index = 0; index < group.length; index += 1) {
        const stock = group[index]!;
        const quote = quotes[index];
        const price = Number(quote?.regularMarketPrice);
        if (!Number.isFinite(price) || price <= 0) {
          failedCount += 1;
          failedSymbols.push(stock.symbol);
          continue;
        }
        const quoteTime = parseQuoteTime(quote?.regularMarketTime, capturedAt);
        await prisma.candle.upsert({
          where: {
            stockId_tradingDay: {
              stockId: stock.id,
              tradingDay,
            },
          },
          create: {
            id: `intraday-${stock.id}-${tradingDay.toISOString().slice(0, 10)}`,
            stockId: stock.id,
            tradingDay,
            open: new Prisma.Decimal(price),
            high: new Prisma.Decimal(price),
            low: new Prisma.Decimal(price),
            close: new Prisma.Decimal(price),
            volume: BigInt(0),
            capturedAt: quoteTime,
          },
          update: {
            close: new Prisma.Decimal(price),
            high: new Prisma.Decimal(price),
            low: new Prisma.Decimal(price),
            capturedAt: quoteTime,
          },
        });
        successCount += 1;
      }
    }

    writeJson({
      clusterKey,
      asOf: asOf.toISOString(),
      tradingDay: tradingDay.toISOString(),
      requestedCount: stocks.length,
      successCount,
      failedCount,
      failedSymbols: failedSymbols.slice(0, 50),
    });
  }
  finally {
    await prisma.$disconnect();
  }
});
