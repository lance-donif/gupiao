import { describe, expect, it } from 'vitest';

import {
  AkShareMarketSource,
  FixedWindowRateLimiter,
  SourceFailureCategory,
  TavilyNewsSource,
  YahooFinanceMarketSource,
  withRateLimit,
  type INewsSource,
  type INewsSourceArticle,
  type INewsSourceFetchSuccess,
  type INewsSourceRequest,
  type IProviderFailurePayload,
  type IProviderNewsArticlePayload,
  type IProviderNewsPayload,
  type IProviderNewsResponse,
  type IProviderRequestMetadata,
  type IProviderStockQuotePayload,
  type IProviderStockQuotesPayload,
  type IProviderStockResponse,
  type ISourceProvider,
  type IStockSource,
  type IStockSourceQuote,
  type IStockSourceRequest,
  type IRateLimiterClock,
} from '../../../src/index.js';

class FixedClock implements IRateLimiterClock {
  public constructor(private current: number) {}

  public now(): number {
    return this.current;
  }

  public set(now: number): void {
    this.current = now;
  }
}

class StubNewsProvider implements ISourceProvider<INewsSourceRequest, IProviderNewsResponse> {
  public readonly name = 'stub-news-provider';

  public constructor(private readonly response: IProviderNewsResponse) {}

  public execute(
    request: INewsSourceRequest,
    metadata: IProviderRequestMetadata,
  ): IProviderNewsResponse {
    void request;
    void metadata;
    return this.response;
  }

  public isAvailable(): boolean {
    return true;
  }

  public getHealthStatus(): {
    readonly available: boolean;
    readonly checkedAt: Date;
    readonly detail: string;
  } {
    return {
      available: true,
      checkedAt: new Date('2026-03-17T08:00:00.000Z'),
      detail: 'ok',
    } as const;
  }
}

class StubStockProvider implements ISourceProvider<IStockSourceRequest, IProviderStockResponse> {
  public readonly name = 'stub-stock-provider';

  public constructor(private readonly response: IProviderStockResponse) {}

  public execute(
    request: IStockSourceRequest,
    metadata: IProviderRequestMetadata,
  ): IProviderStockResponse {
    void request;
    void metadata;
    return this.response;
  }

  public isAvailable(): boolean {
    return true;
  }

  public getHealthStatus(): {
    readonly available: boolean;
    readonly checkedAt: Date;
    readonly detail: string;
  } {
    return {
      available: true,
      checkedAt: new Date('2026-03-17T08:00:00.000Z'),
      detail: 'ok',
    } as const;
  }
}

const createNewsArticlePayload = (): IProviderNewsArticlePayload => {
  return {
    id: 'news-1',
    title: '银行板块异动',
    summary: '多家银行股早盘上涨。',
    url: 'https://example.com/news-1',
    publishedAt: '2026-03-17T09:30:00.000Z',
    capturedAt: '2026-03-17T09:31:00.000Z',
    providerMetadata: {
      query: '银行',
      relevanceScore: 0.82,
    },
  };
};

const createStockQuotePayload = (): IProviderStockQuotePayload => {
  return {
    symbol: '600000.SH',
    price: 12.34,
    currency: 'CNY',
    marketTime: '2026-03-17T15:00:00.000Z',
    capturedAt: '2026-03-17T15:00:01.000Z',
    providerMetadata: {
      exchange: 'SSE',
      interval: '1d',
    },
  };
};

const createNewsResponse = (): INewsSourceFetchSuccess => {
  const payload: IProviderNewsPayload = {
    kind: 'news',
    items: [createNewsArticlePayload()],
  };

  const provider = new StubNewsProvider({
    status: 'success',
    payload,
    metadata: {
      requestId: 'req-news-1',
      providerIdentity: 'stub-news-provider',
      queryRef: '银行',
    },
  });

  const result = new TavilyNewsSource(provider).fetch({
    query: '银行',
    asOf: new Date('2026-03-17T09:35:00.000Z'),
    limit: 10,
    timeWindow: {
      start: new Date('2026-03-17T09:00:00.000Z'),
      end: new Date('2026-03-17T10:00:00.000Z'),
    },
  });

  expect(result.status).toBe('success');

  if (result.status !== 'success') {
    throw new Error('Expected news source success result');
  }

  return result;
};

const createStockResponse = (): readonly IStockSourceQuote[] => {
  const payload: IProviderStockQuotesPayload = {
    kind: 'stock',
    items: [createStockQuotePayload()],
  };

  const provider = new StubStockProvider({
    status: 'success',
    payload,
    metadata: {
      requestId: 'req-stock-1',
      providerIdentity: 'stub-stock-provider',
      symbolRef: '600000.SH',
    },
  });

  const result = new YahooFinanceMarketSource(provider).fetch({
    symbol: '600000.SH',
    asOf: new Date('2026-03-17T15:01:00.000Z'),
    limit: 1,
    timeWindow: {
      start: new Date('2026-03-17T09:30:00.000Z'),
      end: new Date('2026-03-17T15:00:00.000Z'),
    },
  });

  expect(result.status).toBe('success');

  if (result.status !== 'success') {
    throw new Error('Expected stock source success result');
  }

  return result.items;
};

describe('source contracts', () => {
  it('normalizes news providers into a news-specific result contract with trace metadata', () => {
    const result = createNewsResponse();

    expect(result.status).toBe('success');
    expect(result.kind).toBe('news');
    expect(result.items).toHaveLength(1);

    const article: INewsSourceArticle | undefined = result.items[0];
    expect(article).toBeDefined();

    if (!article) {
      throw new Error('Expected a normalized news article');
    }

    expect(article).toMatchObject({
      title: '银行板块异动',
      summary: '多家银行股早盘上涨。',
      url: 'https://example.com/news-1',
    });
    expect(article.publishedAt).toEqual(new Date('2026-03-17T09:30:00.000Z'));
    expect(article.capturedAt).toEqual(new Date('2026-03-17T09:31:00.000Z'));
    expect(article.metadata).toMatchObject({
      provider: 'stub-news-provider',
      query: '银行',
      recordId: 'news-1',
      requestId: 'req-news-1',
      providerIdentity: 'stub-news-provider',
      queryRef: '银行',
    });
    expect(result.request).toMatchObject({
      query: '银行',
      limit: 10,
    });
  });

  it('normalizes market providers into a stock-specific result contract without reusing article shape', () => {
    const quotes = createStockResponse();

    expect(quotes).toHaveLength(1);

    const quote: IStockSourceQuote | undefined = quotes[0];
    expect(quote).toBeDefined();

    if (!quote) {
      throw new Error('Expected a normalized stock quote');
    }

    expect(quote).toMatchObject({
      symbol: '600000.SH',
      price: 12.34,
      currency: 'CNY',
    });
    expect(quote.marketTime).toEqual(new Date('2026-03-17T15:00:00.000Z'));
    expect(quote.capturedAt).toEqual(new Date('2026-03-17T15:00:01.000Z'));
    expect(quote.metadata).toMatchObject({
      provider: 'stub-stock-provider',
      symbol: '600000.SH',
      requestId: 'req-stock-1',
      providerIdentity: 'stub-stock-provider',
      symbolRef: '600000.SH',
    });
  });

  it('preserves time-window and as-of semantics in the unified request contracts', () => {
    const newsSource: INewsSource = new TavilyNewsSource(new StubNewsProvider({
      status: 'success',
      payload: {
        kind: 'news',
        items: [],
      },
      metadata: {
        requestId: 'req-news-empty',
        providerIdentity: 'stub-news-provider',
      },
    }));
    const stockSource: IStockSource = new AkShareMarketSource(new StubStockProvider({
      status: 'success',
      payload: {
        kind: 'stock',
        items: [],
      },
      metadata: {
        requestId: 'req-stock-empty',
        providerIdentity: 'stub-stock-provider',
      },
    }));

    const newsRequest: INewsSourceRequest = {
      query: '券商',
      limit: 5,
      asOf: new Date('2026-03-17T10:00:00.000Z'),
      timeWindow: {
        start: new Date('2026-03-17T08:00:00.000Z'),
        end: new Date('2026-03-17T10:00:00.000Z'),
      },
    };
    const stockRequest: IStockSourceRequest = {
      symbol: '000001.SZ',
      limit: 20,
      asOf: new Date('2026-03-17T15:00:00.000Z'),
      timeWindow: {
        start: new Date('2026-03-01T09:30:00.000Z'),
        end: new Date('2026-03-17T15:00:00.000Z'),
      },
    };

    const newsResult = newsSource.fetch(newsRequest);
    const stockResult = stockSource.fetch(stockRequest);

    expect(newsResult.status).toBe('success');
    expect(stockResult.status).toBe('success');

    if (newsResult.status !== 'success' || stockResult.status !== 'success') {
      throw new Error('Expected request contract checks to succeed');
    }

    expect(newsResult.request).toEqual(newsRequest);
    expect(stockResult.request).toEqual(stockRequest);
  });

  it('standardizes provider failures into machine-readable categories', () => {
    const failurePayloads: readonly IProviderFailurePayload[] = [
      {
        category: SourceFailureCategory.Unavailable,
        message: 'provider down',
      },
      {
        category: SourceFailureCategory.RateLimited,
        message: 'too many requests',
      },
      {
        category: SourceFailureCategory.BadPayload,
        message: 'schema mismatch',
      },
      {
        category: SourceFailureCategory.EmptyResult,
        message: 'no rows',
      },
    ];

    const results = failurePayloads.map((payload) => {
      const provider = new StubNewsProvider({
        status: 'failure',
        failure: payload,
        metadata: {
          requestId: `req-${payload.category}`,
          providerIdentity: 'stub-news-provider',
        },
      });

      return new TavilyNewsSource(provider).fetch({
        query: '失败场景',
      });
    });

    expect(results.map((result) => result.status)).toEqual([
      'failure',
      'failure',
      'failure',
      'failure',
    ]);
    const failures = results.map((result) => {
      if (result.status !== 'failure') {
        throw new Error('Expected failure result');
      }

      return result.failure.category;
    });

    expect(failures).toEqual([
      SourceFailureCategory.Unavailable,
      SourceFailureCategory.RateLimited,
      SourceFailureCategory.BadPayload,
      SourceFailureCategory.EmptyResult,
    ]);
  });

  it('applies the same rate limiter contract to tavily, yahoo, and akshare providers', () => {
    const clock = new FixedClock(Date.UTC(2026, 2, 17, 9, 0, 0));
    const tavily = new TavilyNewsSource(withRateLimit(new StubNewsProvider({
      status: 'success',
      payload: {
        kind: 'news',
        items: [createNewsArticlePayload()],
      },
      metadata: {
        requestId: 'req-tavily-1',
        providerIdentity: 'stub-news-provider',
      },
    }), {
      rateLimiter: new FixedWindowRateLimiter({
        maxRequests: 1,
        windowMs: 60_000,
      }, clock),
    }));
    const yahoo = new YahooFinanceMarketSource(withRateLimit(new StubStockProvider({
      status: 'success',
      payload: {
        kind: 'stock',
        items: [createStockQuotePayload()],
      },
      metadata: {
        requestId: 'req-yahoo-1',
        providerIdentity: 'stub-stock-provider',
      },
    }), {
      rateLimiter: new FixedWindowRateLimiter({
        maxRequests: 1,
        windowMs: 60_000,
      }, clock),
    }));
    const akshare = new AkShareMarketSource(withRateLimit(new StubStockProvider({
      status: 'success',
      payload: {
        kind: 'stock',
        items: [createStockQuotePayload()],
      },
      metadata: {
        requestId: 'req-akshare-1',
        providerIdentity: 'stub-stock-provider',
      },
    }), {
      rateLimiter: new FixedWindowRateLimiter({
        maxRequests: 1,
        windowMs: 60_000,
      }, clock),
    }));

    const tavilyFirst = tavily.fetch({ query: '银行' });
    const tavilySecond = tavily.fetch({ query: '银行' });
    const yahooFirst = yahoo.fetch({ symbol: '600000.SH' });
    const yahooSecond = yahoo.fetch({ symbol: '600000.SH' });
    const akshareFirst = akshare.fetch({ symbol: '000001.SZ' });
    const akshareSecond = akshare.fetch({ symbol: '000001.SZ' });

    expect(tavilyFirst.status).toBe('success');
    expect(yahooFirst.status).toBe('success');
    expect(akshareFirst.status).toBe('success');
    expect(tavilySecond.status).toBe('failure');
    expect(yahooSecond.status).toBe('failure');
    expect(akshareSecond.status).toBe('failure');

    const failures = [tavilySecond, yahooSecond, akshareSecond].map((result) => {
      if (result.status !== 'failure') {
        throw new Error('Expected rate-limited failure result');
      }

      return result.failure;
    });

    expect(failures).toEqual([
      expect.objectContaining({ category: SourceFailureCategory.RateLimited, retryAfterSeconds: 60 }),
      expect.objectContaining({ category: SourceFailureCategory.RateLimited, retryAfterSeconds: 60 }),
      expect.objectContaining({ category: SourceFailureCategory.RateLimited, retryAfterSeconds: 60 }),
    ]);
  });
});
