import { describe, expect, it } from 'vitest';

import { RingBuffer } from '../../../src/data-structures/ring-buffer.js';

const computeMovingAverage = (values: readonly number[], windowSize: number): number[] => {
  const buffer = new RingBuffer<number>(windowSize);
  const averages: number[] = [];

  for (const value of values) {
    buffer.push(value);

    if (buffer.isFull) {
      const windowValues = buffer.toArray();
      const sum = windowValues.reduce((total, current) => total + current, 0);
      averages.push(sum / windowValues.length);
    }
  }

  return averages;
};

describe('RingBuffer', () => {
  it('supports O(1)-style writes and preserves insertion order before reaching capacity', () => {
    const buffer = new RingBuffer<number>(4);

    buffer.push(10);
    buffer.push(20);
    buffer.push(30);

    expect(buffer.size).toBe(3);
    expect(buffer.isEmpty).toBe(false);
    expect(buffer.isFull).toBe(false);
    expect(buffer.peekOldest()).toBe(10);
    expect(buffer.peekNewest()).toBe(30);
    expect(buffer.toArray()).toEqual([10, 20, 30]);
    expect(buffer.at(0)).toBe(10);
    expect(buffer.at(2)).toBe(30);
  });

  it('overwrites the oldest value when the buffer is full', () => {
    const buffer = new RingBuffer<string>(3);

    buffer.push('A');
    buffer.push('B');
    buffer.push('C');
    buffer.push('D');
    buffer.push('E');

    expect(buffer.size).toBe(3);
    expect(buffer.isFull).toBe(true);
    expect(buffer.peekOldest()).toBe('C');
    expect(buffer.peekNewest()).toBe('E');
    expect(buffer.toArray()).toEqual(['C', 'D', 'E']);
  });

  it('provides stats and supports clearing the buffer', () => {
    const buffer = new RingBuffer<number>(2);

    buffer.push(1);
    buffer.push(2);

    expect(buffer.getStats()).toEqual({
      capacity: 2,
      size: 2,
      isFull: true,
      oldestIndex: 0,
      newestIndex: 1,
    });

    buffer.clear();

    expect(buffer.size).toBe(0);
    expect(buffer.isEmpty).toBe(true);
    expect(buffer.peekOldest()).toBeUndefined();
    expect(buffer.peekNewest()).toBeUndefined();
    expect(buffer.toArray()).toEqual([]);
  });

  it('correctly computes a moving average over a fixed-size window', () => {
    const averages = computeMovingAverage([1, 2, 3, 4, 5], 3);

    expect(averages).toEqual([2, 3, 4]);
  });

  it('rejects invalid capacity and invalid index access', () => {
    expect(() => new RingBuffer<number>(0)).toThrowError('capacity must be a positive integer');

    const buffer = new RingBuffer<number>(2);

    expect(() => buffer.at(-1)).toThrowError('index must be a non-negative integer');

    buffer.push(1);
    expect(() => buffer.at(1)).toThrowError('index is out of range');
  });
});
