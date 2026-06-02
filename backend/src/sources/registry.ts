import type { ISelectableSource, ISourceSelectionStrategy } from '../index.js';
import type { ISource } from '../patterns/creational/source-factory.js';
import type { INewsSourceRequest, IProviderNewsResponse, IProviderStockResponse, ISourceProvider, ISourceProviderRateLimiterDependencies, IStockSourceRequest } from './index.js';
import {
  FirstAvailableStrategy,
  HighestPriorityAvailableStrategy,

} from '../index.js';
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

export interface IRegisteredSource extends ISource {
  readonly name: string;
  readonly sourceKind: SourceKind;

  createSource: () => TavilyNewsSource | YahooFinanceMarketSource | AkShareMarketSource;

  isAvailable: () => boolean;
}

export interface IRegisteredSelectableSource<TSource extends IRegisteredSource = IRegisteredSource> {
  readonly name: string;
  readonly source: TSource;
  readonly priority: number;
  readonly available: boolean;
}

export interface ISelectionCandidate<TKind extends SourceKind = SourceKind> {
  readonly kind: TKind;
  readonly priority: number;
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

export const toSelectionCandidate = <TKind extends SourceKind>(
  source: RegisteredSourceFor<TKind>,
  priority: number,
): {
  readonly name: string;
  readonly source: RegisteredSourceFor<TKind>;
  readonly priority: number;
  readonly available: boolean;
} => {
  return {
    name: source.name,
    source,
    priority,
    available: source.isAvailable(),
  };
};

export type RegisteredSelectableSource<TSource extends RegisteredSourceFor<SourceKind> = RegisteredSourceFor<SourceKind>> = {
  readonly name: string;
  readonly source: TSource;
  readonly priority: number;
  readonly available: boolean;
} & ISelectableSource;

export class RegisteredSourceSelectionStrategyAdapter
implements ISourceSelectionStrategy<RegisteredSelectableSource> {
  public constructor(private readonly baseStrategy: ISourceSelectionStrategy<ISelectableSource>) {}

  public select(sources: readonly RegisteredSelectableSource[]): RegisteredSelectableSource | null {
    const selected = this.baseStrategy.select(sources);

    return sources.find(source => source === selected) ?? null;
  }
}

export const createAvailableSelectionStrategy = (
  strategy: 'first-available' | 'highest-priority-available' = 'highest-priority-available',
): RegisteredSourceSelectionStrategyAdapter => {
  if (strategy === 'first-available') {
    return new RegisteredSourceSelectionStrategyAdapter(new FirstAvailableStrategy());
  }

  return new RegisteredSourceSelectionStrategyAdapter(new HighestPriorityAvailableStrategy());
};

export class SourceSelectionService {
  public constructor(
    private readonly registryFactory: SourceRegistryFactory,
    private readonly selectionStrategy: ISourceSelectionStrategy<RegisteredSelectableSource>,
  ) {}

  public select<TKind extends SourceKind>(
    candidates: readonly ISelectionCandidate<TKind>[],
  ): {
    readonly kind: TKind;
    readonly source: RegisteredSourceFor<TKind>;
  } | null {
    const selectableCandidates = candidates.map((candidate) => {
      const source = this.registryFactory.create(candidate.kind);

      return {
        kind: candidate.kind,
        name: source.name,
        priority: candidate.priority,
        source,
        available: source.isAvailable(),
      } as const;
    });

    const selected = this.selectionStrategy.select(selectableCandidates);

    if (!selected) {
      return null;
    }

    const matchedCandidate = selectableCandidates.find(candidate => candidate.source === selected.source);

    if (!matchedCandidate) {
      return null;
    }

    return {
      kind: matchedCandidate.kind,
      source: matchedCandidate.source,
    };
  }
}

export const createSourceRegistryFactory = (
  dependencies: ISourceProviderDependencies,
): SourceRegistryFactory => {
  return new SourceRegistryFactory(dependencies);
};
