import { RingBuffer } from '../../data-structures/ring-buffer.js';

export interface SimpleMovingAveragePoint {
  readonly index: number;
  readonly value: number;
}

export class SimpleMovingAverage {
  private readonly window: RingBuffer<number>;
  private runningSum = 0;

  public constructor(private readonly period: number) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new Error('period must be a positive integer');
    }

    this.window = new RingBuffer<number>(period);
  }

  public calculate(values: readonly number[]): SimpleMovingAveragePoint[] {
    this.reset();

    const points: SimpleMovingAveragePoint[] = [];

    values.forEach((value, index) => {
      points.push(...this.push(value, index));
    });

    return points;
  }

  public push(value: number, index: number): SimpleMovingAveragePoint[] {
    this.ensureFiniteNumber(value, 'value');
    this.ensureNonNegativeInteger(index, 'index');

    if (this.window.isFull) {
      this.runningSum -= this.window.peekOldest() ?? 0;
    }

    this.window.push(value);
    this.runningSum += value;

    if (!this.window.isFull) {
      return [];
    }

    return [
      {
        index,
        value: this.runningSum / this.period,
      },
    ];
  }

  public reset(): void {
    this.window.clear();
    this.runningSum = 0;
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
