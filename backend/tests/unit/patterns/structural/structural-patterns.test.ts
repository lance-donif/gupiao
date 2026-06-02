import { describe, expect, it } from 'vitest';

import {
  CachingSourceDecorator,
  ExternalSourceAdapter,
  LoggingSourceDecorator,
  MemorySource,
  NewsIngestFacade,
  type IDecorationContext,
  type IDedupSubsystem,
  type IExternalSourceApi,
  type IFetchSubsystem,
  type ISourceTarget,
  type IStoreSubsystem,
} from '../../../../src/index.js';

class StubExternalApi implements IExternalSourceApi {
  public readonly providerName = 'stub-news-source';

  public fetchRecords(): readonly {
    readonly headline: string;
    readonly body: string;
    readonly publishedAtIso: string;
    readonly externalLink: string;
  }[] {
    return [
      {
        headline: 'A 股早报',
        body: '市场成交量回升。',
        publishedAtIso: '2026-03-16T09:30:00.000Z',
        externalLink: 'https://example.com/a-share-open',
      },
    ] as const;
  }

  public ping(): {
    readonly ok: boolean;
    readonly checkedAtIso: string;
    readonly detail: string;
  } {
    return {
      ok: true,
      checkedAtIso: '2026-03-16T09:00:00.000Z',
      detail: 'upstream-ready',
    } as const;
  }
}

class FetchSubsystemSpy implements IFetchSubsystem {
  public readonly calls: string[] = [];

  public fetch(query: string): readonly string[] {
    this.calls.push(query);
    return ['alpha', 'beta', 'alpha'];
  }
}

class DedupSubsystemSpy implements IDedupSubsystem {
  public readonly calls: readonly string[][] = [];

  private readonly recordedCalls: string[][] = [];

  public removeDuplicates(items: readonly string[]): readonly string[] {
    this.recordedCalls.push([...items]);
    return [...new Set(items)];
  }

  public get capturedCalls(): readonly string[][] {
    return this.recordedCalls;
  }
}

class StoreSubsystemSpy implements IStoreSubsystem {
  public readonly savedBatches: string[][] = [];

  public save(items: readonly string[]): number {
    this.savedBatches.push([...items]);
    return items.length;
  }
}

const createContext = (): IDecorationContext => {
  return {
    cacheEvents: [],
    logEvents: [],
  };
};

describe('structural patterns', () => {
  it('adapts external source records into the unified source contract', () => {
    const target: ISourceTarget = new ExternalSourceAdapter(new StubExternalApi());

    const articles = target.fetch();
    const health = target.getHealthStatus();

    expect(target.name).toBe('stub-news-source');
    expect(target.isAvailable()).toBe(true);
    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({
      title: 'A 股早报',
      summary: '市场成交量回升。',
      url: 'https://example.com/a-share-open',
    });
    expect(articles[0]?.publishedAt).toBeInstanceOf(Date);
    expect(health).toMatchObject({
      available: true,
      detail: 'upstream-ready',
    });
    expect(health.checkedAt).toBeInstanceOf(Date);
  });

  it('uses a facade to simplify access to multiple ingest subsystems', () => {
    const fetchSubsystem = new FetchSubsystemSpy();
    const dedupSubsystem = new DedupSubsystemSpy();
    const storeSubsystem = new StoreSubsystemSpy();
    const facade = new NewsIngestFacade(
      fetchSubsystem,
      dedupSubsystem,
      storeSubsystem,
    );

    const result = facade.ingest('banking');

    expect(fetchSubsystem.calls).toEqual(['banking']);
    expect(dedupSubsystem.capturedCalls).toEqual([['alpha', 'beta', 'alpha']]);
    expect(storeSubsystem.savedBatches).toEqual([['alpha', 'beta']]);
    expect(result).toEqual({
      fetchedCount: 3,
      storedCount: 2,
      items: ['alpha', 'beta'],
    });
  });

  it('allows decorators to stack in any order while preserving shared behavior', () => {
    const loggingThenCachingContext = createContext();
    const loggingThenCaching = new CachingSourceDecorator(
      new LoggingSourceDecorator(
        new MemorySource({ ticker: '600000.SH' }),
        loggingThenCachingContext,
      ),
      loggingThenCachingContext,
    );

    expect(loggingThenCaching.get('ticker')).toBe('600000.SH');
    expect(loggingThenCaching.get('ticker')).toBe('600000.SH');
    expect(loggingThenCachingContext.cacheEvents).toEqual(['miss:ticker', 'hit:ticker']);
    expect(loggingThenCachingContext.logEvents).toEqual(['before:ticker', 'after:ticker']);

    const cachingThenLoggingContext = createContext();
    const cachingThenLogging = new LoggingSourceDecorator(
      new CachingSourceDecorator(
        new MemorySource({ ticker: '600000.SH' }),
        cachingThenLoggingContext,
      ),
      cachingThenLoggingContext,
    );

    expect(cachingThenLogging.get('ticker')).toBe('600000.SH');
    expect(cachingThenLogging.get('ticker')).toBe('600000.SH');
    expect(cachingThenLoggingContext.cacheEvents).toEqual(['miss:ticker', 'hit:ticker']);
    expect(cachingThenLoggingContext.logEvents).toEqual([
      'before:ticker',
      'after:ticker',
      'before:ticker',
      'after:ticker',
    ]);
  });
});
