import { pathToFileURL } from 'node:url';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadBackendEnv } from '../src/services/load-backend-env.js';

loadBackendEnv();

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://gupiao:password@localhost:5432/gupiaodb';
const AKTOOLS_BASE_URL = process.env.AKTOOLS_BASE_URL ?? 'http://127.0.0.1:8010';
const DEFAULT_START_DATE = '20260101';
const DEFAULT_AKTOOLS_CONCURRENCY = 32;
const DEFAULT_YAHOO_CONCURRENCY = 16;
const DEFAULT_MAX_RETRIES = 2;
const INSERT_BATCH_SIZE = 5000;
const AKTOOLS_FETCH_TIMEOUT_MS = 20000;
const AKTOOLS_SPOT_TIMEOUT_MS = 90000;
// 传输层熔断阈值：连续 N 次传输错误（HTTP/超时/建连失败）直接整轮抛错退出，
// 避免上游挂掉时数千只股票逐只空转数小时。empty_result 等业务性失败不计入。
const DEFAULT_BREAKER_THRESHOLD = 20;
// 交易日历探针：高流动性、极少停牌的基准股。任一返回即可确定区间内的真实交易日。
const PROBE_SYMBOLS: readonly string[] = ['600519', '000001'];
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

// stock_zh_a_spot_em 单行：字段可能为数字、字符串占位符（'-'）或 null，逐字段清洗。
export interface IAkSpotRow {
  readonly '代码': unknown;
  readonly '今开': unknown;
  readonly '最高': unknown;
  readonly '最低': unknown;
  readonly '最新价': unknown;
  readonly '成交量': unknown;
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
  readonly breakerThreshold: number;
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
      // 默认开启：AKTools 不可用时逐只回退 Yahoo，保证链路不被单一行情源卡死；
      // 行情部分缺失可接受（只影响覆盖率），与 LLM 零降级红线无关。
      true,
      'STOCK_HISTORY_YAHOO_FALLBACK',
    ),
    breakerThreshold: parsePositiveInteger(
      args['breaker-threshold'] ?? process.env.STOCK_HISTORY_BREAKER_THRESHOLD,
      DEFAULT_BREAKER_THRESHOLD,
      'STOCK_HISTORY_BREAKER_THRESHOLD',
    ),
  };
};

// Yahoo 单次 chart 请求超时：限流时 Yahoo 会挂起连接不返回，无超时会卡死整个 worker。
const YAHOO_FETCH_TIMEOUT_MS = parsePositiveInteger(
  process.env.STOCK_HISTORY_YAHOO_TIMEOUT_MS,
  30000,
  'STOCK_HISTORY_YAHOO_TIMEOUT_MS',
);

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

export const selectStocksNeedingSync = (
  stocks: readonly IStockHistoryStock[],
  existingDaysByStockId: ReadonlyMap<string, ReadonlySet<string>>,
  startDate: string,
  endDate: string,
): IStockHistoryStock[] => {
  // 单日区间（最常见的每日增量场景）：已持有该交易日的股票无需再请求上游。
  // 多日区间时无法从本地推断交易日历，保持全量拉取后按缺失过滤。
  if (startDate !== endDate) {
    return [...stocks];
  }
  return stocks.filter(stock => !(existingDaysByStockId.get(stock.id)?.has(endDate) ?? false));
};

export const addDaysToYYYYMMDD = (value: string, deltaDays: number): string => {
  const date = parseYYYYMMDD(value);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return toYYYYMMDD(date);
};

export const extractHistTradingDays = (
  candles: readonly IAkCandle[],
  startDate: string,
  endDate: string,
): string[] => {
  const days = new Set<string>();
  for (const item of candles) {
    const compact = item['日期'].replace(/-/gu, '');
    if (/^\d{8}$/u.test(compact) && compact >= startDate && compact <= endDate) {
      days.add(compact);
    }
  }
  return [...days].sort();
};

const toPositiveFiniteNumber = (value: unknown): number | null => {
  const parsed = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

// 批量快照映射：与逐只 hist（adjust=qfq）语义对齐——前复权下最新交易日的
// OHLC 等于原始值；成交量两侧单位均为手。停牌股（量为 0/缺失）会被剔除，
// 交由逐只回补路径处理（hist 无该日行即不入库，与旧行为一致）。
export const convertToSinaSymbol = (symbol: string): string | null => {
  if (/^(60|68|90)\d{4}$/.test(symbol)) {
    return `sh${symbol}`;
  }
  if (/^(00|30|20)\d{4}$/.test(symbol)) {
    return `sz${symbol}`;
  }
  return null;
};

export interface ISinaSpotRow {
  readonly symbol: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly prevClose: number;
  readonly volumeHands: number;
  readonly date: string;
  readonly time: string;
}

const SINA_BATCH_SIZE = 100;
const SINA_CONCURRENCY = 8;
const SINA_FETCH_TIMEOUT_MS = 20000;

/** 解析单行 hq.sinajs.cn 返回：var hq_str_sh600519="名字,今开,昨收,最新价,最高,最低,...,成交量(手),成交额,...,日期,时间"; */
export const parseSinaSpotLine = (line: string): ISinaSpotRow | null => {
  const match = line.match(/^var hq_str_([a-z]{2}\d{6})="([^"]*)";?\s*$/);
  if (!match?.[1] || match[2] === undefined) {
    return null;
  }
  const fields = match[2].split(',');
  if (fields.length < 32) {
    return null;
  }
  const open = Number(fields[1]);
  const prevClose = Number(fields[2]);
  const close = Number(fields[3]);
  const high = Number(fields[4]);
  const low = Number(fields[5]);
  const volumeHands = Number(fields[8]);
  if (![open, high, low, close].every(value => Number.isFinite(value) && value > 0)) {
    return null;
  }
  if (!Number.isFinite(volumeHands) || volumeHands < 0) {
    return null;
  }
  return {
    symbol: match[1],
    open,
    high,
    low,
    close,
    prevClose,
    volumeHands,
    date: fields[30] ?? '',
    time: fields[31] ?? '',
  };
};

export const mapSinaSpotRowsToCandleRows = (
  stocksBySymbol: ReadonlyMap<string, IStockHistoryStock>,
  rows: readonly ISinaSpotRow[],
  tradingDay: Date,
): ICandleWriteRow[] => {
  const sinaToStock = new Map<string, IStockHistoryStock>();
  for (const stock of stocksBySymbol.values()) {
    const sinaSymbol = convertToSinaSymbol(stock.symbol);
    if (sinaSymbol !== null) {
      sinaToStock.set(sinaSymbol, stock);
    }
  }
  const seen = new Set<string>();
  const out: ICandleWriteRow[] = [];
  for (const row of rows) {
    const stock = sinaToStock.get(row.symbol);
    if (!stock || seen.has(stock.id)) {
      continue;
    }
    seen.add(stock.id);
    out.push({
      stockId: stock.id,
      tradingDay,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      // 新浪成交量单位为手，统一换算为股。
      volume: BigInt(Math.trunc(row.volumeHands * 100)),
    });
  }
  return out;
};

const chunkArray = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
};

const fetchSinaSpotBatch = async (symbols: readonly string[]): Promise<readonly ISinaSpotRow[]> => {
  const url = `https://hq.sinajs.cn/list=${symbols.join(',')}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(SINA_FETCH_TIMEOUT_MS),
    headers: { Referer: 'https://finance.sina.com.cn' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  let text: string;
  try {
    text = new TextDecoder('gbk').decode(buffer);
  }
  catch {
    text = new TextDecoder().decode(buffer);
  }
  return text.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(parseSinaSpotLine)
    .filter((row): row is ISinaSpotRow => row !== null);
};

const fetchSinaSpotPayload = async (
  stocks: readonly IStockHistoryStock[],
): Promise<readonly ISinaSpotRow[]> => {
  const symbols = stocks
    .map(stock => convertToSinaSymbol(stock.symbol))
    .filter((symbol): symbol is string => symbol !== null);
  if (symbols.length === 0) {
    throw new Error('empty_result');
  }
  const batches = chunkArray(symbols, SINA_BATCH_SIZE);
  const results = await asyncPool(SINA_CONCURRENCY, batches, fetchSinaSpotBatch);
  return results.flat();
};

export const mapSpotPayloadToCandleRows = (
  stocksBySymbol: ReadonlyMap<string, IStockHistoryStock>,
  payload: readonly IAkSpotRow[],
  tradingDay: Date,
): ICandleWriteRow[] => {
  const seen = new Set<string>();
  const rows: ICandleWriteRow[] = [];
  for (const item of payload) {
    const symbol = typeof item['代码'] === 'string' ? item['代码'] : null;
    if (symbol === null) {
      continue;
    }
    const stock = stocksBySymbol.get(symbol);
    if (!stock || seen.has(stock.id)) {
      continue;
    }
    const open = toPositiveFiniteNumber(item['今开']);
    const high = toPositiveFiniteNumber(item['最高']);
    const low = toPositiveFiniteNumber(item['最低']);
    const close = toPositiveFiniteNumber(item['最新价']);
    const volume = toPositiveFiniteNumber(item['成交量']);
    if (open === null || high === null || low === null || close === null || volume === null) {
      continue;
    }
    seen.add(stock.id);
    rows.push({
      stockId: stock.id,
      tradingDay,
      open,
      high,
      low,
      close,
      volume: BigInt(Math.trunc(volume)),
    });
  }
  return rows;
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

export const AKTOOLS_BREAKER_TRIPPED = 'aktools_unavailable_fail_fast';

/** 传输层错误（上游挂掉/限流掐连接）vs 业务性失败（停牌空结果等）的分类。 */
export const isTransportErrorMessage = (message: string): boolean => {
  return /HTTP \d{3}|timeout|fetch failed|socket|ECONN|EAI_AGAIN|certificate|TLS|network|closed unexpectedly|429|502|503|504/i.test(message);
};

export interface IConsecutiveFailureBreaker {
  recordFailure: (transportError: boolean) => void;
  recordSuccess: () => void;
  shouldTrip: () => boolean;
}

/** 连续传输失败计数器：成功或业务性失败即清零，连续超阈值则整轮熔断。 */
export const createConsecutiveFailureBreaker = (threshold: number): IConsecutiveFailureBreaker => {
  let consecutiveTransportFailures = 0;
  return {
    recordFailure: (transportError: boolean): void => {
      consecutiveTransportFailures = transportError ? consecutiveTransportFailures + 1 : 0;
    },
    recordSuccess: (): void => {
      consecutiveTransportFailures = 0;
    },
    shouldTrip: (): boolean => consecutiveTransportFailures >= threshold,
  };
};

export const withFetchTimeout = async <T>(task: () => Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`fetch_timeout_after_${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  }
  finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

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

const fetchAkToolsHistPayload = async (
  symbol: string,
  startDate: string,
  endDate: string,
): Promise<readonly IAkCandle[]> => {
  const url = `${AKTOOLS_BASE_URL}/api/public/stock_zh_a_hist?symbol=${symbol}&start_date=${startDate}&end_date=${endDate}&adjust=qfq`;
  const response = await fetch(url, { signal: AbortSignal.timeout(AKTOOLS_FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) {
    throw new Error('invalid_array_payload');
  }
  return payload as readonly IAkCandle[];
};

const fetchAkToolsRows: StockHistoryFetcher = async (stock, startDate, endDate) => {
  return mapAkToolsCandlesToRows(stock, await fetchAkToolsHistPayload(stock.symbol, startDate, endDate));
};

const fetchSpotPayload = async (): Promise<readonly IAkSpotRow[]> => {
  const url = `${AKTOOLS_BASE_URL}/api/public/stock_zh_a_spot_em`;
  const response = await fetch(url, { signal: AbortSignal.timeout(AKTOOLS_SPOT_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) {
    throw new Error('invalid_array_payload');
  }
  return payload as readonly IAkSpotRow[];
};

const discoverTradingDays = async (startDate: string, endDate: string): Promise<string[]> => {
  const days = new Set<string>();
  await Promise.all(PROBE_SYMBOLS.map(async (symbol) => {
    try {
      const candles = await fetchAkToolsHistPayload(symbol, startDate, endDate);
      for (const day of extractHistTradingDays(candles, startDate, endDate)) {
        days.add(day);
      }
    }
    catch {
      // 单个探针失败不致命：任一基准股返回即可确定交易日历。
    }
  }));
  if (days.size === 0) {
    throw new Error('no_trading_days_discovered');
  }
  return [...days].sort();
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
  const result = await withFetchTimeout(() => client.chart(yahooSymbol, {
    ...buildYahooChartDateRange(startDate, endDate),
    interval: '1d',
  }), YAHOO_FETCH_TIMEOUT_MS);
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
    console.log(`并发: ${concurrency}, 重试: ${options.maxRetries}, Yahoo fallback: ${options.yahooFallback}, 熔断阈值: ${options.breakerThreshold}`);

    const existingDaysByStockId = await loadExistingTradingDays(prisma, startDate, endDate);
    const pendingStocks = selectStocksNeedingSync(stocks, existingDaysByStockId, startDate, endDate);
    console.log(`待同步: ${pendingStocks.length}/${stocks.length} 只股票（其余本地已有，无需请求上游）。`);
    if (pendingStocks.length === 0) {
      console.log('\n行情同步完成：本地已是最新，无需拉取。');
      return;
    }
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
    let processedTotal = pendingStocks.length;
    const breaker = createConsecutiveFailureBreaker(options.breakerThreshold);

    const syncOneStock = async (
      stock: IStockHistoryStock,
      rangeStart: string,
      rangeEnd: string,
    ): Promise<IStockSyncResult> => {
      const existingTradingDays = existingDaysByStockId.get(stock.id) ?? new Set<string>();
      try {
        const fetchResult = options.mode === 'yahoo-backfill-missing'
          ? {
              provider: 'yahoo' as const,
              rows: await fetchYahooRows(stock, rangeStart, rangeEnd),
            }
          : await fetchRowsWithFallback({
              stock,
              startDate: rangeStart,
              endDate: rangeEnd,
              enableYahooFallback: options.yahooFallback,
              maxRetries: options.maxRetries,
              aktoolsFetcher: fetchAkToolsRows,
              yahooFetcher: fetchYahooRows,
            });

        if (fetchResult.provider === 'none') {
          const failureMessage = `aktools=${fetchResult.aktoolsError ?? 'none'}; yahoo=${fetchResult.yahooError ?? 'none'}`;
          breaker.recordFailure(isTransportErrorMessage(failureMessage));
          if (breaker.shouldTrip()) {
            throw new Error(`${AKTOOLS_BREAKER_TRIPPED}: consecutive transport failures >= ${options.breakerThreshold}, last=${failureMessage}`);
          }
          return {
            symbol: stock.symbol,
            provider: 'none',
            fetchedRows: 0,
            insertedRows: 0,
            skippedExistingRows: 0,
            error: `aktools=${fetchResult.aktoolsError ?? 'none'}; yahoo=${fetchResult.yahooError ?? 'none'}`,
          };
        }
        breaker.recordSuccess();

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
        const message = getErrorMessage(error);
        if (message.includes(AKTOOLS_BREAKER_TRIPPED)) {
          throw error;
        }
        breaker.recordFailure(isTransportErrorMessage(message));
        if (breaker.shouldTrip()) {
          throw new Error(`${AKTOOLS_BREAKER_TRIPPED}: consecutive transport failures >= ${options.breakerThreshold}, last=${message}`);
        }
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
          console.log(`  已处理 ${processed}/${processedTotal} 只股票...`);
        }
      }
    };

    const runPerStockPool = async (
      targets: readonly IStockHistoryStock[],
      rangeStart: string,
      rangeEnd: string,
    ): Promise<IStockSyncResult[]> => {
      processed = 0;
      processedTotal = targets.length;
      return asyncPool(concurrency, targets, async stock => syncOneStock(stock, rangeStart, rangeEnd));
    };

    // 增量快车道：最新交易日用 1 次全市场快照覆盖，历史缺口才逐只回补。
    // 调度在收盘后运行，快照即当日定稿；前复权下最新日 OHLC 与 hist 一致。
    const runIncrementalSpotPath = async (): Promise<IStockSyncResult[]> => {
      const tradingDays = await discoverTradingDays(startDate, endDate);
      const spotDay = tradingDays[tradingDays.length - 1] as string;
      const histEnd = addDaysToYYYYMMDD(spotDay, -1);
      const histDays = tradingDays.filter(day => day <= histEnd);
      console.log(`交易日历: 区间内 ${tradingDays.length} 个交易日，快照覆盖 ${spotDay}。`);
      const stockById = new Map(stocks.map(stock => [stock.id, stock]));
      const out: IStockSyncResult[] = [];

      if (histEnd >= startDate && histDays.length > 0) {
        const gapTargets = stocks.filter(stock =>
          histDays.some(day => !(existingDaysByStockId.get(stock.id)?.has(day) ?? false)),
        );
        console.log(`历史缺口: ${gapTargets.length}/${stocks.length} 只股票回补 [${startDate} -> ${histEnd}]。`);
        out.push(...await runPerStockPool(gapTargets, startDate, histEnd));
      }
      else {
        console.log('历史缺口: 无（仅需最新交易日快照）。');
      }

      console.log(`拉取全市场快照（${spotDay}）：新浪优先，失败回退 AKTools spot_em...`);
      const stocksBySymbol = new Map(stocks.map(stock => [stock.symbol, stock]));
      let spotRows: ICandleWriteRow[];
      try {
        const sinaRows = await fetchSinaSpotPayload(stocks);
        spotRows = mapSinaSpotRowsToCandleRows(stocksBySymbol, sinaRows, parseYYYYMMDD(spotDay));
        if (spotRows.length === 0) {
          throw new Error('empty_result');
        }
        console.log(`快照来源: 新浪 ${spotRows.length} 只。`);
      }
      catch (error) {
        console.log(`新浪快照失败，回退 AKTools spot_em: ${getErrorMessage(error)}`);
        spotRows = mapSpotPayloadToCandleRows(
          stocksBySymbol,
          await fetchSpotPayload(),
          parseYYYYMMDD(spotDay),
        );
        console.log(`快照来源: AKTools ${spotRows.length} 只。`);
      }
      const spotRowByStockId = new Map(spotRows.map(row => [row.stockId, row]));
      let spotInserted = 0;
      for (const [stockId, row] of spotRowByStockId) {
        const owned = existingDaysByStockId.get(stockId) ?? new Set<string>();
        const already = owned.has(spotDay);
        if (!already) {
          owned.add(spotDay);
          existingDaysByStockId.set(stockId, owned);
          await enqueueRows([row]);
          spotInserted += 1;
        }
        out.push({
          symbol: stockById.get(stockId)?.symbol ?? stockId,
          provider: 'aktools',
          fetchedRows: 1,
          insertedRows: already ? 0 : 1,
          skippedExistingRows: already ? 1 : 0,
        });
      }
      console.log(`快照命中: ${spotRows.length} 只，新增 ${spotInserted} 根 K 线。`);

      // 快照未覆盖（停牌/退市等）：逐只补 spotDay，hist 无行即不入库，与旧行为一致。
      const uncovered = stocks.filter(stock =>
        !(existingDaysByStockId.get(stock.id)?.has(spotDay) ?? false) && !spotRowByStockId.has(stock.id),
      );
      if (uncovered.length > 0) {
        console.log(`快照未覆盖: ${uncovered.length} 只股票逐只补 ${spotDay}。`);
        out.push(...await runPerStockPool(uncovered, spotDay, spotDay));
      }
      return out;
    };

    let results: IStockSyncResult[];
    if (options.mode === 'incremental') {
      try {
        results = await runIncrementalSpotPath();
      }
      catch (error) {
        // 熔断意味着上游整体不可用：逐只回退只会重复撞墙，直接抛错让链路按契约中断。
        if (getErrorMessage(error).includes(AKTOOLS_BREAKER_TRIPPED)) {
          throw error;
        }
        console.log(`批量快照路径失败，回退逐只同步: ${getErrorMessage(error)}`);
        results = await runPerStockPool(pendingStocks, startDate, endDate);
      }
    }
    else {
      results = await runPerStockPool(pendingStocks, startDate, endDate);
    }

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
