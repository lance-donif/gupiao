import { describe, expect, it } from 'vitest';

import { syncAndVerifyStockExposureFacts } from '../../../scripts/run-daily-recommendation.js';
import { resolveNextWeekdayAsOf, refineAsOfWithTradingCalendar, resolveWeekendExpectedTradingDay } from '../../../scripts/run-daily-recommendation.js';
import { shiftBeijingDay } from '../../../src/lib/beijing-time.js';

class MockExposurePrismaClient {
  public constructor(
    private readonly factCount = 500,
    private readonly latestValidFrom: Date | null = new Date('2026-04-01T00:00:00.000Z'),
  ) {}

  public readonly stockExposureFact = {
    count: async () => this.factCount,
    groupBy: async (args: { by: readonly string[] }) => {
      if (args.by.includes('symbol')) {
        return [{ symbol: '000001', _count: { _all: 3 } }];
      }
      return [{ keyword: '银行', _count: { _all: 3 } }];
    },
    findMany: async () => [
      {
        symbol: '000001',
        stockName: '平安银行',
        keyword: '银行',
        exposureType: 'industry_exposure',
        taxonomyLevel: 'SW3',
        source: 'tickflow_sw_universe',
        sourceId: 'CN_Equity_SW3_850101',
        confidence: { toString: () => '0.92' },
        memberCount: 12,
      },
    ],
    aggregate: async () => ({
      _max: {
        validFrom: this.latestValidFrom,
      },
    }),
  };
}

describe('run daily recommendation stock exposure sync', () => {
  it('syncs TickFlow exposure when monthly data is stale', async () => {
    const syncCalls: unknown[] = [];
    const prisma = new MockExposurePrismaClient();

    const result = await syncAndVerifyStockExposureFacts({
      prisma,
      traceId: 'trace-main-2026-06-02-test',
      clusterKey: 'main',
      asOf: new Date('2026-06-02T15:59:59.999Z'),
      minExposureFacts: 500,
      tickFlowRefreshIntervalDays: 30,
      stockNameBySymbol: new Map([['000001', '平安银行']]),
      syncService: {
        sync: async (_db, input) => {
          syncCalls.push(input);
          return {
            universeCount: 1,
            acceptedUniverseCount: 1,
            promotedFactCount: 500,
          };
        },
      },
    });

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0]).toEqual(expect.objectContaining({
      traceId: 'trace-main-2026-06-02-test',
      clusterKey: 'main',
      stockNameBySymbol: new Map([['000001', '平安银行']]),
    }));
    expect(result.syncResult).toEqual(expect.objectContaining({
      mode: 'synced_stale_or_insufficient',
      skippedSync: false,
      upstreamSyncResult: expect.objectContaining({
        promotedFactCount: 500,
      }),
    }));
    expect(result.exposureResult).toEqual(expect.objectContaining({
      factCount: 500,
      symbolCount: 1,
      keywordCount: 1,
      minExposureFacts: 500,
    }));
  });

  it('skips TickFlow exposure sync when monthly data is fresh enough', async () => {
    const syncCalls: unknown[] = [];
    const prisma = new MockExposurePrismaClient(
      500,
      new Date('2026-05-20T00:00:00.000Z'),
    );

    const result = await syncAndVerifyStockExposureFacts({
      prisma,
      traceId: 'trace-main-2026-06-02-test',
      clusterKey: 'main',
      asOf: new Date('2026-06-02T15:59:59.999Z'),
      minExposureFacts: 500,
      tickFlowRefreshIntervalDays: 30,
      stockNameBySymbol: new Map([['000001', '平安银行']]),
      syncService: {
        sync: async (_db, input) => {
          syncCalls.push(input);
          return {
            universeCount: 1,
            acceptedUniverseCount: 1,
            promotedFactCount: 500,
          };
        },
      },
    });

    expect(syncCalls).toHaveLength(0);
    expect(result.syncResult).toEqual(expect.objectContaining({
      mode: 'skip_fresh_monthly_cache',
      skippedSync: true,
      reason: 'tickflow_sw_universe_fresh_enough',
    }));
    expect(result.exposureResult).toEqual(expect.objectContaining({
      factCount: 500,
      symbolCount: 1,
      keywordCount: 1,
      minExposureFacts: 500,
    }));
  });
});

describe('trading-day-aware candle gate', () => {
  it('shifts Beijing days across month boundaries', () => {
    expect(shiftBeijingDay('2026-09-13', -2)).toBe('2026-09-11');
    expect(shiftBeijingDay('2026-09-01', -1)).toBe('2026-08-31');
    expect(shiftBeijingDay('2026-09-11', 3)).toBe('2026-09-14');
  });

  it('maps weekend asOf to Friday without network', () => {
    // 2026-09-12 Sat, 2026-09-13 Sun, 2026-09-11 Fri, 2026-09-14 Mon.
    expect(resolveWeekendExpectedTradingDay('2026-09-12', 6)).toBe('2026-09-11');
    expect(resolveWeekendExpectedTradingDay('2026-09-13', 0)).toBe('2026-09-11');
    expect(resolveWeekendExpectedTradingDay('2026-09-14', 1)).toBeNull();
    expect(resolveWeekendExpectedTradingDay('2026-09-11', 5)).toBeNull();
  });
});

describe('next-weekday default asOf (前一晚跑下一交易日)', () => {
  const expectAsOfDay = (asOf: Date, expectedDay: string): void => {
    expect(asOf.toISOString()).toBe(new Date(`${expectedDay}T16:00:00.000+08:00`).toISOString());
  };

  it('周日运行 → 目标为周一 16:00（用户诉求：前一天跑周一的推荐）', () => {
    // 2026-10-11 周日 20:00 北京
    expectAsOfDay(resolveNextWeekdayAsOf(new Date('2026-10-11T12:00:00.000Z')), '2026-10-12');
  });

  it('周一至周四运行 → 目标为次日 16:00', () => {
    expectAsOfDay(resolveNextWeekdayAsOf(new Date('2026-10-12T12:00:00.000Z')), '2026-10-13'); // 周一
    expectAsOfDay(resolveNextWeekdayAsOf(new Date('2026-10-15T12:00:00.000Z')), '2026-10-16'); // 周四
  });

  it('周五/周六运行 → 目标为下周一 16:00', () => {
    expectAsOfDay(resolveNextWeekdayAsOf(new Date('2026-10-16T12:00:00.000Z')), '2026-10-19'); // 周五
    expectAsOfDay(resolveNextWeekdayAsOf(new Date('2026-10-17T12:00:00.000Z')), '2026-10-19'); // 周六
  });
});

describe('trading-calendar asOf refinement', () => {
  const makeCalendarPrisma = (rows: readonly { day_key: string; is_open: boolean }[]): any => ({
    $queryRaw: async () => rows.map(row => ({ day_key: row.day_key, is_open: row.is_open })),
  });

  it('目标日为交易日 → 不修正', async () => {
    const asOf = new Date('2026-10-12T16:00:00.000+08:00'); // 周一，开市
    const prisma = makeCalendarPrisma([
      { day_key: '2026-10-12', is_open: true },
      { day_key: '2026-10-13', is_open: true },
    ]);
    await expect(refineAsOfWithTradingCalendar(prisma, asOf)).resolves.toBe(asOf);
  });

  it('目标日休市（节假日）→ 推进到下一个开市日 16:00', async () => {
    const asOf = new Date('2026-10-01T16:00:00.000+08:00'); // 国庆周四，休市
    const prisma = makeCalendarPrisma([
      { day_key: '2026-10-01', is_open: false },
      { day_key: '2026-10-02', is_open: false },
      { day_key: '2026-10-05', is_open: true },
    ]);
    const refined = await refineAsOfWithTradingCalendar(prisma, asOf);
    expect(refined.toISOString()).toBe(new Date('2026-10-05T16:00:00.000+08:00').toISOString());
  });

  it('日历表无数据 → 保留本地推导结果（不抛错、不阻断）', async () => {
    const asOf = new Date('2026-10-12T16:00:00.000+08:00');
    await expect(refineAsOfWithTradingCalendar(makeCalendarPrisma([]), asOf)).resolves.toBe(asOf);
  });

  it('prisma 无 $queryRaw（mock 兼容）→ 原样返回', async () => {
    const asOf = new Date('2026-10-12T16:00:00.000+08:00');
    await expect(refineAsOfWithTradingCalendar({}, asOf)).resolves.toBe(asOf);
  });

  it('15 天窗口内无开市日 → 保留本地推导结果', async () => {
    const asOf = new Date('2026-10-12T16:00:00.000+08:00');
    const prisma = makeCalendarPrisma([{ day_key: '2026-10-12', is_open: false }]);
    await expect(refineAsOfWithTradingCalendar(prisma, asOf)).resolves.toBe(asOf);
  });

  it('日历查询失败 → 保留本地推导结果', async () => {
    const asOf = new Date('2026-10-12T16:00:00.000+08:00');
    const brokenPrisma = {
      $queryRaw: async () => {
        throw new Error('db down');
      },
    };
    await expect(refineAsOfWithTradingCalendar(brokenPrisma, asOf)).resolves.toBe(asOf);
  });
});
