import { toBeijingDayKey } from '../lib/beijing-time.js';

/** A daily close is available only after the exchange's 15:00 Beijing close. */
export function dailyCloseVisibleAt(tradingDay: Date): Date {
  const day = toBeijingDayKey(tradingDay);
  return new Date(Math.max(tradingDay.getTime(), new Date(`${day}T15:00:00+08:00`).getTime()));
}

export function visibleYields(row: Record<string, unknown>, asOf: Date): unknown[] {
  return [1, 3, 5].flatMap(days => {
    const timestamp = row[`yield${days}DayVisibleAt`];
    if (timestamp == null) return [];
    const visibleAt = new Date(timestamp as string | Date).getTime();
    return Number.isFinite(visibleAt) && visibleAt <= asOf.getTime() ? [row[`yield${days}Day`]] : [];
  });
}
