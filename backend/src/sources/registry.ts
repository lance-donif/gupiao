import type { INewsSourceRequest, IProviderNewsResponse, IProviderStockResponse, ISourceProvider, ISourceProviderRateLimiterDependencies, IStockSourceRequest } from './index.js';
import {
  AkShareMarketSource,
  TavilyNewsSource,
  withRateLimit,
  YahooFinanceMarketSource,
} from './index.js';

export type SourceKind = 'tavily-news' | 'yahoo-market' | 'akshare-market';

export interface ISourceProviderDependencies extends ISourceProviderRateLimiterDependencies {
  readonly tavilyNewsProvider: ISourceProvider<INewsSourceRequest, IProviderNewsResponse>;
  readonly yahooMarketProvider: ISourceProvider<IStockSourceRequest, IProviderStockResponse>;
  readonly akshareMarketProvider: ISourceProvider<IStockSourceRequest, IProviderStockResponse>;
}

export interface ISource {
  readonly kind: string;
}

export interface IRegisteredSource extends ISource {
  readonly name: string;
  readonly sourceKind: SourceKind;

  createSource: () => TavilyNewsSource | YahooFinanceMarketSource | AkShareMarketSource;

  isAvailable: () => boolean;
}

export class TavilyNewsSourceEntry implements IRegisteredSource {
  public readonly kind = 'provider';
  public readonly sourceKind = 'tavily-news';

  public constructor(private readonly dependencies: ISourceProviderDependencies) {}

  public get name(): string {
    return this.dependencies.tavilyNewsProvider.name;
  }

  public createSource(): TavilyNewsSource {
    return new TavilyNewsSource(withRateLimit(this.dependencies.tavilyNewsProvider, this.dependencies));
  }

  public isAvailable(): boolean {
    return this.dependencies.tavilyNewsProvider.isAvailable();
  }
}

export class YahooFinanceMarketSourceEntry implements IRegisteredSource {
  public readonly kind = 'provider';
  public readonly sourceKind = 'yahoo-market';

  public constructor(private readonly dependencies: ISourceProviderDependencies) {}

  public get name(): string {
    return this.dependencies.yahooMarketProvider.name;
  }

  public createSource(): YahooFinanceMarketSource {
    return new YahooFinanceMarketSource(withRateLimit(this.dependencies.yahooMarketProvider, this.dependencies));
  }

  public isAvailable(): boolean {
    return this.dependencies.yahooMarketProvider.isAvailable();
  }
}

export class AkShareMarketSourceEntry implements IRegisteredSource {
  public readonly kind = 'provider';
  public readonly sourceKind = 'akshare-market';

  public constructor(private readonly dependencies: ISourceProviderDependencies) {}

  public get name(): string {
    return this.dependencies.akshareMarketProvider.name;
  }

  public createSource(): AkShareMarketSource {
    return new AkShareMarketSource(withRateLimit(this.dependencies.akshareMarketProvider, this.dependencies));
  }

  public isAvailable(): boolean {
    return this.dependencies.akshareMarketProvider.isAvailable();
  }
}

interface SourceRegistry {
  readonly 'tavily-news': TavilyNewsSourceEntry;
  readonly 'yahoo-market': YahooFinanceMarketSourceEntry;
  readonly 'akshare-market': AkShareMarketSourceEntry;
}

export interface RegisteredSourceMap {
  readonly 'tavily-news': TavilyNewsSource;
  readonly 'yahoo-market': YahooFinanceMarketSource;
  readonly 'akshare-market': AkShareMarketSource;
}

export type RegisteredSourceFor<TKind extends SourceKind> = RegisteredSourceMap[TKind];

export class SourceRegistryFactory {
  private readonly registry: SourceRegistry;

  public constructor(
    private readonly dependencies: ISourceProviderDependencies,
    registry?: SourceRegistry,
  ) {
    this.registry = registry ?? {
      'tavily-news': new TavilyNewsSourceEntry(dependencies),
      'yahoo-market': new YahooFinanceMarketSourceEntry(dependencies),
      'akshare-market': new AkShareMarketSourceEntry(dependencies),
    };
  }

  public register(kind: SourceKind, entry: SourceRegistry[SourceKind]): SourceRegistryFactory {
    if (this.supports(kind)) {
      throw new Error(`Source type "${kind}" is already registered.`);
    }

    const nextRegistry = {
      ...this.registry,
      [kind]: entry,
    } as SourceRegistry;

    return new SourceRegistryFactory(this.dependencies, nextRegistry);
  }

  public create<TKind extends SourceKind>(kind: TKind): RegisteredSourceFor<TKind> {
    const entry = this.registry[kind];

    if (!entry) {
      throw new Error(`Unknown source type: ${kind}`);
    }

    return entry.createSource() as RegisteredSourceFor<TKind>;
  }

  public supports(kind: SourceKind): boolean {
    return kind in this.registry;
  }
}

export const createSourceRegistryFactory = (
  dependencies: ISourceProviderDependencies,
): SourceRegistryFactory => {
  return new SourceRegistryFactory(dependencies);
};

