import { describe, expect, it } from 'vitest';

import { Trie } from '../../../src/data-structures/trie.js';

describe('Trie', () => {
  it('supports exact lookup and prefix search in O(m)-style traversal over the input string', () => {
    const trie = new Trie();

    trie.insert('stock');
    trie.insert('stop');
    trie.insert('stone');

    expect(trie.contains('stock')).toBe(true);
    expect(trie.contains('sto')).toBe(false);
    expect(trie.hasPrefix('sto')).toBe(true);
    expect(trie.hasPrefix('stack')).toBe(false);
  });

  it('shares nodes for keys with common prefixes and does not duplicate existing words', () => {
    const trie = new Trie();

    trie.insert('car');
    trie.insert('cart');
    trie.insert('care');
    trie.insert('car');

    const stats = trie.getStats();

    expect(stats.keyCount).toBe(3);
    expect(stats.nodeCount).toBe(6);
  });

  it('returns all matching keys for a prefix in deterministic lexical order', () => {
    const trie = new Trie();

    trie.insert('news');
    trie.insert('new');
    trie.insert('newly');
    trie.insert('next');

    expect(trie.findByPrefix('new')).toEqual(['new', 'newly', 'news']);
    expect(trie.findByPrefix('nex')).toEqual(['next']);
    expect(trie.findByPrefix('none')).toEqual([]);
  });

  it('supports Chinese characters for exact lookup and prefix search', () => {
    const trie = new Trie();

    trie.insert('股票');
    trie.insert('股东');
    trie.insert('行业');

    expect(trie.contains('股票')).toBe(true);
    expect(trie.contains('股')).toBe(false);
    expect(trie.hasPrefix('股')).toBe(true);
    expect(trie.findByPrefix('股')).toEqual(['股东', '股票']);
  });

  it('rejects empty keys for insert and lookup operations', () => {
    const trie = new Trie();

    expect(() => trie.insert('')).toThrowError('key must not be empty');
    expect(() => trie.contains('')).toThrowError('key must not be empty');
    expect(() => trie.hasPrefix('')).toThrowError('key must not be empty');
    expect(() => trie.findByPrefix('')).toThrowError('key must not be empty');
  });
});
