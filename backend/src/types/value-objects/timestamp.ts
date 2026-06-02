import { BaseValueObject } from './base-value-object.js';

export class Timestamp extends BaseValueObject<number> {
  private constructor(value: number) {
    super(value);
  }

  public static from(raw: Date | string | number): Timestamp {
    const date = raw instanceof Date ? new Date(raw.getTime()) : new Date(raw);
    const epochMilliseconds = date.getTime();

    if (Number.isNaN(epochMilliseconds)) {
      throw new Error(`Invalid timestamp: ${String(raw)}`);
    }

    return new Timestamp(epochMilliseconds);
  }

  public toDate(): Date {
    return new Date(this.value);
  }

  public override valueOf(): number {
    return this.value;
  }

  public toISOString(): string {
    return this.toDate().toISOString();
  }
}
