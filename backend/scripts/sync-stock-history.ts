import { pathToFileURL } from 'node:url';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadBackendEnv } from '../src/services/load-backend-env.js';

loadBackendEnv();

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://gupiao:password@localhost:5432/gupiaodb';
const AKTOOLS_BASE_URL = process.env.AKTOOLS_BASE_URL ?? 'http://127.0.0.1:8010';
const DEFAULT_START_DATE = '20260101';
const DEFAULT_AKTOOLS_CONCURRENCY = 8;
const DEFAULT_YAHOO_CONCURRENCY = 5;
const DEFAULT_MAX_RETRIES = 2;
const INSERT_BATCH_SIZE = 2000;
const FAILURE_SAMPLE_LIMIT = 100;

type StockHistoryMode = 'incremental' | 'yahoo-backfill-missing';
type CandleProvider = 'aktools' | 'yahoo' | 'none';

interface IAkCandle {
  readonly 日期: string;
  readonly 开盘: number;
  readonly 最高: number;
  readonly 最低: number;
  readonly 收盘: number;
  readonly 成交量: number;
}

export interface IStockHistoryStock {
  readonly id: string;
  readonly symbol: string;
}

export interface ICandleWriteRow {
  readonly stockId: string;
  readonly tradingDay: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: bigint;
}

export interface IYahooChartQuote {
  readonly date?: Date;
  readonly open?: number | null;
  readonly high?: number | null;
  readonly low?: number | null;
  readonly close?: number | null;
  readonly volume?: number | null;
}

interface IYahooChartResult {
  readonly quotes: readonly IYahooChartQuote[];
}

interface IYahooFinanceClient {
  chart: (
    symbol: string,
    options: {
      readonly period1: string;
      readonly period2: string;
      readonly interval: '1d';
    },
  ) => Promise<IYahooChartResult>;
}

type StockHistoryFetcher = (
  stock: IStockHistoryStock,
  startDate: string,
  endDate: string,
) => Promise<readonly ICandleWriteRow[]>;

export interface IFetchRowsWithFallbackInput {
  readonly stock: IStockHistoryStock;
  readonly startDate: string;
  readonly endDate: string;
  readonly enableYahooFallback: boolean;
  readonly maxRetries: number;
  readonly aktoolsFetcher: StockHistoryFetcher;
  readonly yahooFetcher: StockHistoryFetcher;
}

export interface IFetchRowsWithFallbackResult {
  readonly provider: CandleProvider;
  readonly rows: readonly ICandleWriteRow[];
  readonly aktoolsError?: string;
  readonly yahooError?: string;
}

interface IStockSyncResult {
  readonly symbol: string;
  readonly provider: CandleProvider;
  readonly fetchedRows: number;
  readonly insertedRows: number;
  readonly skippedExistingRows: number;
  readonly error?: string;
}

interface ISyncOptions {
  readonly mode: StockHistoryMode;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly aktoolsConcurrency: number;
  readonly yahooConcurrency: number;
  readonly maxRetries: number;
  readonly yahooFallback: boolean;
}

const parseArgs = (): Record<string, string> => {
  const parsed: Record<string, string> = {};
  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    parsed[token.slice(2)] = process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
      ? process.argv[++index]
      : 'true';
  }
  return parsed;
};

const parsePositiveInteger = (raw: string | undefined, fallback: number, name: string): number => {
  if (!raw?.trim()) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

const parseBoolean = (raw: string | undefined, fallback: boolean, name: string): boolean => {
  if (!raw?.trim()) {
    return fallback;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  throw new Error(`${name} must be true or false`);
};

const parseMode = (raw: string | undefined): StockHistoryMode => {
  if (!raw || raw === 'incremental') {
    return 'incremental';
  }
  if (raw === 'yahoo-backfill-missing') {
    return raw;
  }
  throw new Error(`Invalid --mode: ${raw}. Supported values: incremental, yahoo-backfill-missing`);
};

const resolveOptions = (): ISyncOptions => {
  const args = parseArgs();
  return {
    mode: parseMode(args.mode),
    startDate: args['start-date'],
    endDate: args['end-date'],
    aktoolsConcurrency: parsePositiveInteger(
      args['aktools-concurrency'] ?? process.env.STOCK_HISTORY_AKTOOLS_CONCURRENCY,
      DEFAULT_AKTOOLS_CONCURRENCY,
      'STOCK_HISTORY_AKTOOLS_CONCURRENCY',
    ),
    yahooConcurrency: parsePositiveInteger(
      args['yahoo-concurrency'] ?? process.env.STOCK_HISTORY_YAHOO_CONCURRENCY,
      DEFAULT_YAHOO_CONCURRENCY,
      'STOCK_HISTORY_YAHOO_CONCURRENCY',
    ),
    maxRetries: parsePositiveInteger(
      args.retries ?? process.env.STOCK_HISTORY_MAX_RETRIES,
      DEFAULT_MAX_RETRIES,
      'STOCK_HISTORY_MAX_RETRIES',
    ),
    yahooFallback: parseBoolean(
      args['yahoo-fallback'] ?? process.env.STOCK_HISTORY_YAHOO_FALLBACK,
      true,
      'STOCK_HISTORY_YAHOO_FALLBACK',
    ),
  };
};

export const parseYYYYMMDD = (value: string): Date => {
  if (!/^\d{8}$/u.test(value)) {
    throw new Error(`Invalid date ${value}, expected YYYYMMDD`);
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date ${value}, expected YYYYMMDD`);
  }
  return date;
};

export const toYYYYMMDD = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
};

const toDashedDate = (value: string): string => {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
};

const addDays = (value: string, days: number): string => {
  const date = parseYYYYMMDD(value);
  date.setUTCDate(date.getUTCDate() + days);
  return toYYYYMMDD(date);
};

export const buildYahooChartDateRange = (
  startDate: string,
  endDate: string,
): { readonly period1: string; readonly period2: string } => ({
  period1: toDashedDate(startDate),
  period2: toDashedDate(addDays(endDate, 1)),
});

export const convertToYahooSymbol = (symbol: string): string | null => {
  if (/^[036]\d{5}$/u.test(symbol)) {
    return symbol.startsWith('6') ? `${symbol}.SS` : `${symbol}.SZ`;
  }
  return null;
};

const isFinitePositiveNumber = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
};

const isValidOhlc = (open: unknown, high: unknown, low: unknown, close: unknown): boolean => {
  if (
    !isFinitePositiveNumber(open)
    || !isFinitePositiveNumber(high)
    || !isFinitePositiveNumber(low)
    || !isFinitePositiveNumber(close)
  ) {
    return false;
  }
  return high >= Math.max(open, close) && low <= Math.min(open, close);
};

const toVolume = (value: unknown): bigint => {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? BigInt(Math.trunc(value))
    : 0n;
};

export const mapYahooChartQuotesToRows = (
  stock: IStockHistoryStock,
  quotes: readonly IYahooChartQuote[],
): ICandleWriteRow[] => {
  const rows: ICandleWriteRow[] = [];
  const seenDays = new Set<string>();
  for (const quote of quotes) {
    if (!(quote.date instanceof Date) || Number.isNaN(quote.date.getTime())) {
      continue;
    }
    if (!isValidOhlc(quote.open, quote.high, quote.low, quote.close)) {
      continue;
    }
    const tradingDayKey = toYYYYMMDD(quote.date);
    if (seenDays.has(tradingDayKey)) {
      continue;
    }
    seenDays.add(tradingDayKey);
    rows.push({
      stockId: stock.id,
      tradingDay: parseYYYYMMDD(tradingDayKey),
      open: Number(quote.open),
      high: Number(quote.high),
      low: Number(quote.low),
      close: Number(quote.close),
      volume: toVolume(quote.volume),
    });
  }
  return rows;
};

const mapAkToolsCandlesToRows = (
  stock: IStockHistoryStock,
  candles: readonly IAkCandle[],
): ICandleWriteRow[] => {
  return candles.flatMap((item): ICandleWriteRow[] => {
    const tradingDay = new Date(`${item['日期']}T00:00:00.000Z`);
    if (Number.isNaN(tradingDay.getTime())) {
      return [];
    }
    return [{
      stockId: stock.id,
      tradingDay,
      open: Number(item['开盘']),
      high: Number(item['最高']),
      low: Number(item['最低']),
      close: Number(item['收盘']),
      volume: BigInt(Math.trunc(Number(item['成交量']))),
    }];
  });
};

export const filterRowsToMissingTradingDays = (
  rows: readonly ICandleWriteRow[],
  existingTradingDays: ReadonlySet<string>,
): ICandleWriteRow[] => {
  return rows.filter(row => !existingTradingDays.has(toYYYYMMDD(row.tradingDay)));
};

async function asyncPool<T, R>(
  concurrency: number,
  iterable: readonly T[],
  iteratorFn: (item: T) => Promise<R>,
): Promise<R[]> {
  const ret: Promise<R>[] = [];
  const executing: Promise<unknown>[] = [];
  for (const item of iterable) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);
    if (concurrency <= iterable.length) {
      const e: Promise<unknown> = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= concurrency) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(ret);
}

const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

const fetchWithRetries = async <T>(
  fetcher: () => Promise<T>,
  maxRetries: number,
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fetcher();
    }
    catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }
  throw lastError;
};

const fetchAkToolsRows: StockHistoryFetcher = async (stock, startDate, endDate) => {
  const url = `${AKTOOLS_BASE_URL}/api/public/stock_zh_a_hist?symbol=${stock.symbol}&start_date=${startDate}&end_date=${endDate}&adjust=qfq`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) {
    throw new Error('invalid_array_payload');
  }
  return mapAkToolsCandlesToRows(stock, payload as readonly IAkCandle[]);
};

let yahooClientPromise: Promise<IYahooFinanceClient> | null = null;

const getYahooClient = async (): Promise<IYahooFinanceClient> => {
  yahooClientPromise ??= import('yahoo-finance2').then(({ default: YahooFinance }) => (
    new YahooFinance({
      suppressNotices: ['yahooSurvey', 'ripHistorical'],
    }) as IYahooFinanceClient
  ));
  return yahooClientPromise;
};

const fetchYahooRows: StockHistoryFetcher = async (stock, startDate, endDate) => {
  const yahooSymbol = convertToYahooSymbol(stock.symbol);
  if (!yahooSymbol) {
    throw new Error('unsupported_yahoo_symbol');
  }
  const client = await getYahooClient();
  const result = await client.chart(yahooSymbol, {
    ...buildYahooChartDateRange(startDate, endDate),
    interval: '1d',
  });
  return mapYahooChartQuotesToRows(stock, result.quotes);
};

export const fetchRowsWithFallback = async (
  input: IFetchRowsWithFallbackInput,
): Promise<IFetchRowsWithFallbackResult> => {
  let aktoolsError: string | undefined;
  try {
    const rows = await fetchWithRetries(async () => {
      const fetchedRows = await input.aktoolsFetcher(input.stock, input.startDate, input.endDate);
      if (fetchedRows.length === 0) {
        throw new Error('empty_result');
      }
      return fetchedRows;
    }, input.maxRetries);
    return { provider: 'aktools', rows };
  }
  catch (error) {
    aktoolsError = getErrorMessage(error);
  }

  if (!input.enableYahooFallback) {
    return { provider: 'none', rows: [], aktoolsError };
  }

  try {
    const rows = await fetchWithRetries(async () => {
      const fetchedRows = await input.yahooFetcher(input.stock, input.startDate, input.endDate);
      if (fetchedRows.length === 0) {
        throw new Error('empty_result');
      }
      return fetchedRows;
    }, input.maxRetries);
    return { provider: 'yahoo', rows, aktoolsError };
  }
  catch (error) {
    return {
      provider: 'none',
      rows: [],
      aktoolsError,
      yahooError: getErrorMessage(error),
    };
  }
};

const resolveDateRange = async (
  prisma: PrismaClient,
  options: ISyncOptions,
): Promise<{ readonly startDate: string; readonly endDate: string }> => {
  const latestCandle = await prisma.candle.findFirst({
    orderBy: { tradingDay: 'desc' },
    select: { tradingDay: true },
  });
  const startDate = options.startDate
    ?? (latestCandle?.tradingDay ? toYYYYMMDD(latestCandle.tradingDay) : DEFAULT_START_DATE);
  const endDate = options.endDate ?? toYYYYMMDD(new Date());
  parseYYYYMMDD(startDate);
  parseYYYYMMDD(endDate);
  if (startDate > endDate) {
    throw new Error(`Invalid date range: ${startDate} > ${endDate}`);
  }
  return { startDate, endDate };
};

const loadExistingTradingDays = async (
  prisma: PrismaClient,
  startDate: string,
  endDate: string,
): Promise<Map<string, Set<string>>> => {
  const rows = await prisma.candle.findMany({
    where: {
      tradingDay: {
        gte: parseYYYYMMDD(startDate),
        lte: parseYYYYMMDD(endDate),
      },
    },
    select: {
      stockId: true,
      tradingDay: true,
    },
  });
  const existing = new Map<string, Set<string>>();
  for (const row of rows) {
    const dates = existing.get(row.stockId) ?? new Set<string>();
    dates.add(toYYYYMMDD(row.tradingDay));
    existing.set(row.stockId, dates);
  }
  return existing;
};

async function main(): Promise<void> {
  const options = resolveOptions();
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL }),
  });

  try {
    console.log('正在获取所有股票符号...');
    const stocks = await prisma.stock.findMany({
      select: { id: true, symbol: true },
      orderBy: { symbol: 'asc' },
    });
    console.log(`数据库中共有 ${stocks.length} 只股票。`);

    const { startDate, endDate } = await resolveDateRange(prisma, options);
    const concurrency = options.mode === 'yahoo-backfill-missing'
      ? options.yahooConcurrency
      : options.aktoolsConcurrency;
    console.log(`同步模式: ${options.mode}`);
    console.log(`同步区间: [${startDate} -> ${endDate}]`);
    console.log(`并发: ${concurrency}, 重试: ${options.maxRetries}, Yahoo fallback: ${options.yahooFallback}`);

    const existingDaysByStockId = await loadExistingTradingDays(prisma, startDate, endDate);
    let insertQueue: ICandleWriteRow[] = [];
    let totalCandlesInserted = 0;

    const flushQueue = async (): Promise<void> => {
      if (insertQueue.length === 0) {
        return;
      }
      const data = insertQueue;
      insertQueue = [];
      const result = await prisma.candle.createMany({
        data,
        skipDuplicates: true,
      });
      totalCandlesInserted += result.count;
    };

    const enqueueRows = async (rows: readonly ICandleWriteRow[]): Promise<void> => {
      if (rows.length === 0) {
        return;
      }
      insertQueue.push(...rows);
      if (insertQueue.length >= INSERT_BATCH_SIZE) {
        await flushQueue();
      }
    };

    console.log('开始同步行情...');
    const startTime = Date.now();
    let processed = 0;

    const results = await asyncPool(concurrency, stocks, async (stock): Promise<IStockSyncResult> => {
      const existingTradingDays = existingDaysByStockId.get(stock.id) ?? new Set<string>();
      try {
        const fetchResult = options.mode === 'yahoo-backfill-missing'
          ? {
              provider: 'yahoo' as const,
              rows: await fetchYahooRows(stock, startDate, endDate),
            }
          : await fetchRowsWithFallback({
              stock,
              startDate,
              endDate,
              enableYahooFallback: options.yahooFallback,
              maxRetries: options.maxRetries,
              aktoolsFetcher: fetchAkToolsRows,
              yahooFetcher: fetchYahooRows,
            });

        if (fetchResult.provider === 'none') {
          return {
            symbol: stock.symbol,
            provider: 'none',
            fetchedRows: 0,
            insertedRows: 0,
            skippedExistingRows: 0,
            error: `aktools=${fetchResult.aktoolsError ?? 'none'}; yahoo=${fetchResult.yahooError ?? 'none'}`,
          };
        }

        const rowsToInsert = filterRowsToMissingTradingDays(fetchResult.rows, existingTradingDays);
        for (const row of rowsToInsert) {
          existingTradingDays.add(toYYYYMMDD(row.tradingDay));
        }
        existingDaysByStockId.set(stock.id, existingTradingDays);
        await enqueueRows(rowsToInsert);

        return {
          symbol: stock.symbol,
          provider: fetchResult.provider,
          fetchedRows: fetchResult.rows.length,
          insertedRows: rowsToInsert.length,
          skippedExistingRows: fetchResult.rows.length - rowsToInsert.length,
        };
      }
      catch (error) {
        return {
          symbol: stock.symbol,
          provider: 'none',
          fetchedRows: 0,
          insertedRows: 0,
          skippedExistingRows: 0,
          error: getErrorMessage(error),
        };
      }
      finally {
        processed += 1;
        if (processed % 500 === 0) {
          console.log(`  已处理 ${processed}/${stocks.length} 只股票...`);
        }
      }
    });

    await flushQueue();

    const providerCounts = results.reduce<Record<CandleProvider, number>>((counts, result) => {
      counts[result.provider] += 1;
      return counts;
    }, { aktools: 0, yahoo: 0, none: 0 });
    const failed = results.filter(result => result.provider === 'none');
    const skippedExistingRows = results.reduce((sum, result) => sum + result.skippedExistingRows, 0);
    const fetchedRows = results.reduce((sum, result) => sum + result.fetchedRows, 0);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n行情同步完成：');
    console.log(`  AKTools 成功: ${providerCounts.aktools} 只股票`);
    console.log(`  Yahoo 成功: ${providerCounts.yahoo} 只股票`);
    console.log(`  失败: ${failed.length} 只股票`);
    console.log(`  拉取 K 线数: ${fetchedRows}`);
    console.log(`  跳过已存在 K 线数: ${skippedExistingRows}`);
    console.log(`  实际新增 K 线数: ${totalCandlesInserted}`);
    console.log(`  总耗时: ${elapsed} 秒`);
    if (failed.length > 0) {
      console.log('\n失败样本:');
      for (const failure of failed.slice(0, FAILURE_SAMPLE_LIMIT)) {
        console.log(`  ${failure.symbol}: ${failure.error ?? 'unknown_error'}`);
      }
    }
  }
  finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error('同步异常:', error);
    process.exitCode = 1;
  });
}
