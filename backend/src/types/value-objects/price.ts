import { BaseValueObject } from './base-value-object.js';

export class Price extends BaseValueObject<number> {
  private constructor(value: number) {
    super(value);
  }

  public static from(raw: number): Price {
    if (!Number.isFinite(raw) || raw < 0) {
      throw new Error(`Invalid price: ${raw}`);
    }

    return new Price(Math.round(raw * 100) / 100);
  }

  public override valueOf(): number {
    return this.value;
  }
}
