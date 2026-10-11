/**
 * 北京时区工具（单一事实源）。
 *
 * 本仓的日期键必须按**北京自然日**归属，不能用服务器本地时区的
 * `toISOString().slice(0,10)`（那是 UTC 日）敷衍。此前同一语义散落了10 处实现，
 * 其中 5 处直接写死 `8 * 60 * 60 * 1000`，一旦改为非 UTC+8 部署就会静默错日。
 */

const BEIJING_TIME_ZONE = 'Asia/Shanghai';
/** 北京相对 UTC 的固定偏移（Asia/Shanghai 自 1991 年起无夏令时）。 */
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 北京自然日键（YYYY-MM-DD）。
 *
 * 走 Intl 时区库而非手算偏移：不依赖宿主机 tzdata 是否完整，
 * 也不会因为 refactor 时把 +8h 写错。
 */
export function toBeijingDayKey(value: Date | string | number = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`toBeijingDayKey: invalid date input ${String(value)}`);
  }
  return BEIJING_DATE_FORMATTER.format(date);
}

const BEIJING_DATE_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  timeZone: BEIJING_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * 北京自然日加减天数。纯日历运算，不涉时区换算。
 * @param dayKey 形如 `2026-06-29` 的北京自然日
 */
export function shiftBeijingDay(dayKey: string, days: number): string {
  const date = new Date(`${dayKey}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`shiftBeijingDay: invalid day key ${dayKey}`);
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * 北京自然日窗口的 [gte, lt) UTC 边界。
 *
 * 与 {@link toBeijingDayKey} 的区别：这里返回的是时间区间而非日期键，
 * 且采用「先拨到北京、再按 UTC 归零」的分桶口径 —— 这是发布记录按日分桶的算法，
 * 与推荐/行情的交易日键口径不同，publish-recommendation 一直在用这个算法。
 * 返回键名直接对齐 Prisma 的 DateTimeFilter，可整体展开赋值。
 */
export function beijingDayWindow(value: Date | string | number = new Date()): { gte: Date; lt: Date } {
  const date = value instanceof Date ? value : new Date(value);
  const shifted = new Date(date.getTime() - BEIJING_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return {
    gte: shifted,
    lt: new Date(shifted.getTime() + 24 * 60 * 60 * 1000),
  };
}