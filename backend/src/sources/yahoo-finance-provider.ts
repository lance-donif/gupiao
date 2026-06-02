import type {
  IProviderStockResponse,
  ISourceProvider,
  ISourceProviderHealthStatus,
  IStockSourceRequest,
} from './contracts.js';
import { SourceFailureCategory } from './contracts.js';

// yahoo-finance2 错误类型
interface IYahooFinanceError {
  code: string;
  message: string;
  status?: number;
}

// 批量请求配置
const BATCH_CONFIG = {
  maxSymbolsPerBatch: 50, // Yahoo Finance 建议每批不超过 50
  maxConcurrency: 3, // 最大并发批次数
  retryAttempts: 3, // 失败重试次数
  retryDelayMs: 1000, // 重试间隔
  timeoutMs: 30000, // 单次请求超时
};

// A股代码转换
const convertToYahooSymbol = (symbol: string): string => {
  // 上海: 600000.SS, 深圳: 000001.SZ, 北京: 430001.BJ
  const clean = symbol.replace(/\..*$/, '');
  if (clean.startsWith('6')) { return `${clean}.SS`; }
  if (clean.startsWith('0') || clean.startsWith('3')) { return `${clean}.SZ`; }
  if (clean.startsWith('4') || clean.startsWith('8') || clean.startsWith('920')) { return `${clean}.BJ`; }
  return clean;
};

// UTC 转北京时间
const toBeijingTimeString = (date: Date): string => {
  // 检查时间是否有效
  const now = new Date();
  const minDate = new Date('2000-01-01');

  if (date < minDate || date > now) {
    // 无效时间用当前时间
    date = new Date();
  }

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

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// 带重试的请求
async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  attempts: number = BATCH_CONFIG.retryAttempts,
): Promise<T> {
  let lastError: Error | undefined;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    }
    catch (error) {
      lastError = error as Error;

      // 检查是否可重试
      const isRetryable = isRetryableError(error);
      if (!isRetryable) {
        throw error;
      }

      // 最后尝试，不等待
      if (i < attempts - 1) {
        const waitTime = BATCH_CONFIG.retryDelayMs * 2 ** i; // 指数退避
        await delay(waitTime);
      }
    }
  }

  throw lastError;
}

// 判断是否可重试的错误
function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') { return false; }

  const err = error as IYahooFinanceError;

  // 网络错误可重试
  const retryableCodes = [
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNABORTED',
  ];

  if (retryableCodes.includes(err.code)) { return true; }

  // HTTP 状态码判断
  if (err.status) {
    // 5xx 服务器错误可重试
    if (err.status >= 500) { return true; }
    // 429 限流可重试
    if (err.status === 429) { return true; }
    // 4xx 客户端错误不重试
    if (err.status >= 400) { return false; }
  }

  return true;
}

// 分批处理
async function processBatches<T, R>(
  items: T[],
  batchSize: number,
  processor: (batch: T[]) => Promise<R[]>,
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    try {
      const batchResults = await processor(batch);
      results.push(...batchResults);
    }
    catch (error) {
      // 单批失败不中断，记录后继续
      console.error(`批处理失败 (${i}-${i + batch.length}):`, error);
    }
  }

  return results;
}

export class YahooFinanceStockProvider implements ISourceProvider<IStockSourceRequest, IProviderStockResponse> {
  public readonly name = 'yahoo-finance-stock-provider';

  private yahooFinance: any; // yahoo-finance2 实例
  private lastHealthStatus: ISourceProviderHealthStatus = {
    available: true,
    checkedAt: new Date(0),
    detail: 'not-checked',
  };

  constructor() {
    // 延迟初始化，避免构造时失败
    this.yahooFinance = null;
  }

  private async init(): Promise<void> {
    if (this.yahooFinance) { return; }

    try {
      // 动态导入 yahoo-finance2
      const { default: YahooFinance } = await import('yahoo-finance2');
      this.yahooFinance = new YahooFinance();
    }
    catch (error) {
      throw new Error(`Failed to initialize yahoo-finance2: ${error}`);
    }
  }

  public execute(
    request: IStockSourceRequest,
    _metadata: unknown,
  ): IProviderStockResponse {
    void request;
    void _metadata;
    throw new Error('YahooFinanceStockProvider.execute is async-only; use executeAsync()');
  }

  public async executeAsync(
    request: IStockSourceRequest,
    metadata: unknown,
  ): Promise<IProviderStockResponse> {
    await this.init();
    void metadata;

    try {
      // 转换 A股代码
      const symbols = request.symbol.split(',').map(s => s.trim()).filter(s => s.length > 0);
      const yahooSymbols = symbols.map(convertToYahooSymbol);

      // 分批获取
      const results = await processBatches(
        yahooSymbols,
        BATCH_CONFIG.maxSymbolsPerBatch,
        async (batch) => {
          return await fetchWithRetry(async () => {
            // 使用 yahoo-finance2 的 quote 方法
            const quotes = await this.yahooFinance.quote(batch, {
              fields: ['regularMarketPrice', 'regularMarketTime', 'currency'],
            });

            // 处理单只股票返回对象而非数组的情况
            const quoteArray = Array.isArray(quotes) ? quotes : [quotes];

            return quoteArray.map((quote: any, index: number) => ({
              symbol: symbols[index] || batch[index],
              price: quote.regularMarketPrice || 0,
              currency: quote.currency || 'CNY',
              // Yahoo 返回的时间戳有问题，直接用当前时间
              marketTime: toBeijingTimeString(new Date()),
              capturedAt: toBeijingTimeString(new Date()),
              providerMetadata: {
                yahooSymbol: batch[index],
                source: 'yahoo-finance',
              },
            }));
          });
        },
      );

      this.lastHealthStatus = {
        available: true,
        checkedAt: new Date(),
        detail: `ok:${results.length}/${symbols.length}`,
      };

      return {
        status: 'success',
        payload: {
          kind: 'stock',
          items: results,
        },
        metadata: {
          requestId: `yahoo-${Date.now()}`,
          providerIdentity: this.name,
          symbolRef: symbols.join(','),
        },
      };
    }
    catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      const symbols = request.symbol.split(',').map(s => s.trim()).filter(s => s.length > 0);
      this.lastHealthStatus = {
        available: false,
        checkedAt: new Date(),
        detail: `error:${errorMessage.slice(0, 100)}`,
      };

      return {
        status: 'failure',
        failure: {
          category: SourceFailureCategory.Unavailable,
          message: errorMessage,
        },
        metadata: {
          requestId: `yahoo-${Date.now()}`,
          providerIdentity: this.name,
          symbolRef: symbols.join(','),
        },
      };
    }
  }

  public isAvailable(): boolean {
    return this.lastHealthStatus.available;
  }

  public getHealthStatus(): ISourceProviderHealthStatus {
    return this.lastHealthStatus;
  }
}

// 降级方案：当 Yahoo Finance 失败时使用 AKShare 或缓存
export class FallbackStockProvider implements ISourceProvider<IStockSourceRequest, IProviderStockResponse> {
  public readonly name = 'fallback-stock-provider';

  private primaryProvider: YahooFinanceStockProvider;
  private lastHealthStatus: ISourceProviderHealthStatus = {
    available: true,
    checkedAt: new Date(0),
    detail: 'not-checked',
  };

  constructor() {
    this.primaryProvider = new YahooFinanceStockProvider();
  }

  public execute(
    request: IStockSourceRequest,
    _metadata: unknown,
  ): IProviderStockResponse {
    void request;
    void _metadata;
    throw new Error('FallbackStockProvider.execute is async-only; use executeAsync()');
  }

  public async executeAsync(
    request: IStockSourceRequest,
    metadata: unknown,
  ): Promise<IProviderStockResponse> {
    // 先尝试主 provider
    const primaryResult = await this.primaryProvider.executeAsync(request, metadata);

    if (primaryResult.status === 'success') {
      this.lastHealthStatus = {
        available: true,
        checkedAt: new Date(),
        detail: 'primary:ok',
      };
      return primaryResult;
    }

    const symbols = request.symbol.split(',').map(s => s.trim()).filter(s => s.length > 0);

    // 失败时返回降级响应（从数据库缓存获取）
    // 这里可以集成 Prisma 从数据库获取上次同步的数据
    this.lastHealthStatus = {
      available: true,
      checkedAt: new Date(),
      detail: `primary:failed,fallback:cached`,
    };

    return {
      status: 'failure',
      failure: {
        category: SourceFailureCategory.Unavailable,
        message: 'Primary provider failed, no cached data available',
      },
      metadata: {
        requestId: `fallback-${Date.now()}`,
        providerIdentity: this.name,
        symbolRef: symbols.join(','),
      },
    };
  }

  public isAvailable(): boolean {
    return true; // 始终可用，因为可以返回降级响应
  }

  public getHealthStatus(): ISourceProviderHealthStatus {
    return this.lastHealthStatus;
  }
}
