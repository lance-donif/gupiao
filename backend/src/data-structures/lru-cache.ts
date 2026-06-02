export interface LruCacheStats {
  readonly capacity: number;
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly hitRate: number;
  readonly keysInUseOrder: readonly string[];
}

class LruCacheNode<TKey extends string, TValue> {
  public previous: LruCacheNode<TKey, TValue> | null = null;
  public next: LruCacheNode<TKey, TValue> | null = null;

  public constructor(
    public readonly key: TKey,
    public value: TValue,
  ) {}
}

export class LruCache<TKey extends string, TValue> {
  private readonly entries = new Map<TKey, LruCacheNode<TKey, TValue>>();
  private leastRecentlyUsed: LruCacheNode<TKey, TValue> | null = null;
  private mostRecentlyUsed: LruCacheNode<TKey, TValue> | null = null;
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;

  public constructor(private readonly capacityValue: number) {
    LruCache.ensurePositiveInteger(capacityValue, 'capacity');
  }

  public get capacity(): number {
    return this.capacityValue;
  }

  public get size(): number {
    return this.entries.size;
  }

  public get hits(): number {
    return this.hitCount;
  }

  public get misses(): number {
    return this.missCount;
  }

  public get evictions(): number {
    return this.evictionCount;
  }

  public has(key: TKey): boolean {
    return this.entries.has(key);
  }

  public get(key: TKey): TValue | undefined {
    const node = this.entries.get(key);

    if (node === undefined) {
      this.missCount += 1;
      return undefined;
    }

    this.hitCount += 1;
    this.moveToMostRecentlyUsed(node);
    return node.value;
  }

  public put(key: TKey, value: TValue): void {
    const existingNode = this.entries.get(key);

    if (existingNode !== undefined) {
      existingNode.value = value;
      this.moveToMostRecentlyUsed(existingNode);
      return;
    }

    const node = new LruCacheNode(key, value);
    this.entries.set(key, node);
    this.appendAsMostRecentlyUsed(node);

    if (this.entries.size > this.capacityValue) {
      this.evictLeastRecentlyUsed();
    }
  }

  public delete(key: TKey): boolean {
    const node = this.entries.get(key);

    if (node === undefined) {
      return false;
    }

    this.detach(node);
    return this.entries.delete(key);
  }

  public clear(): void {
    this.entries.clear();
    this.leastRecentlyUsed = null;
    this.mostRecentlyUsed = null;
    this.hitCount = 0;
    this.missCount = 0;
    this.evictionCount = 0;
  }

  public keys(): readonly TKey[] {
    const keys: TKey[] = [];
    let current = this.leastRecentlyUsed;

    while (current !== null) {
      keys.push(current.key);
      current = current.next;
    }

    return keys;
  }

  public getStats(): LruCacheStats {
    const totalLookups = this.hitCount + this.missCount;

    return {
      capacity: this.capacity,
      size: this.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: totalLookups === 0 ? 0 : this.hitCount / totalLookups,
      keysInUseOrder: this.keys(),
    };
  }

  private moveToMostRecentlyUsed(node: LruCacheNode<TKey, TValue>): void {
    if (this.mostRecentlyUsed === node) {
      return;
    }

    this.detach(node);
    this.appendAsMostRecentlyUsed(node);
  }

  private appendAsMostRecentlyUsed(node: LruCacheNode<TKey, TValue>): void {
    node.previous = this.mostRecentlyUsed;
    node.next = null;

    if (this.mostRecentlyUsed !== null) {
      this.mostRecentlyUsed.next = node;
    }

    this.mostRecentlyUsed = node;

    if (this.leastRecentlyUsed === null) {
      this.leastRecentlyUsed = node;
    }
  }

  private detach(node: LruCacheNode<TKey, TValue>): void {
    if (node.previous !== null) {
      node.previous.next = node.next;
    }
    else {
      this.leastRecentlyUsed = node.next;
    }

    if (node.next !== null) {
      node.next.previous = node.previous;
    }
    else {
      this.mostRecentlyUsed = node.previous;
    }

    node.previous = null;
    node.next = null;
  }

  private evictLeastRecentlyUsed(): void {
    const nodeToEvict = this.leastRecentlyUsed;

    if (nodeToEvict === null) {
      throw new Error('cannot evict from an empty cache');
    }

    this.detach(nodeToEvict);
    this.entries.delete(nodeToEvict.key);
    this.evictionCount += 1;
  }

  private static ensurePositiveInteger(value: number, name: string): void {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
}
