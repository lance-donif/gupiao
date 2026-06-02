export interface ExponentialMovingAveragePoint {
  readonly index: number;
  readonly value: number;
}

export class ExponentialMovingAverage {
  private readonly multiplier: number;
  private previousValue: number | null = null;

  public constructor(period: number) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new Error('period must be a positive integer');
    }

    this.multiplier = 2 / (period + 1);
  }

  public calculate(values: readonly number[]): ExponentialMovingAveragePoint[] {
    this.reset();

    return values.map((value, index) => {
      return this.push(value, index);
    });
  }

  public push(value: number, index: number): ExponentialMovingAveragePoint {
    this.ensureFiniteNumber(value, 'value');
    this.ensureNonNegativeInteger(index, 'index');

    const nextValue
      = this.previousValue === null
        ? value
        : this.multiplier * value + (1 - this.multiplier) * this.previousValue;

    this.previousValue = nextValue;

    return {
      index,
      value: nextValue,
    };
  }

  public reset(): void {
    this.previousValue = null;
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
