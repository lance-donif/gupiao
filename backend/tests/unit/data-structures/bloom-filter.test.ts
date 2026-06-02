import { describe, expect, it } from 'vitest';

import { BloomFilter } from '../../../src/data-structures/bloom-filter.js';

const createSequentialItems = (prefix: string, count: number, start: number = 0): string[] => {
  return Array.from({ length: count }, (_, index) => `${prefix}-${start + index}`);
};

describe('BloomFilter', () => {
  it('supports O(k)-style membership checks with zero false negatives for inserted items', () => {
    const filter = new BloomFilter({ size: 20_000, hashCount: 7 });
    const insertedItems = createSequentialItems('inserted', 2_000);

    for (const item of insertedItems) {
      filter.add(item);
    }

    for (const item of insertedItems) {
      expect(filter.mightContain(item)).toBe(true);
    }

    expect(filter.insertedCount).toBe(insertedItems.length);
  });

  it('keeps the observed false positive rate within a practical bound of the theoretical estimate', () => {
    const plan = BloomFilter.planCapacity(2_500, 0.03);
    const filter = new BloomFilter({ size: plan.size, hashCount: plan.hashCount });
    const insertedItems = createSequentialItems('alpha', plan.expectedInsertions);
    const unseenItems = createSequentialItems('beta', 5_000, plan.expectedInsertions);

    for (const item of insertedItems) {
      filter.add(item);
    }

    const falsePositives = unseenItems.reduce((count, item) => {
      return count + Number(filter.mightContain(item));
    }, 0);
    const observedRate = falsePositives / unseenItems.length;
    const theoreticalRate = filter.estimateFalsePositiveRate();

    expect(observedRate).toBeLessThanOrEqual(theoreticalRate + 0.02);
    expect(observedRate).toBeLessThan(0.05);
  });

  it('derives capacity planning values from expected insertions and target false positive rate', () => {
    const plan = BloomFilter.planCapacity(1_000, 0.01);

    expect(plan.size).toBeGreaterThan(0);
    expect(plan.hashCount).toBeGreaterThan(0);

    const filter = BloomFilter.createForCapacity(1_000, 0.01);
    expect(filter.size).toBe(plan.size);
    expect(filter.hashCount).toBe(plan.hashCount);
  });

  it('tracks fill ratio and estimated false positive rate statistics', () => {
    const filter = new BloomFilter({ size: 1_024, hashCount: 4 });

    filter.add('600000');
    filter.add('000001');
    filter.add('600519');

    const stats = filter.getStats();

    expect(stats.insertedCount).toBe(3);
    expect(stats.setBitCount).toBeGreaterThan(0);
    expect(stats.fillRatio).toBeGreaterThan(0);
    expect(stats.fillRatio).toBeLessThanOrEqual(1);
    expect(stats.estimatedFalsePositiveRate).toBeGreaterThan(0);
    expect(stats.estimatedFalsePositiveRate).toBeLessThan(1);
  });

  it('rejects invalid size and hash configuration values', () => {
    expect(() => new BloomFilter({ size: 0, hashCount: 3 })).toThrowError(
      'size must be a positive integer',
    );
    expect(() => new BloomFilter({ size: 128, hashCount: 0 })).toThrowError(
      'hashCount must be a positive integer',
    );
    expect(() => BloomFilter.planCapacity(0, 0.01)).toThrowError(
      'expectedInsertions must be a positive integer',
    );
    expect(() => BloomFilter.planCapacity(100, 1)).toThrowError(
      'targetFalsePositiveRate must be between 0 and 1',
    );
  });
});
