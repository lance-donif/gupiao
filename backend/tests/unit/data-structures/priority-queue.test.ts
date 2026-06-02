import { describe, expect, it } from 'vitest';

import { PriorityQueue } from '../../../src/data-structures/priority-queue.js';

interface StockTask {
  readonly symbol: string;
  readonly priority: number;
}

const compareByPriority = (left: StockTask, right: StockTask): number => {
  return left.priority - right.priority;
};

const expectHeapProperty = <TValue>(
  queue: PriorityQueue<TValue>,
  compare: (left: TValue, right: TValue) => number,
): void => {
  const values = queue.toArray();

  for (let parentIndex = 0; parentIndex < values.length; parentIndex += 1) {
    const leftChildIndex = parentIndex * 2 + 1;
    const rightChildIndex = leftChildIndex + 1;

    if (leftChildIndex < values.length) {
      expect(compare(values[parentIndex], values[leftChildIndex])).toBeGreaterThanOrEqual(0);
    }

    if (rightChildIndex < values.length) {
      expect(compare(values[parentIndex], values[rightChildIndex])).toBeGreaterThanOrEqual(0);
    }
  }
};

describe('PriorityQueue', () => {
  it('uses a binary heap so insert and extract work in O(log n)-style reheapification steps', () => {
    const queue = new PriorityQueue<StockTask>({ compare: compareByPriority });

    queue.push({ symbol: '600519', priority: 3 });
    queue.push({ symbol: '000001', priority: 8 });
    queue.push({ symbol: '600000', priority: 5 });
    queue.push({ symbol: '300750', priority: 10 });

    expect(queue.peek()).toEqual({ symbol: '300750', priority: 10 });
    expectHeapProperty(queue, compareByPriority);

    expect(queue.extract()).toEqual({ symbol: '300750', priority: 10 });
    expect(queue.extract()).toEqual({ symbol: '000001', priority: 8 });
    expect(queue.extract()).toEqual({ symbol: '600000', priority: 5 });
    expect(queue.extract()).toEqual({ symbol: '600519', priority: 3 });
    expect(queue.extract()).toBeUndefined();
  });

  it('maintains the heap property after every insert and extract operation', () => {
    const queue = new PriorityQueue<number>({ compare: (left, right) => left - right });
    const values = [4, 9, 1, 7, 12, 3, 8, 10, 6, 2, 11, 5];

    for (const value of values) {
      queue.push(value);
      expectHeapProperty(queue, (left, right) => left - right);
    }

    while (!queue.isEmpty) {
      queue.extract();
      expectHeapProperty(queue, (left, right) => left - right);
    }
  });

  it('supports O(1)-style peek and exposes queue statistics without mutating contents', () => {
    const queue = new PriorityQueue<number>({ compare: (left, right) => left - right });

    queue.push(2);
    queue.push(9);
    queue.push(4);
    queue.push(7);

    expect(queue.peek()).toBe(9);
    expect(queue.peek()).toBe(9);
    expect(queue.toArray()).toEqual([9, 7, 4, 2]);
    expect(queue.getStats()).toEqual({
      size: 4,
      isEmpty: false,
      lastLevelSize: 1,
      height: 3,
    });
  });

  it('supports clearing and empty extraction semantics cleanly', () => {
    const queue = new PriorityQueue<number>({ compare: (left, right) => left - right });

    queue.push(1);
    queue.push(3);
    queue.clear();

    expect(queue.size).toBe(0);
    expect(queue.isEmpty).toBe(true);
    expect(queue.peek()).toBeUndefined();
    expect(queue.extract()).toBeUndefined();
    expect(queue.getStats()).toEqual({
      size: 0,
      isEmpty: true,
      lastLevelSize: 0,
      height: 0,
    });
  });

  it('rejects missing comparator functions', () => {
    expect(() => new PriorityQueue<number>({ compare: undefined as never })).toThrowError(
      'compare must be a function',
    );
  });
});
