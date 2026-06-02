import { RingBuffer } from '../../data-structures/ring-buffer.js';

export interface RelativeStrengthIndexPoint {
  readonly index: number;
  readonly value: number;
}

export class RelativeStrengthIndex {
  private readonly gainWindow: RingBuffer<number>;
  private readonly lossWindow: RingBuffer<number>;
  private previousPrice: number | null = null;
  private gainSum = 0;
  private lossSum = 0;

  public constructor(private readonly period: number) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new Error('period must be a positive integer');
    }

    this.gainWindow = new RingBuffer<number>(period);
    this.lossWindow = new RingBuffer<number>(period);
  }

  public calculate(prices: readonly number[]): RelativeStrengthIndexPoint[] {
    this.reset();

    const points: RelativeStrengthIndexPoint[] = [];

    prices.forEach((price, index) => {
      const point = this.push(price, index);

      if (point !== null) {
        points.push(point);
      }
    });

    return points;
  }

  public push(price: number, index: number): RelativeStrengthIndexPoint | null {
    this.ensureFiniteNumber(price, 'price');
    this.ensureNonNegativeInteger(index, 'index');

    if (this.previousPrice === null) {
      this.previousPrice = price;
      return null;
    }

    const delta = price - this.previousPrice;
    const gain = Math.max(delta, 0);
    const loss = Math.max(-delta, 0);

    if (this.gainWindow.isFull) {
      this.gainSum -= this.gainWindow.peekOldest() ?? 0;
      this.lossSum -= this.lossWindow.peekOldest() ?? 0;
    }

    this.gainWindow.push(gain);
    this.lossWindow.push(loss);
    this.gainSum += gain;
    this.lossSum += loss;
    this.previousPrice = price;

    if (!this.gainWindow.isFull) {
      return null;
    }

    const averageGain = this.gainSum / this.period;
    const averageLoss = this.lossSum / this.period;

    if (averageLoss === 0) {
      return {
        index,
        value: averageGain === 0 ? 50 : 100,
      };
    }

    const relativeStrength = averageGain / averageLoss;
    const value = 100 - 100 / (1 + relativeStrength);

    return {
      index,
      value,
    };
  }

  public reset(): void {
    this.gainWindow.clear();
    this.lossWindow.clear();
    this.previousPrice = null;
    this.gainSum = 0;
    this.lossSum = 0;
  }

  private ensureFiniteNumber(value: number, name: string): void {
    if (!Number.isFinite(value)) {
      throw new Error(`${name} must be a finite number`);
    }
  }

  private ensureNonNegativeInteger(value: number, name: string): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer`);
    }
  }
}
