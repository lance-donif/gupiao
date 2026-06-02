export interface ISource {
  readonly kind: string;
}

export interface ISourceConstructor<TSource, TArgs extends readonly unknown[] = readonly []> {
  new (...args: TArgs): TSource;
  readonly prototype: TSource;
}

export type SourceRegistryShape = Record<string, ISourceConstructor<unknown, readonly unknown[]>>;

type SourceKind<TRegistry extends SourceRegistryShape> = Extract<keyof TRegistry, string>;

type SourceConstructorInstance<TConstructor extends ISourceConstructor<unknown, readonly unknown[]>> = TConstructor['prototype'];

const instantiateSource = <TConstructor extends ISourceConstructor<unknown, readonly unknown[]>>(
  sourceConstructor: TConstructor,
  ...args: ConstructorParameters<TConstructor>
): TConstructor['prototype'] => new sourceConstructor(...args);

export type SourceInstanceFor<
  TRegistry extends SourceRegistryShape,
  TKind extends SourceKind<TRegistry>,
> = SourceConstructorInstance<TRegistry[TKind]>;

export type SourceRegistryEntry<
  TKind extends string,
  TConstructor extends ISourceConstructor<unknown, readonly unknown[]>,
> = Record<TKind, TConstructor>;

type KnownSourceRegistry<TRegistry extends SourceRegistryShape> = {
  readonly [TKind in SourceKind<TRegistry>]: TRegistry[TKind];
};

export class SourceFactory<TRegistry extends SourceRegistryShape = Record<never, never>> {
  private readonly registry: KnownSourceRegistry<TRegistry>;

  public constructor(
    initialRegistry?: KnownSourceRegistry<TRegistry>,
  ) {
    this.registry = initialRegistry ?? SourceFactory.createEmptyRegistry<TRegistry>();
  }

  public register<TKind extends string, TConstructor extends ISourceConstructor<unknown, readonly unknown[]>>(
    sourceType: TKind,
    sourceConstructor: TConstructor,
  ): SourceFactory<TRegistry & SourceRegistryEntry<TKind, TConstructor>> {
    if (this.hasSourceType(sourceType)) {
      throw new Error(`Source type "${sourceType}" is already registered.`);
    }

    type TNextRegistry = TRegistry & SourceRegistryEntry<TKind, TConstructor>;
    const nextRegistry = this.extendRegistry<TKind, TConstructor>(sourceType, sourceConstructor);

    return new SourceFactory<TNextRegistry>(nextRegistry);
  }

  public create<TKind extends SourceKind<TRegistry>>(
    sourceType: TKind,
    ...args: ConstructorParameters<TRegistry[TKind]>
  ): SourceInstanceFor<TRegistry, TKind> {
    return instantiateSource(this.getSourceConstructor(sourceType), ...args);
  }

  public supports(sourceType: SourceKind<TRegistry>): boolean {
    return this.getSourceConstructor(sourceType) !== undefined;
  }

  private hasSourceType(sourceType: string): boolean {
    return sourceType in this.registry;
  }

  private getSourceConstructor<TKind extends SourceKind<TRegistry>>(
    sourceType: TKind,
  ): TRegistry[TKind] {
    const sourceConstructor = this.registry[sourceType];

    if (!sourceConstructor) {
      throw new Error(`Unknown source type: ${sourceType}`);
    }

    return sourceConstructor;
  }

  private extendRegistry<TKind extends string, TConstructor extends ISourceConstructor<unknown, readonly unknown[]>>(
    sourceType: TKind,
    sourceConstructor: TConstructor,
  ): KnownSourceRegistry<TRegistry & SourceRegistryEntry<TKind, TConstructor>> {
    return {
      ...this.registry,
      [sourceType]: sourceConstructor,
    } as KnownSourceRegistry<TRegistry & SourceRegistryEntry<TKind, TConstructor>>;
  }

  private static createEmptyRegistry<TRegistry extends SourceRegistryShape>(): KnownSourceRegistry<TRegistry> {
    return {} as KnownSourceRegistry<TRegistry>;
  }
}
