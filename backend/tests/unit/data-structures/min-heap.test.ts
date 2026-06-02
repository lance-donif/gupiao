import { describe, expect, it } from 'vitest';

import { MinHeap } from '../../../src/data-structures/min-heap.js';

interface ScheduledTask {
  readonly id: string;
  readonly runAt: Date;
}

const compareNumbers = (left: number, right: number): number => {
  return left - right;
};

const compareByTime = (left: ScheduledTask, right: ScheduledTask): number => {
  return left.runAt.getTime() - right.runAt.getTime();
};

const expectMinHeapProperty = <TValue>(
  heap: MinHeap<TValue>,
  compare: (left: TValue, right: TValue) => number,
): void => {
  const values = heap.toArray();

  for (let parentIndex = 0; parentIndex < values.length; parentIndex += 1) {
    const leftChildIndex = parentIndex * 2 + 1;
    const rightChildIndex = leftChildIndex + 1;

    if (leftChildIndex < values.length) {
      expect(compare(values[parentIndex], values[leftChildIndex])).toBeLessThanOrEqual(0);
    }

    if (rightChildIndex < values.length) {
      expect(compare(values[parentIndex], values[rightChildIndex])).toBeLessThanOrEqual(0);
    }
  }
};

describe('MinHeap', () => {
  it('keeps the root as the minimum element after inserts and extract-min operations', (): void => {
    const heap = new MinHeap<number>({ compare: compareNumbers });

    heap.insert(8);
    heap.insert(3);
    heap.insert(5);
    heap.insert(1);
    heap.insert(4);

    expect(heap.peek()).toBe(1);
    expectMinHeapProperty(heap, compareNumbers);

    expect(heap.extractMin()).toBe(1);
    expect(heap.peek()).toBe(3);
    expect(heap.extractMin()).toBe(3);
    expect(heap.extractMin()).toBe(4);
    expect(heap.extractMin()).toBe(5);
    expect(heap.extractMin()).toBe(8);
    expect(heap.extractMin()).toBeUndefined();
  });

  it('maintains heap property after every reheapification step', (): void => {
    const heap = new MinHeap<number>({ compare: compareNumbers });
    const values = [9, 2, 7, 1, 6, 3, 8, 4, 5];

    for (const value of values) {
      heap.insert(value);
      expectMinHeapProperty(heap, compareNumbers);
      expect(heap.peek()).toBe(Math.min(...heap.toArray()));
    }

    while (!heap.isEmpty) {
      heap.extractMin();
      expectMinHeapProperty(heap, compareNumbers);

      if (!heap.isEmpty) {
        expect(heap.peek()).toBe(Math.min(...heap.toArray()));
      }
    }
  });

  it('supports task scheduling by extracting the earliest run time first', (): void => {
    const heap = new MinHeap<ScheduledTask>({ compare: compareByTime });

    heap.insert({ id: 'market-close', runAt: new Date('2026-03-16T15:00:00.000Z') });
    heap.insert({ id: 'pre-open', runAt: new Date('2026-03-16T08:55:00.000Z') });
    heap.insert({ id: 'midday-check', runAt: new Date('2026-03-16T11:30:00.000Z') });

    expect(heap.peek()?.id).toBe('pre-open');
    expect(heap.extractMin()?.id).toBe('pre-open');
    expect(heap.extractMin()?.id).toBe('midday-check');
    expect(heap.extractMin()?.id).toBe('market-close');
  });

  it('exposes stats, supports clearing, and preserves O(1)-style peek semantics', (): void => {
    const heap = new MinHeap<number>({ compare: compareNumbers });

    heap.insert(7);
    heap.insert(2);
    heap.insert(9);
    heap.insert(4);

    expect(heap.peek()).toBe(2);
    expect(heap.peek()).toBe(2);
    expect(heap.getStats()).toEqual({
      size: 4,
      isEmpty: false,
      lastLevelSize: 1,
      height: 3,
    });

    heap.clear();

    expect(heap.size).toBe(0);
    expect(heap.isEmpty).toBe(true);
    expect(heap.peek()).toBeUndefined();
    expect(heap.extractMin()).toBeUndefined();
    expect(heap.getStats()).toEqual({
      size: 0,
      isEmpty: true,
      lastLevelSize: 0,
      height: 0,
    });
  });

  it('rejects missing comparator functions', (): void => {
    expect(() => new MinHeap<number>({ compare: undefined as never })).toThrowError(
      'compare must be a function',
    );
  });
});
