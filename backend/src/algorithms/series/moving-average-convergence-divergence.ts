import type { ExponentialMovingAveragePoint } from './exponential-moving-average.js';
import {
  ExponentialMovingAverage,

} from './exponential-moving-average.js';

export interface MovingAverageConvergenceDivergencePoint {
  readonly index: number;
  readonly dif: number;
  readonly dea: number;
  readonly histogram: number;
}

export interface MovingAverageConvergenceDivergenceOptions {
  readonly shortPeriod?: number;
  readonly longPeriod?: number;
  readonly signalPeriod?: number;
}

export class MovingAverageConvergenceDivergence {
  private readonly shortEma: ExponentialMovingAverage;
  private readonly longEma: ExponentialMovingAverage;
  private readonly signalEma: ExponentialMovingAverage;

  public constructor(options: MovingAverageConvergenceDivergenceOptions = {}) {
    const shortPeriod = options.shortPeriod ?? 12;
    const longPeriod = options.longPeriod ?? 26;
    const signalPeriod = options.signalPeriod ?? 9;

    if (!Number.isInteger(shortPeriod) || shortPeriod <= 0) {
      throw new Error('shortPeriod must be a positive integer');
    }

    if (!Number.isInteger(longPeriod) || longPeriod <= 0) {
      throw new Error('longPeriod must be a positive integer');
    }

    if (!Number.isInteger(signalPeriod) || signalPeriod <= 0) {
      throw new Error('signalPeriod must be a positive integer');
    }

    if (shortPeriod >= longPeriod) {
      throw new Error('shortPeriod must be less than longPeriod');
    }

    this.shortEma = new ExponentialMovingAverage(shortPeriod);
    this.longEma = new ExponentialMovingAverage(longPeriod);
    this.signalEma = new ExponentialMovingAverage(signalPeriod);
  }

  public calculate(prices: readonly number[]): MovingAverageConvergenceDivergencePoint[] {
    this.reset();

    return prices.map((price, index) => {
      return this.push(price, index);
    });
  }

  public push(price: number, index: number): MovingAverageConvergenceDivergencePoint {
    const shortPoint = this.shortEma.push(price, index);
    const longPoint = this.longEma.push(price, index);
    const dif = shortPoint.value - longPoint.value;
    const deaPoint = this.signalEma.push(dif, index);

    return {
      index,
      dif,
      dea: deaPoint.value,
      histogram: dif - deaPoint.value,
    };
  }

  public reset(): void {
    this.shortEma.reset();
    this.longEma.reset();
    this.signalEma.reset();
  }

  public calculateDifSeries(prices: readonly number[]): readonly number[] {
    return this.calculate(prices).map(point => point.dif);
  }

  public calculateSignalSeries(prices: readonly number[]): readonly number[] {
    return this.calculate(prices).map(point => point.dea);
  }

  public calculateHistogramSeries(prices: readonly number[]): readonly number[] {
    return this.calculate(prices).map(point => point.histogram);
  }

  public calculateEmaSeries(prices: readonly number[], period: number): readonly ExponentialMovingAveragePoint[] {
    const ema = new ExponentialMovingAverage(period);
    return ema.calculate(prices);
  }
}
