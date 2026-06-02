import type {
  IStockHistoryCandle,
  IStockHistoryFetchResult,
  IStockHistoryTarget,
  IStockHistoryWindow,
} from './stock-history-sync-types.js';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function findLatestStockPoolFile(): Promise<string> {
  const tmpDir = path.resolve(process.cwd(), 'tmp');
  await mkdir(tmpDir, { recursive: true });
  const files = await readdir(tmpDir);
  const stockSyncFiles = files
    .filter(f => f.startsWith('stock-sync-') && f.endsWith('.json'))
    .sort((a, b) => b.localeCompare(a));

  if (stockSyncFiles.length === 0) {
    throw new Error('未在 tmp 目录下找到任何以 stock-sync- 开头的股票池文件，请先运行 sync-stocks.ts 脚本同步。');
  }

  return path.join(tmpDir, stockSyncFiles[0]!);
}

export async function hasLocalStockPoolFile(tmpDir = path.resolve(process.cwd(), 'tmp')): Promise<boolean> {
  await mkdir(tmpDir, { recursive: true });
  const files = await readdir(tmpDir);
  return files.some(f => f.startsWith('stock-sync-') && f.endsWith('.json'));
}

export function ensureLocalStockPoolFile(): void {
  const result = spawnSync('bun', ['dist/scripts/sync-stocks.js', '--mode', 'check'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    throw new Error(
      [
        '股票池文件缺失，自动同步股票池失败。',
        result.stdout?.trim(),
        result.stderr?.trim(),
      ].filter(Boolean).join('\n'),
    );
  }
}
const REQUEST_TIMEOUT_MS = 30000;
const BEIJING_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

interface IStockPoolFile {
  readonly requestedSymbols?: readonly unknown[];
  readonly data?: readonly IStockPoolQuote[];
}

interface IStockPoolQuote {
  readonly symbol?: unknown;
  readonly providerMetadata?: {
    readonly yahooSymbol?: unknown;
  };
}

interface IYahooFinanceClient {
  readonly chart: (symbol: string, query: {
    readonly period1: string;
    readonly period2: string;
    readonly interval: '1d';
  }) => Promise<IYahooChartResult>;
}

interface IYahooChartResult {
  readonly meta?: {
    readonly symbol?: unknown;
    readonly longName?: unknown;
    readonly shortName?: unknown;
  };
  readonly quotes?: readonly IYahooChartQuote[];
}

interface IYahooChartQuote {
  readonly date?: unknown;
  readonly open?: unknown;
  readonly high?: unknown;
  readonly low?: unknown;
  readonly close?: unknown;
  readonly volume?: unknown;
}

interface IBaostockJsonResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly target?: IStockHistoryTarget;
  readonly rows?: readonly IBaostockJsonRow[];
}

interface IBaostockJsonRow {
  readonly date?: unknown;
  readonly code?: unknown;
  readonly open?: unknown;
  readonly close?: unknown;
  readonly high?: unknown;
  readonly low?: unknown;
  readonly volume?: unknown;
}

const toCleanString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toBeijingDate = (date: Date): string => BEIJING_DATE_FORMATTER.format(date);

const toFiniteNumber = (value: unknown): number | null => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};

const toVolume = (value: unknown): bigint | null => {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    return null;
  }
  return BigInt(Math.trunc(numberValue));
};

const getStockSymbol = (value: unknown): string | null => {
  const raw = toCleanString(value);
  if (!raw) {
    return null;
  }
  const symbol = raw.replace(/\..*$/, '').replace(/^(?:sh|sz|bj)\.?/i, '');
  return /^\d{6}$/.test(symbol) ? symbol : null;
};

const inferExchange = (symbol: string): string | null => {
  if (/^(?:600|601|603|605|688|689|900)\d{3}$/.test(symbol)) {
    return 'sh';
  }
  if (/^(?:000|001|002|003|300|301|200)\d{3}$/.test(symbol)) {
    return 'sz';
  }
  if (/^[489]\d{5}$/.test(symbol)) {
    return 'bj';
  }
  return null;
};

export const toYahooSymbol = (symbol: string): string => {
  const exchange = inferExchange(symbol);
  if (exchange === 'sh') {
    return `${symbol}.SS`;
  }
  if (exchange === 'sz') {
    return `${symbol}.SZ`;
  }
  return `${symbol}.BJ`;
};

const toBaostockCode = (symbol: string): string => {
  const exchange = inferExchange(symbol);
  if (!exchange) {
    throw new Error(`无法识别交易所：${symbol}`);
  }
  return `${exchange}.${symbol}`;
};

const buildStockTarget = (
  symbol: string,
  name: string | null = null,
): IStockHistoryTarget | null => {
  const exchange = inferExchange(symbol);
  if (!exchange) {
    return null;
  }
  return {
    symbol,
    sourceSymbol: toYahooSymbol(symbol),
    exchange,
    name: name ?? `股票-${symbol}`,
    industry: '未分类',
  };
};

export const resolveThreeYearWindow = (asOf: Date): IStockHistoryWindow => {
  const endDate = toBeijingDate(asOf);
  const start = new Date(`${endDate}T12:00:00.000+08:00`);
  start.setFullYear(start.getFullYear() - 3);

  return {
    startDate: toBeijingDate(start),
    endDate,
  };
};

export const parseLocalStockPool = (payloadText: string): readonly IStockHistoryTarget[] => {
  const parsed = JSON.parse(payloadText) as IStockPoolFile;
  const quoteNames = new Map<string, string>();
  if (Array.isArray(parsed.data)) {
    for (const row of parsed.data) {
      const symbol = getStockSymbol(row.symbol);
      const yahooSymbol = toCleanString(row.providerMetadata?.yahooSymbol);
      if (symbol && yahooSymbol) {
        quoteNames.set(symbol, yahooSymbol);
      }
    }
  }

  if (!Array.isArray(parsed.requestedSymbols)) {
    throw new Error('本地股票池缺少 requestedSymbols');
  }

  const targets = new Map<string, IStockHistoryTarget>();
  for (const raw of parsed.requestedSymbols) {
    const symbol = getStockSymbol(raw);
    if (!symbol) {
      continue;
    }
    const target = buildStockTarget(symbol, quoteNames.get(symbol) ?? null);
    if (target) {
      targets.set(symbol, target);
    }
  }
  return [...targets.values()].sort((left, right) => left.symbol.localeCompare(right.symbol));
};

export const determineHistoryTargets = (
  allTargets: readonly IStockHistoryTarget[],
  limit: number,
  symbolFilter: readonly string[] = [],
): readonly IStockHistoryTarget[] => {
  const filterSet = new Set(symbolFilter);
  const filtered = filterSet.size > 0
    ? allTargets.filter(target => filterSet.has(target.symbol))
    : allTargets;

  return limit > 0 ? filtered.slice(0, limit) : filtered;
};

export const parseYahooChartPayload = (
  payload: IYahooChartResult,
  window: IStockHistoryWindow,
): readonly IStockHistoryCandle[] => {
  const candles: IStockHistoryCandle[] = [];
  for (const quote of payload.quotes ?? []) {
    if (!(quote.date instanceof Date)) {
      continue;
    }
    const tradingDay = toBeijingDate(quote.date);
    if (tradingDay < window.startDate || tradingDay > window.endDate) {
      continue;
    }
    const open = toFiniteNumber(quote.open);
    const high = toFiniteNumber(quote.high);
    const low = toFiniteNumber(quote.low);
    const close = toFiniteNumber(quote.close);
    const volume = toVolume(quote.volume);
    if (open === null || high === null || low === null || close === null || volume === null) {
      continue;
    }
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
      continue;
    }
    candles.push({ tradingDay, open, high, low, close, volume });
  }
  return candles.sort((left, right) => left.tradingDay.localeCompare(right.tradingDay));
};

export const parseBaostockRows = (
  rows: readonly IBaostockJsonRow[],
  window: IStockHistoryWindow,
): readonly IStockHistoryCandle[] => {
  const candles: IStockHistoryCandle[] = [];
  for (const row of rows) {
    const tradingDay = toCleanString(row.date);
    if (!tradingDay || tradingDay < window.startDate || tradingDay > window.endDate) {
      continue;
    }
    const open = toFiniteNumber(row.open);
    const high = toFiniteNumber(row.high);
    const low = toFiniteNumber(row.low);
    const close = toFiniteNumber(row.close);
    const volume = toVolume(row.volume);
    if (open === null || high === null || low === null || close === null || volume === null) {
      continue;
    }
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
      continue;
    }
    candles.push({ tradingDay, open, high, low, close, volume });
  }
  return candles.sort((left, right) => left.tradingDay.localeCompare(right.tradingDay));
};

const readCachedText = async (filePath: string): Promise<string | null> => {
  try {
    return await readFile(filePath, 'utf8');
  }
  catch {
    return null;
  }
};

const writeCachedText = async (filePath: string, payload: string): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, payload, 'utf8');
};

const createRawCachePath = (
  provider: 'yahoo' | 'baostock',
  symbol: string,
  window: IStockHistoryWindow,
): string => path.resolve(
  process.cwd(),
  'tmp',
  'stock-history-raw',
  provider,
  `${window.startDate}_${window.endDate}`,
  `${symbol}.json`,
);

const loadYahooFinanceClient = async (): Promise<IYahooFinanceClient> => {
  const { default: YahooFinance } = await import('yahoo-finance2');
  return new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] }) as IYahooFinanceClient;
};

const toSerializableYahooPayload = (payload: IYahooChartResult): string => JSON.stringify(payload, null, 2);

const parseCachedYahooPayload = (text: string): IYahooChartResult => {
  const parsed = JSON.parse(text) as IYahooChartResult;
  return {
    ...parsed,
    quotes: (parsed.quotes ?? []).map(quote => ({
      ...quote,
      date: typeof quote.date === 'string' ? new Date(quote.date) : quote.date,
    })),
  };
};

const runBaostockPython = async (
  target: IStockHistoryTarget,
  window: IStockHistoryWindow,
): Promise<IBaostockJsonResult> => {
  const code = toBaostockCode(target.symbol);
  const script = [
    'import json, sys',
    'import baostock as bs',
    `code=${JSON.stringify(code)}`,
    `start_date=${JSON.stringify(window.startDate)}`,
    `end_date=${JSON.stringify(window.endDate)}`,
    'lg=bs.login()',
    'if lg.error_code != "0":',
    '    print(json.dumps({"ok": False, "error": lg.error_msg}, ensure_ascii=False))',
    '    sys.exit(0)',
    'rows=[]',
    'try:',
    '    fields="date,code,open,close,high,low,volume,amount,turn,pctChg,isST"',
    '    rs=bs.query_history_k_data_plus(code, fields, start_date=start_date, end_date=end_date, frequency="d", adjustflag="3")',
    '    if rs.error_code != "0":',
    '        print(json.dumps({"ok": False, "error": rs.error_msg}, ensure_ascii=False))',
    '        sys.exit(0)',
    '    while rs.next():',
    '        row=rs.get_row_data()',
    '        rows.append({"date": row[0], "code": row[1], "open": row[2], "close": row[3], "high": row[4], "low": row[5], "volume": row[6]})',
    '    print(json.dumps({"ok": True, "rows": rows}, ensure_ascii=False))',
    'finally:',
    '    bs.logout()',
  ].join('\n');

  return new Promise((resolve) => {
    const proc = spawn('python3', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let timeout: NodeJS.Timeout;
    const finish = (result: IBaostockJsonResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    let stdout = '';
    let stderr = '';
    timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      finish({ ok: false, error: 'Baostock 超时' });
    }, REQUEST_TIMEOUT_MS);

    proc.stdout.on('data', chunk => stdout += String(chunk));
    proc.stderr.on('data', chunk => stderr += String(chunk));
    proc.on('error', (error) => {
      finish({ ok: false, error: error.message });
    });
    proc.on('close', (exitCode) => {
      if (exitCode !== 0) {
        finish({ ok: false, error: stderr || `Baostock 进程退出：${exitCode}` });
        return;
      }
      const lastLine = stdout.trim().split(/\r?\n/).at(-1);
      if (!lastLine) {
        finish({ ok: false, error: 'Baostock 无返回' });
        return;
      }
      finish(JSON.parse(lastLine) as IBaostockJsonResult);
    });
  });
};

export class StockHistorySource {
  public async fetchUniverse(): Promise<readonly IStockHistoryTarget[]> {
    const latestFile = await findLatestStockPoolFile();
    return parseLocalStockPool(await readFile(latestFile, 'utf8'));
  }

  public async fetchCandles(
    target: IStockHistoryTarget,
    window: IStockHistoryWindow,
  ): Promise<IStockHistoryFetchResult> {
    try {
      return await this.fetchYahooCandles(target, window);
    }
    catch {
      return this.fetchBaostockCandles(target, window);
    }
  }

  private async fetchYahooCandles(
    target: IStockHistoryTarget,
    window: IStockHistoryWindow,
  ): Promise<IStockHistoryFetchResult> {
    const cachePath = createRawCachePath('yahoo', target.symbol, window);
    const cached = await readCachedText(cachePath);
    const payload = cached === null
      ? await this.loadYahooAndCache(target, window, cachePath)
      : parseCachedYahooPayload(cached);
    const candles = parseYahooChartPayload(payload, window);
    if (candles.length === 0) {
      throw new Error('Yahoo 无行情');
    }
    const name = toCleanString(payload.meta?.longName) ?? toCleanString(payload.meta?.shortName);
    return {
      target: {
        ...target,
        name: name ?? target.name,
        sourceSymbol: toCleanString(payload.meta?.symbol) ?? target.sourceSymbol,
      },
      provider: 'Yahoo',
      candles,
    };
  }

  private async loadYahooAndCache(
    target: IStockHistoryTarget,
    window: IStockHistoryWindow,
    cachePath: string,
  ): Promise<IYahooChartResult> {
    const client = await loadYahooFinanceClient();

    // Yahoo Finance API 要求 period2 必须大于 period1，如果只取单日，把 period2 延后一天
    let period2 = window.endDate;
    if (window.startDate === window.endDate) {
      const date = new Date(`${window.endDate}T12:00:00.000+08:00`);
      date.setDate(date.getDate() + 1);
      const yyyy = date.getFullYear();
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');
      period2 = `${yyyy}-${mm}-${dd}`;
    }

    const payload = await client.chart(target.sourceSymbol, {
      period1: window.startDate,
      period2,
      interval: '1d',
    });
    await writeCachedText(cachePath, toSerializableYahooPayload(payload));
    return payload;
  }

  private async fetchBaostockCandles(
    target: IStockHistoryTarget,
    window: IStockHistoryWindow,
  ): Promise<IStockHistoryFetchResult> {
    const cachePath = createRawCachePath('baostock', target.symbol, window);
    const cached = await readCachedText(cachePath);
    const cachedPayload = cached === null ? null : JSON.parse(cached) as IBaostockJsonResult;
    const payload = cachedPayload?.ok ? cachedPayload : await runBaostockPython(target, window);
    if (payload.ok && !cachedPayload?.ok) {
      await writeCachedText(cachePath, JSON.stringify(payload, null, 2));
    }
    if (!payload.ok) {
      throw new Error(payload.error ?? 'Baostock 拉取失败');
    }
    const candles = parseBaostockRows(payload.rows ?? [], window);
    return {
      target: payload.target ?? target,
      provider: 'Baostock',
      candles,
    };
  }
}
