import { describe, expect, it } from 'vitest';

import {
  AkShareMarketSource,
  FirstAvailableStrategy,
  FixedWindowRateLimiter,
  HighestPriorityAvailableStrategy,
  SourceFailureCategory,
  SourceFactory,
  SourceRegistryFactory,
  RegisteredSourceSelectionStrategyAdapter,
  SourceSelectionService,
  TavilyNewsSource,
  YahooFinanceMarketSource,
  createSourceRegistryFactory,
  type ISource,
  type ISourceConstructor,
  type ISourceProvider,
  type IProviderNewsResponse,
  type IProviderRequestMetadata,
  type IProviderStockResponse,
  type IStockSourceRequest,
  type INewsSourceRequest,
  type SourceRegistryShape,
  type ISourceProviderDependencies,
} from '../../../../src/index.js';

class MemorySource implements ISource {
  public readonly kind = 'memory';

  public fetch(): string {
    return 'memory-source';
  }
}

class ApiSource implements ISource {
  public readonly kind = 'api';

  public fetch(): string {
    return 'api-source';
  }
}

class FileSource implements ISource {
  public readonly kind = 'file';

  public fetch(): string {
    return 'file-source';
  }
}

class AvailableNewsProvider implements ISourceProvider<INewsSourceRequest, IProviderNewsResponse> {
  public readonly name = 'tavily-provider';

  public execute(
    request: INewsSourceRequest,
    metadata: IProviderRequestMetadata,
  ): IProviderNewsResponse {
    void request;
    void metadata;

    return {
      status: 'failure',
      failure: {
        category: SourceFailureCategory.EmptyResult,
        message: 'no news',
      },
      metadata: {
        requestId: 'req-news',
        providerIdentity: 'tavily-provider',
      },
    };
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
      checkedAt: new Date('2026-03-17T10:00:00.000Z'),
      detail: 'ok',
    };
  }
}

class StockProvider implements ISourceProvider<IStockSourceRequest, IProviderStockResponse> {
  public constructor(
    public readonly name: string,
    private readonly available: boolean,
  ) {}

  public execute(
    request: IStockSourceRequest,
    metadata: IProviderRequestMetadata,
  ): IProviderStockResponse {
    void request;
    void metadata;

    return {
      status: 'failure',
      failure: {
        category: SourceFailureCategory.EmptyResult,
        message: 'no quotes',
      },
      metadata: {
        requestId: `req-${this.name}`,
        providerIdentity: this.name,
      },
    };
  }

  public isAvailable(): boolean {
    return this.available;
  }

  public getHealthStatus(): {
    readonly available: boolean;
    readonly checkedAt: Date;
    readonly detail: string;
  } {
    return {
      available: this.available,
      checkedAt: new Date('2026-03-17T10:00:00.000Z'),
      detail: this.available ? 'ok' : 'offline',
    };
  }
}

const createProviderDependencies = (
  overrides: Partial<ISourceProviderDependencies> = {},
): ISourceProviderDependencies => {
  return {
    rateLimiter: overrides.rateLimiter ?? new FixedWindowRateLimiter({
      maxRequests: 10,
      windowMs: 60_000,
    }),
    tavilyNewsProvider: overrides.tavilyNewsProvider ?? new AvailableNewsProvider(),
    yahooMarketProvider: overrides.yahooMarketProvider ?? new StockProvider('yahoo-provider', true),
    akshareMarketProvider: overrides.akshareMarketProvider ?? new StockProvider('akshare-provider', true),
  };
};

describe('SourceFactory', () => {
  it('creates registered source instances by type', () => {
    const factory = new SourceFactory()
      .register('memory', MemorySource)
      .register('api', ApiSource);

    const memorySource = factory.create('memory');
    const apiSource = factory.create('api');

    expect(memorySource).toBeInstanceOf(MemorySource);
    expect(memorySource.fetch()).toBe('memory-source');
    expect(apiSource).toBeInstanceOf(ApiSource);
    expect(apiSource.fetch()).toBe('api-source');
  });

  it('supports extension by registering new source types without changing creator code', () => {
    type InitialRegistry = {
      readonly memory: ISourceConstructor<MemorySource>;
      readonly api: ISourceConstructor<ApiSource>;
      readonly file: ISourceConstructor<FileSource>;
    };

    const registry: InitialRegistry = {
      memory: MemorySource,
      api: ApiSource,
      file: FileSource,
    };
    const factory = new SourceFactory<InitialRegistry>(registry);

    const fileSource = factory.create('file');

    expect(fileSource).toBeInstanceOf(FileSource);
    expect(fileSource.fetch()).toBe('file-source');
    expect(factory.supports('file')).toBe(true);
  });

  it('rejects duplicate registrations and unknown source types', () => {
    const factory = new SourceFactory().register('memory', MemorySource);

    expect(() => factory.register('memory', MemorySource)).toThrowError(
      'Source type "memory" is already registered.',
    );
    expect(() => {
      const unsafeFactory = factory as unknown as SourceFactory<SourceRegistryShape>;
      unsafeFactory.create('missing');
    }).toThrowError(
      'Unknown source type: missing',
    );
  });

  it('returns the correct product family for each registered source kind', () => {
    const factory = new SourceFactory()
      .register('memory', MemorySource)
      .register('api', ApiSource)
      .register('file', FileSource);

    const memorySource: MemorySource = factory.create('memory');
    const apiSource: ApiSource = factory.create('api');
    const fileSource: FileSource = factory.create('file');

    expect(memorySource.kind).toBe('memory');
    expect(apiSource.kind).toBe('api');
    expect(fileSource.kind).toBe('file');
  });

  it('preserves typed extensibility when registration is composed incrementally', () => {
    const baseFactory = new SourceFactory().register('memory', MemorySource);
    const extendedFactory = baseFactory.register('file', FileSource);

    const memorySource = extendedFactory.create('memory');
    const fileSource = extendedFactory.create('file');

    expect(memorySource).toBeInstanceOf(MemorySource);
    expect(fileSource).toBeInstanceOf(FileSource);
    expect(extendedFactory.supports('memory')).toBe(true);
    expect(extendedFactory.supports('file')).toBe(true);
  });

  it('preserves source-kind constructor mapping through typed lookup without return assertions', () => {
    const factory = new SourceFactory()
      .register('memory', MemorySource)
      .register('api', ApiSource);

    const creators = {
      memory: () => factory.create('memory'),
      api: () => factory.create('api'),
    } satisfies {
      readonly [TKind in 'memory' | 'api']: () => InstanceType<
        {
          readonly memory: typeof MemorySource;
          readonly api: typeof ApiSource;
        }[TKind]
      >;
    };

    const memorySource = creators.memory();
    const apiSource = creators.api();

    expect(memorySource).toBeInstanceOf(MemorySource);
    expect(apiSource).toBeInstanceOf(ApiSource);
  });

  it('preserves source-kind typing through constructor lookup and instantiation', () => {
    const registry = {
      memory: MemorySource,
      api: ApiSource,
    } satisfies {
      readonly memory: ISourceConstructor<MemorySource>;
      readonly api: ISourceConstructor<ApiSource>;
    };

    const instantiate = <TSource extends ISource>(
      SourceConstructor: ISourceConstructor<TSource>,
    ): TSource => new SourceConstructor();

    const memorySource = instantiate(registry.memory);
    const apiSource = instantiate(registry.api);

    expect(memorySource).toBeInstanceOf(MemorySource);
    expect(memorySource.kind).toBe('memory');
    expect(apiSource).toBeInstanceOf(ApiSource);
    expect(apiSource.kind).toBe('api');
  });

  it('keeps object-literal registry constructors aligned with create return types', () => {
    const registry = {
      memory: MemorySource,
      file: FileSource,
    } satisfies {
      readonly memory: ISourceConstructor<MemorySource>;
      readonly file: ISourceConstructor<FileSource>;
    };

    const factory = new SourceFactory<typeof registry>(registry);
    const createdByKind = {
      memory: factory.create('memory'),
      file: factory.create('file'),
    } satisfies {
      readonly memory: MemorySource;
      readonly file: FileSource;
    };

    expect(createdByKind.memory).toBeInstanceOf(MemorySource);
    expect(createdByKind.file).toBeInstanceOf(FileSource);
  });

  it('creates real sources through the registry after providers have been wired', () => {
    const registry = createSourceRegistryFactory(createProviderDependencies());

    const tavilySource = registry.create('tavily-news');
    const yahooSource = registry.create('yahoo-market');
    const akshareSource = registry.create('akshare-market');

    expect(tavilySource).toBeInstanceOf(TavilyNewsSource);
    expect(yahooSource).toBeInstanceOf(YahooFinanceMarketSource);
    expect(akshareSource).toBeInstanceOf(AkShareMarketSource);
  });

  it('preserves precise kind-to-source typing through registry creation', () => {
    const registry = new SourceRegistryFactory(createProviderDependencies());

    const createdByKind = {
      'tavily-news': registry.create('tavily-news'),
      'yahoo-market': registry.create('yahoo-market'),
      'akshare-market': registry.create('akshare-market'),
    } satisfies {
      readonly 'tavily-news': TavilyNewsSource;
      readonly 'yahoo-market': YahooFinanceMarketSource;
      readonly 'akshare-market': AkShareMarketSource;
    };

    expect(createdByKind['tavily-news']).toBeInstanceOf(TavilyNewsSource);
    expect(createdByKind['yahoo-market'].name).toBe('yahoo-provider');
    expect(createdByKind['akshare-market']).toBeInstanceOf(AkShareMarketSource);
  });

  it('selects only available registered sources via strategy wiring', () => {
    const registry = createSourceRegistryFactory(createProviderDependencies({
      yahooMarketProvider: new StockProvider('yahoo-provider', false),
      akshareMarketProvider: new StockProvider('akshare-provider', true),
    }));
    const selector = new SourceSelectionService(
      registry,
      new RegisteredSourceSelectionStrategyAdapter(new HighestPriorityAvailableStrategy()),
    );

    const selection = selector.select([
      { kind: 'yahoo-market', priority: 0 },
      { kind: 'akshare-market', priority: 1 },
    ] as const);

    expect(selection?.kind).toBe('akshare-market');
    expect(selection?.source).toBeInstanceOf(AkShareMarketSource);
  });

  it('returns null when all registered candidates are unavailable', () => {
    const registry = createSourceRegistryFactory(createProviderDependencies({
      yahooMarketProvider: new StockProvider('yahoo-provider', false),
      akshareMarketProvider: new StockProvider('akshare-provider', false),
    }));
    const selector = new SourceSelectionService(
      registry,
      new RegisteredSourceSelectionStrategyAdapter(new FirstAvailableStrategy()),
    );

    const selection = selector.select([
      { kind: 'yahoo-market', priority: 0 },
      { kind: 'akshare-market', priority: 1 },
    ] as const);

    expect(selection).toBeNull();
  });
});
