/**
 * 版本化交易日历。
 *
 * 设计要点：
 *  - 主数据源是 TradingCalendarDay 表（按 exchange + calendarVersion 维度），由导入脚本
 *    （scripts/import-trading-calendar.ts）从 Candle 反推真实交易日填充。
 *  - 缺覆盖年份 / 缺覆盖日期必须返回「数据缺口」（CalendarCoverageGapError），
 *    **不得**继续按「非周末非假期即交易日」的工作日推断。
 *  - 旧有的 defaultTradingCalendar（硬编码 2024–2025 假期 + 工作日推断）仅作为显式
 *    fallback 保留，默认不再启用。
 */
const FIXED_HOLIDAYS = new Set<string>([
  '2024-01-01',
  '2024-02-09',
  '2024-02-12',
  '2024-02-13',
  '2024-02-14',
  '2024-02-15',
  '2024-02-16',
  '2024-04-04',
  '2024-04-05',
  '2024-05-01',
  '2024-05-02',
  '2024-05-03',
  '2024-06-10',
  '2024-09-16',
  '2024-09-17',
  '2024-10-01',
  '2024-10-02',
  '2024-10-03',
  '2024-10-04',
  '2024-10-07',
  '2025-01-01',
  '2025-01-28',
  '2025-01-29',
  '2025-01-30',
  '2025-01-31',
  '2025-02-03',
  '2025-02-04',
  '2025-04-04',
  '2025-05-01',
  '2025-05-02',
  '2025-06-02',
  '2025-10-01',
  '2025-10-02',
  '2025-10-03',
  '2025-10-06',
  '2025-10-07',
  '2025-10-08',
]);

const formatTradeDate = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');

  return `${year}-${month}-${day}`;
};

/** 交易日历数据缺口：请求日期不在已加载版本的覆盖范围内。 */
export class CalendarCoverageGapError extends Error {
  public readonly date: string;

  public readonly calendarVersion: string;

  public constructor(date: string, calendarVersion: string) {
    super(`交易日历数据缺口：日期 ${date} 不在版本 ${calendarVersion} 的覆盖范围内`);
    this.name = 'CalendarCoverageGapError';
    this.date = date;
    this.calendarVersion = calendarVersion;
  }
}

export interface TradingDayResolution {
  /** 该日期是否在已加载日历的覆盖范围内。 */
  readonly covered: boolean;
  /** covered 为 true 时：是否开市；covered 为 false 时为 null。 */
  readonly isOpen: boolean | null;
}

export interface TradingCalendar {
  readonly calendarVersion: string;
  /** 是否在开市日；未覆盖时抛出 CalendarCoverageGapError。 */
  isTradingDay(date: Date): boolean;
  /** 安全解析：返回覆盖信息与开市标记，不抛错。 */
  resolve(date: Date): TradingDayResolution;
  /** 下一交易日（direction=forward 向未来 / backward 向过去）；超出覆盖返回 null。 */
  nextTradingDay(date: Date, direction?: 'forward' | 'backward'): Date | null;
}

/** 旧版：硬编码假期 + 工作日推断。仅在显式 fallback 时启用，默认不再使用。 */
export class LegacyTradingCalendar implements TradingCalendar {
  private constructor(private readonly holidays: ReadonlySet<string>, public readonly calendarVersion = 'legacy') {
    Object.freeze(this);
  }

  public static createDefault(): LegacyTradingCalendar {
    return new LegacyTradingCalendar(FIXED_HOLIDAYS);
  }

  public isTradingDay(date: Date): boolean {
    const dayOfWeek = date.getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return false;
    }
    return !this.holidays.has(formatTradeDate(date));
  }

  public resolve(date: Date): TradingDayResolution {
    return { covered: true, isOpen: this.isTradingDay(date) };
  }

  public nextTradingDay(date: Date, direction: 'forward' | 'backward' = 'forward'): Date {
    const step = direction === 'forward' ? 1 : -1;
    let cursor = new Date(date.getTime());
    for (let i = 0; i < 400; i += 1) {
      cursor = new Date(cursor.getTime() + step * 24 * 60 * 60 * 1000);
      if (this.isTradingDay(cursor)) {
        return cursor;
      }
    }
    return date;
  }
}

/** 版本化交易日历：数据来自 TradingCalendarDay 表，未覆盖即数据缺口。 */
export class VersionedTradingCalendar implements TradingCalendar {
  private constructor(
    private readonly byDate: ReadonlyMap<string, boolean>,
    private readonly coveredYears: ReadonlySet<number>,
    public readonly calendarVersion: string,
    public readonly exchange: string,
  ) {}

  public static createEmpty(calendarVersion: string, exchange: string): VersionedTradingCalendar {
    return new VersionedTradingCalendar(new Map(), new Set(), calendarVersion, exchange);
  }

  public static async load(
    prisma: any,
    opts: { readonly exchange: string; readonly calendarVersion: string },
  ): Promise<VersionedTradingCalendar> {
    const byDate = new Map<string, boolean>();
    const coveredYears = new Set<number>();
    if (prisma && typeof prisma.tradingCalendarDay?.findMany === 'function') {
      const rows = await prisma.tradingCalendarDay.findMany({
        where: { exchange: opts.exchange, calendarVersion: opts.calendarVersion },
        select: { date: true, isOpen: true },
      });
      for (const row of rows) {
        const date = row.date instanceof Date ? row.date : new Date(row.date);
        const key = formatTradeDate(date);
        byDate.set(key, Boolean(row.isOpen));
        coveredYears.add(date.getUTCFullYear());
      }
    }
    return new VersionedTradingCalendar(byDate, coveredYears, opts.calendarVersion, opts.exchange);
  }

  public hasAnyData(): boolean {
    return this.byDate.size > 0;
  }

  public isTradingDay(date: Date): boolean {
    const resolution = this.resolve(date);
    if (!resolution.covered) {
      throw new CalendarCoverageGapError(formatTradeDate(date), this.calendarVersion);
    }
    return resolution.isOpen === true;
  }

  public resolve(date: Date): TradingDayResolution {
    const year = date.getUTCFullYear();
    if (!this.coveredYears.has(year)) {
      return { covered: false, isOpen: null };
    }
    return { covered: true, isOpen: this.byDate.get(formatTradeDate(date)) ?? false };
  }

  public nextTradingDay(date: Date, direction: 'forward' | 'backward' = 'forward'): Date | null {
    const step = direction === 'forward' ? 1 : -1;
    let cursor = new Date(date.getTime());
    for (let i = 0; i < 400; i += 1) {
      cursor = new Date(cursor.getTime() + step * 24 * 60 * 60 * 1000);
      const resolution = this.resolve(cursor);
      if (!resolution.covered) {
        return null;
      }
      if (resolution.isOpen) {
        return cursor;
      }
    }
    return null;
  }
}

export const defaultTradingCalendar = LegacyTradingCalendar.createDefault();

/**
 * 加载交易日历：
 *  - 优先返回版本化数据（TradingCalendarDay 表）。
 *  - 若该版本无任何数据：fallbackToLegacy=true 时退回旧版工作日推断；否则返回空版本化
 *    日历（任何日期都会触发 CalendarCoverageGapError，显式暴露数据缺口）。
 */
export async function loadTradingCalendar(
  prisma: any,
  opts: {
    readonly exchange: string;
    readonly calendarVersion: string;
    readonly fallbackToLegacy?: boolean;
  },
): Promise<TradingCalendar> {
  const versioned = await VersionedTradingCalendar.load(prisma, opts);
  if (versioned.hasAnyData()) {
    return versioned;
  }
  if (opts.fallbackToLegacy) {
    return defaultTradingCalendar;
  }
  return versioned;
}
