export interface ISourceSelectionStrategy<TSource> {
  select: (sources: readonly TSource[]) => TSource | null;
}

export interface ISelectableSource {
  readonly name: string;
  readonly priority: number;
  readonly available: boolean;
}

export class SourceSelectionContext<TSource> {
  public constructor(private strategy: ISourceSelectionStrategy<TSource>) {}

  public setStrategy(strategy: ISourceSelectionStrategy<TSource>): void {
    this.strategy = strategy;
  }

  public select(sources: readonly TSource[]): TSource | null {
    return this.strategy.select(sources);
  }
}

export class HighestPriorityAvailableStrategy
implements ISourceSelectionStrategy<ISelectableSource> {
  public select(sources: readonly ISelectableSource[]): ISelectableSource | null {
    const availableSources = sources.filter(source => source.available);

    if (availableSources.length === 0) {
      return null;
    }

    return availableSources.reduce((bestSource, candidate) => {
      return candidate.priority < bestSource.priority ? candidate : bestSource;
    });
  }
}

export class FirstAvailableStrategy
implements ISourceSelectionStrategy<ISelectableSource> {
  public select(sources: readonly ISelectableSource[]): ISelectableSource | null {
    return sources.find(source => source.available) ?? null;
  }
}
