import { describe, expect, it } from 'vitest';

import { LruCache } from '../../../src/data-structures/lru-cache.js';

describe('LruCache', () => {
  it('supports O(1)-style get/put through a hash map plus doubly linked usage ordering', () => {
    const cache = new LruCache<string, number>(3);

    cache.put('600000', 10);
    cache.put('000001', 20);
    cache.put('600519', 30);

    expect(cache.get('000001')).toBe(20);
    expect(cache.get('600519')).toBe(30);
    expect(cache.keys()).toEqual(['600000', '000001', '600519']);
  });

  it('evicts the least recently used entry when capacity is exceeded', () => {
    const cache = new LruCache<string, string>(2);

    cache.put('A', 'alpha');
    cache.put('B', 'beta');
    cache.get('A');
    cache.put('C', 'gamma');

    expect(cache.get('B')).toBeUndefined();
    expect(cache.get('A')).toBe('alpha');
    expect(cache.get('C')).toBe('gamma');
    expect(cache.keys()).toEqual(['A', 'C']);
    expect(cache.getStats().evictions).toBe(1);
  });

  it('updates existing keys in place and refreshes their recency without increasing size', () => {
    const cache = new LruCache<string, number>(2);

    cache.put('x', 1);
    cache.put('y', 2);
    cache.put('x', 3);

    expect(cache.size).toBe(2);
    expect(cache.get('x')).toBe(3);
    expect(cache.keys()).toEqual(['y', 'x']);
  });

  it('tracks hit, miss, eviction, and hit rate statistics accurately', () => {
    const cache = new LruCache<string, number>(2);

    cache.put('foo', 1);
    cache.put('bar', 2);
    cache.get('foo');
    cache.get('missing');
    cache.put('baz', 3);

    expect(cache.getStats()).toEqual({
      capacity: 2,
      size: 2,
      hits: 1,
      misses: 1,
      evictions: 1,
      hitRate: 0.5,
      keysInUseOrder: ['foo', 'baz'],
    });
  });

  it('supports deletion and clearing while keeping ordering state consistent', () => {
    const cache = new LruCache<string, number>(3);

    cache.put('one', 1);
    cache.put('two', 2);
    cache.put('three', 3);

    expect(cache.delete('two')).toBe(true);
    expect(cache.delete('two')).toBe(false);
    expect(cache.keys()).toEqual(['one', 'three']);

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.keys()).toEqual([]);
    expect(cache.getStats()).toEqual({
      capacity: 3,
      size: 0,
      hits: 0,
      misses: 0,
      evictions: 0,
      hitRate: 0,
      keysInUseOrder: [],
    });
  });

  it('rejects non-positive capacities', () => {
    expect(() => new LruCache<string, string>(0)).toThrowError(
      'capacity must be a positive integer',
    );
  });
});
