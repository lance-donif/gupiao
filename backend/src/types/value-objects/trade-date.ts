import { BaseValueObject } from './base-value-object.js';
import { defaultTradingCalendar } from './trading-calendar.js';

const toUtcMidnight = (raw: Date | string | number): Date => {
  const parsedDate = raw instanceof Date ? new Date(raw.getTime()) : new Date(raw);
  const epochMilliseconds = parsedDate.getTime();

  if (Number.isNaN(epochMilliseconds)) {
    throw new Error(`Invalid trade date: ${String(raw)}`);
  }

  return new Date(
    Date.UTC(
      parsedDate.getUTCFullYear(),
      parsedDate.getUTCMonth(),
      parsedDate.getUTCDate(),
    ),
  );
};

export class TradeDate extends BaseValueObject<number> {
  private constructor(value: number) {
    super(value);
  }

  public static from(raw: Date | string | number): TradeDate {
    const normalizedDate = toUtcMidnight(raw);

    if (!defaultTradingCalendar.isTradingDay(normalizedDate)) {
      throw new Error(`Not a trading day: ${normalizedDate.toISOString().slice(0, 10)}`);
    }

    return new TradeDate(normalizedDate.getTime());
  }

  public toDate(): Date {
    return new Date(this.value);
  }

  public override valueOf(): number {
    return this.value;
  }

  public override toString(): string {
    return this.toDate().toISOString().slice(0, 10);
  }
}
