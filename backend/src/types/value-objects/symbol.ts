import { BaseValueObject } from './base-value-object.js';

const SYMBOL_PATTERN = /^\d{6}$/;

export class Symbol extends BaseValueObject<string> {
  private constructor(value: string) {
    super(value);
  }

  public static from(raw: string): Symbol {
    if (!SYMBOL_PATTERN.test(raw)) {
      throw new Error(`Invalid symbol: ${raw}`);
    }

    return new Symbol(raw);
  }

  public override toString(): string {
    return this.value;
  }
}
