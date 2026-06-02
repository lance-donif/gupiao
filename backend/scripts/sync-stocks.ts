import { writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import { createBackendIntegrationConfig } from '../src/services/integration-config.js';

const LOCAL_STOCK_POOL_PREFIX = 'stock-sync-';

export interface IAkToolsStockUniverseRecord {
  readonly code?: unknown;
  readonly symbol?: unknown;
  readonly name?: unknown;
  readonly stock_name?: unknown;
  readonly '代码'?: unknown;
  readonly '名称'?: unknown;
}

export interface IStockSyncSummary {
  readonly syncedAtBeijing: string;
  readonly totalSymbols: number;
  readonly successCount: number;
  readonly failedCount: number;
  readonly failedSymbols: readonly string[];
}

export interface IYahooValidationPayload extends IStockSyncSummary {
  readonly requestedSymbols: readonly string[];
  readonly data: readonly unknown[];
}

interface IYahooQuote {
  readonly regularMarketPrice?: number;
  readonly regularMarketTime?: Date | string | number | null;
  readonly currency?: string | null;
}

interface IYahooBatchFetchResultItem {
  readonly symbol: string;
  readonly price: number;
  readonly currency: string;
  readonly marketTime: string;
  readonly capturedAt: string;
  readonly providerMetadata: {
    readonly yahooSymbol: string;
    readonly source: 'yahoo-finance';
  };
}

interface IYahooBatchFetchSuccessResult {
  readonly status: 'success';
  readonly items: readonly IYahooBatchFetchResultItem[];
}

interface IYahooBatchFetchFailureResult {
  readonly status: 'failure';
  readonly message: string;
}

type IYahooBatchFetchResult = IYahooBatchFetchSuccessResult | IYahooBatchFetchFailureResult;

const A_SHARE_SYMBOL_PATTERN = /^(?:60\d{4}|68\d{4}|00\d{4}|30\d{4})$/;
const DEFAULT_UNIVERSE_ENDPOINT = '/api/public/stock_info_a_code_name';
const DEFAULT_FAILURE_SAMPLE_SIZE = 100;
const YAHOO_BATCH_SIZE = 50;

const toTrimmedString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeStockSymbol = (value: unknown): string | null => {
  const raw = toTrimmedString(value);
  if (!raw) {
    return null;
  }

  const cleaned = raw.replace(/\..*$/, '').replace(/^sh|^sz|^bj/i, '').trim();
  return A_SHARE_SYMBOL_PATTERN.test(cleaned) ? cleaned : null;
};

export const parseStockUniverseRecords = (records: readonly IAkToolsStockUniverseRecord[]): string[] => {
  const deduplicated = new Set<string>();

  for (const record of records) {
    const symbol = normalizeStockSymbol(
      record.code
      ?? record['代码']
      ?? record.symbol,
    );

    if (symbol) {
      deduplicated.add(symbol);
    }
  }

  return [...deduplicated].sort((left, right) => left.localeCompare(right));
};

export const extractStockUniverseFromAkToolsResponse = (payload: unknown): string[] => {
  if (Array.isArray(payload)) {
    return parseStockUniverseRecords(payload as readonly IAkToolsStockUniverseRecord[]);
  }

  if (payload && typeof payload === 'object' && Array.isArray((payload as { readonly data?: unknown }).data)) {
    return parseStockUniverseRecords((payload as { readonly data: readonly IAkToolsStockUniverseRecord[] }).data);
  }

  throw new Error('AKTools 股票列表响应格式无效');
};

export const determineSymbolsToSync = (symbols: readonly string[], limit?: number): string[] => {
  if (!limit || limit <= 0) {
    return [...symbols];
  }

  return symbols.slice(0, limit);
};

export const createYahooValidationPayload = (input: {
  readonly syncedAtBeijing: string;
  readonly totalSymbols: number;
  readonly requestedSymbols: readonly string[];
  readonly successItems: readonly unknown[];
}): IYahooValidationPayload => {
  const returnedSymbols = new Set(
    input.successItems
      .map((item) => (item as { readonly symbol?: unknown }).symbol)
      .map((symbol) => normalizeStockSymbol(symbol))
      .filter((symbol): symbol is string => symbol !== null),
  );

  const failedSymbols = input.requestedSymbols.filter((symbol) => !returnedSymbols.has(symbol));

  return {
    syncedAtBeijing: input.syncedAtBeijing,
    totalSymbols: input.totalSymbols,
    successCount: input.successItems.length,
    failedCount: failedSymbols.length,
    failedSymbols: failedSymbols.slice(0, DEFAULT_FAILURE_SAMPLE_SIZE),
    requestedSymbols: [...input.requestedSymbols],
    data: [...input.successItems],
  };
};

export const buildStockSyncSummary = (payload: IYahooValidationPayload): IStockSyncSummary => {
  return {
    syncedAtBeijing: payload.syncedAtBeijing,
    totalSymbols: payload.totalSymbols,
    successCount: payload.successCount,
    failedCount: payload.failedCount,
    failedSymbols: payload.failedSymbols,
  };
};

const convertToYahooSymbol = (symbol: string): string => {
  if (symbol.startsWith('6')) {
    return `${symbol}.SS`;
  }

  return `${symbol}.SZ`;
};

const toDate = (value: Date | string | number | null | undefined): Date | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
};

const chunkSymbols = (symbols: readonly string[], batchSize: number): string[][] => {
  const chunks: string[][] = [];
  for (let index = 0; index < symbols.length; index += batchSize) {
    chunks.push(symbols.slice(index, index + batchSize));
  }
  return chunks;
};

async function fetchYahooBatchQuotes(symbols: readonly string[]): Promise<IYahooBatchFetchResult> {
  if (process.env.FAST_SYNC === 'true') {
    console.log('⚡ 激活极速同步模式：跳过缓慢的 Yahoo quote 校验，直接生成全量股票映射！');
    return {
      status: 'success',
      items: [],
    };
  }

  const { default: YahooFinance } = await import('yahoo-finance2');
  const client = new YahooFinance({
    suppressNotices: ['yahooSurvey'],
  });
  const capturedAt = new Date();
  const items: IYahooBatchFetchResultItem[] = [];

  try {
    for (const batch of chunkSymbols(symbols, YAHOO_BATCH_SIZE)) {
      const yahooSymbols = batch.map(convertToYahooSymbol);
      const quoteResults = await Promise.all(
        yahooSymbols.map(async (yahooSymbol, index) => {
          try {
            const quote = await client.quote(yahooSymbol, {
              fields: ['regularMarketPrice', 'regularMarketTime', 'currency'],
            }) as IYahooQuote;

            return {
              symbol: batch[index] ?? yahooSymbol,
              price: typeof quote.regularMarketPrice === 'number' ? quote.regularMarketPrice : 0,
              currency: quote.currency ?? 'CNY',
              marketTime: toBeijingTime(toDate(quote.regularMarketTime)?.toISOString() ?? capturedAt.toISOString()),
              capturedAt: toBeijingTime(capturedAt.toISOString()),
              providerMetadata: {
                yahooSymbol,
                source: 'yahoo-finance' as const,
              },
            } satisfies IYahooBatchFetchResultItem;
          } catch {
            return null;
          }
        }),
      );

      items.push(...quoteResults.filter((item): item is IYahooBatchFetchResultItem => item !== null));
    }

    return {
      status: 'success',
      items,
    };
  } catch (error) {
    return {
      status: 'failure',
      message: error instanceof Error ? error.message : 'unknown yahoo batch fetch failure',
    };
  }
}

// 保存到临时文件（只保留最新）
export async function saveStockSyncFile(data: unknown, tmpDir = path.resolve(process.cwd(), 'tmp')): Promise<string> {
  await mkdir(tmpDir, { recursive: true });

  // 删除旧的 stock-sync-*.json
  const files = await readdir(tmpDir);
  for (const f of files) {
    if (f.startsWith(LOCAL_STOCK_POOL_PREFIX) && f.endsWith('.json')) {
      await unlink(path.join(tmpDir, f));
    }
  }

  const fileName = `${LOCAL_STOCK_POOL_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
  const filePath = path.join(tmpDir, fileName);
  await writeFile(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

// 检查 tmp 目录下是否已有有效股票池文件
export async function hasStockPoolFile(tmpDir = path.resolve(process.cwd(), 'tmp')): Promise<boolean> {
  await mkdir(tmpDir, { recursive: true });
  const files = await readdir(tmpDir);
  return files.some(f => f.startsWith(LOCAL_STOCK_POOL_PREFIX) && f.endsWith('.json'));
}

async function fetchStockUniverse(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const config = createBackendIntegrationConfig();
  const response = await fetchImpl(`${config.aktoolsBaseUrl}${DEFAULT_UNIVERSE_ENDPOINT}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`获取全量股票列表失败: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  const symbols = extractStockUniverseFromAkToolsResponse(payload);
  if (symbols.length === 0) {
    throw new Error('AKTools 返回的全量股票列表为空');
  }

  return symbols;
}

// UTC 转北京时间
const toBeijingTime = (isoString: string): string => {
  const date = new Date(isoString);
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).replace(/\//g, '-');
};

async function runFullSync(): Promise<void> {
  console.log('正在从 Yahoo Finance 同步股票数据...');
  console.log('正在加载全量股票列表...');
  const allSymbols = await fetchStockUniverse();
  const limit = Number.parseInt(process.env.STOCK_SYNC_LIMIT ?? '0', 10);
  const symbols = determineSymbolsToSync(allSymbols, Number.isFinite(limit) ? limit : 0);
  console.log(`共 ${symbols.length} 只股票（全量 ${allSymbols.length} 只）`);

  console.log('正在同步...');
  const result = await fetchYahooBatchQuotes(symbols);

  const payload = toValidationPayload(result, symbols);
  const summary = buildStockSyncSummary(payload);

  console.log(`\n同步结果:`);
  console.log(`  成功: ${summary.successCount}/${symbols.length}`);
  console.log(`  失败: ${summary.failedCount}/${symbols.length}`);

  if (summary.failedSymbols.length > 0) {
    console.log(`  失败股票: ${summary.failedSymbols.slice(0, 10).join(', ')}${summary.failedSymbols.length > 10 ? '...' : ''}`);
  }

  const filePath = await saveStockSyncFile(payload);
  console.log(`\n已保存到: ${filePath}`);

  if (result.status === 'success' && result.items.length > 0) {
    console.log('\n前 5 条数据:');
    for (const item of result.items.slice(0, 5)) {
      console.log(`  ${item.symbol}: ¥${item.price} (${item.currency}) @ ${item.marketTime}`);
    }
  }
}

async function main() {
  const modeIndex = process.argv.indexOf('--mode');
  const mode = modeIndex !== -1 ? process.argv[modeIndex + 1] : 'sync';

  if (mode === 'check') {
    // --mode check：文件已存在则直接退出 0（幂等）；否则做完整同步
    const alreadyHasFile = await hasStockPoolFile();
    if (alreadyHasFile) {
      console.log('股票池文件已存在，跳过同步。');
      return;
    }
    console.log('股票池文件不存在，开始同步...');
  }

  try {
    await runFullSync();
  } catch (error) {
    console.error('同步失败:', error);
    process.exitCode = 1;
  }
}

const toValidationPayload = (
  result: IYahooBatchFetchResult,
  requestedSymbols: readonly string[],
): IYahooValidationPayload => {
  const syncedAtBeijing = toBeijingTime(new Date().toISOString());

  if (result.status === 'success') {
    return createYahooValidationPayload({
      syncedAtBeijing,
      totalSymbols: requestedSymbols.length,
      requestedSymbols,
      successItems: result.items,
    });
  }

  return {
    syncedAtBeijing,
    totalSymbols: requestedSymbols.length,
    successCount: 0,
    failedCount: requestedSymbols.length,
    failedSymbols: requestedSymbols.slice(0, DEFAULT_FAILURE_SAMPLE_SIZE),
    requestedSymbols: [...requestedSymbols],
    data: [],
  };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
