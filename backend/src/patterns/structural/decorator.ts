import { LruCache } from '../../data-structures/lru-cache.js';

export interface IComposableSource {
  get: (key: string) => string;
}

export interface ISourceDecoration {
  readonly label: string;
  readonly key: string;
  readonly value: string;
}

export interface IDecorationContext {
  readonly cacheEvents: string[];
  readonly logEvents: string[];
}

export abstract class SourceDecorator implements IComposableSource {
  public constructor(protected readonly inner: IComposableSource) {}

  public get(key: string): string {
    return this.inner.get(key);
  }
}

export class MemorySource implements IComposableSource {
  private readonly values: Map<string, string>;

  public constructor(entries: Readonly<Record<string, string>>) {
    this.values = new Map(Object.entries(entries));
  }

  public get(key: string): string {
    const value = this.values.get(key);

    if (value === undefined) {
      throw new Error(`Missing source value for key: ${key}`);
    }

    return value;
  }
}

export class CachingSourceDecorator extends SourceDecorator {
  private readonly cache: LruCache<string, string>;

  public constructor(
    inner: IComposableSource,
    private readonly context: IDecorationContext,
    capacity = 16,
  ) {
    super(inner);
    this.cache = new LruCache<string, string>(capacity);
  }

  public override get(key: string): string {
    const cached = this.cache.get(key);

    if (cached !== undefined) {
      this.context.cacheEvents.push(`hit:${key}`);
      return cached;
    }

    this.context.cacheEvents.push(`miss:${key}`);
    const value = this.inner.get(key);
    this.cache.put(key, value);
    return value;
  }
}

export class LoggingSourceDecorator extends SourceDecorator {
  public constructor(
    inner: IComposableSource,
    private readonly context: IDecorationContext,
  ) {
    super(inner);
  }

  public override get(key: string): string {
    this.context.logEvents.push(`before:${key}`);
    const value = this.inner.get(key);
    this.context.logEvents.push(`after:${key}`);
    return value;
  }
}
