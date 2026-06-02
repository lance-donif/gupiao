import { describe, expect, it } from 'vitest';

import {
  ExponentialMovingAverage,
  MovingAverageConvergenceDivergence,
  RelativeStrengthIndex,
  SimpleMovingAverage,
} from '../../../../src/algorithms/series/index.js';

describe('series algorithms', () => {
  it('computes SMA correctly for known rolling windows', () => {
    const algorithm = new SimpleMovingAverage(3);
    const result = algorithm.calculate([1, 2, 3, 4, 5]);

    expect(result).toEqual([
      { index: 2, value: 2 },
      { index: 3, value: 3 },
      { index: 4, value: 4 },
    ]);
  });

  it('computes EMA using the recursive smoothing formula exactly', () => {
    const algorithm = new ExponentialMovingAverage(3);
    const result = algorithm.calculate([10, 11, 13, 12]);

    expect(result.map((point) => point.value)).toEqual([10, 10.5, 11.75, 11.875]);
  });

  it('keeps RSI values within [0, 100] and handles edge cases', () => {
    const rising = new RelativeStrengthIndex(3).calculate([1, 2, 3, 4]);
    const flat = new RelativeStrengthIndex(3).calculate([5, 5, 5, 5]);
    const mixed = new RelativeStrengthIndex(3).calculate([10, 8, 9, 7, 8, 6, 9]);

    expect(rising.at(-1)?.value).toBe(100);
    expect(flat.at(-1)?.value).toBe(50);

    for (const point of mixed) {
      expect(point.value).toBeGreaterThanOrEqual(0);
      expect(point.value).toBeLessThanOrEqual(100);
    }
  });

  it('computes MACD DIF, DEA, and histogram from EMA components', () => {
    const prices = [10, 11, 12, 11, 13];
    const algorithm = new MovingAverageConvergenceDivergence({
      shortPeriod: 3,
      longPeriod: 5,
      signalPeriod: 2,
    });
    const result = algorithm.calculate(prices);

    const rounded = result.map((point) => {
      return {
        index: point.index,
        dif: Number(point.dif.toFixed(6)),
        dea: Number(point.dea.toFixed(6)),
        histogram: Number(point.histogram.toFixed(6)),
      };
    });

    expect(rounded).toEqual([
      { index: 0, dif: 0, dea: 0, histogram: 0 },
      { index: 1, dif: 0.166667, dea: 0.111111, histogram: 0.055556 },
      { index: 2, dif: 0.361111, dea: 0.277778, histogram: 0.083333 },
      { index: 3, dif: 0.199074, dea: 0.225309, histogram: -0.026235 },
      { index: 4, dif: 0.445216, dea: 0.371914, histogram: 0.073302 },
    ]);
  });

  it('validates indicator parameters', () => {
    expect(() => new SimpleMovingAverage(0)).toThrowError('period must be a positive integer');
    expect(() => new ExponentialMovingAverage(0)).toThrowError('period must be a positive integer');
    expect(() => new RelativeStrengthIndex(0)).toThrowError('period must be a positive integer');
    expect(
      () =>
        new MovingAverageConvergenceDivergence({
          shortPeriod: 5,
          longPeriod: 5,
        }),
    ).toThrowError('shortPeriod must be less than longPeriod');
  });
});
