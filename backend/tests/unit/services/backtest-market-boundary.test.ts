/**
 * M5 回测行情边界单测：
 *  - 默认 permissive 行情准入（只记录 unknown adjType 计数，不阻断每日推荐链路）
 *  - strictDataAdmission=true 时抛 StrictBacktestRejectedError（M7 评估 / 验收显式开启）
 *  - assertStrictMarketDataAdmission 同步入口（供 M7 评估 / 验收路径显式调用）
 *  - readCandles 派生的 base/future 窗口切分：业务时间 ∧ 可信可见时间双边界
 *  - StockStatusHistory 数据缺口：跳过标的、行业保持 null、绝不套用当前名单
 */
import { describe, expect, it } from 'vitest';
import {
  BacktestEngine,
  calculateReconciliationData,
  computeMarginWindow,
  partitionReplayCandles,
  resolveReplayStatusesAsOf,
} from '../../../src/services/backtest-engine.js';
import {
  assertStrictMarketDataAdmission,
  collectMarketDataAdmission,
  isAdmissibleCandleAdjType,
  StrictBacktestRejectedError,
} from '../../../src/services/market-data/dataset-contract.js';
import { isCandleVisibleAsOf, readCandles } from '../../../src/services/market-data/market-data-reader.js';

const day = (iso: string): Date => new Date(iso);

/** 具备 candle.count 统计能力的准入数据源替身。 */
class AdmissionPrismaStub {
  public countCalls: number = 0;

  public readonly candle = {
    count: async (_args?: unknown) => {
      this.countCalls += 1;
      return this.badCount;
    },
  };

  public constructor(public readonly badCount: number) {}
}

describe('M5 行情准入模式（默认 permissive）', () => {
  const window = {
    clusterKey: 'friend-network-cluster',
    fromTradingDay: day('2026-02-01T00:00:00Z'),
    toTradingDay: day('2026-03-23T00:00:00Z'),
  };

  it('默认 permissive：统计 unknown adjType 计数并记录数据缺口证据，不抛错', async () => {
    const prisma = new AdmissionPrismaStub(7);
    const report = await collectMarketDataAdmission(prisma, window);

    expect(report.mode).toBe('permissive');
    expect(report.checked).toBe(false);
    expect(report.unknownAdjTypeCount).toBe(7);
    expect(report.datasetVersionId).toBeNull();
    expect(report.reasons.join(' ')).toContain('permissive');
    expect(report.reasons.join(' ')).toContain('7 条');
    expect(prisma.countCalls).toBe(1);
  });

  it('strictDataAdmission=true 且存在未知/前复权 adjType → 抛 StrictBacktestRejectedError', async () => {
    const prisma = new AdmissionPrismaStub(3);
    await expect(collectMarketDataAdmission(prisma, window, { strict: true }))
      .rejects.toThrow(StrictBacktestRejectedError);
    await expect(collectMarketDataAdmission(prisma, window, { strict: true }))
      .rejects.toThrow(/strictDataAdmission=true/);
  });

  it('strict 且窗口内口径全部合法 → checked=true，mode=strict', async () => {
    const report = await collectMarketDataAdmission(new AdmissionPrismaStub(0), window, { strict: true });
    expect(report.mode).toBe('strict');
    expect(report.checked).toBe(true);
    expect(report.unknownAdjTypeCount).toBe(0);
  });

  it('数据源无 candle.count → 计数为 null（未知，不假定为 0），strict 改为行级校验', async () => {
    const prismaWithoutCount = { candle: {} };
    const permissive = await collectMarketDataAdmission(prismaWithoutCount, window);
    expect(permissive.mode).toBe('permissive');
    expect(permissive.unknownAdjTypeCount).toBeNull();

    const strict = await collectMarketDataAdmission(prismaWithoutCount, window, { strict: true });
    expect(strict.mode).toBe('strict');
    expect(strict.checked).toBe(false);
    expect(strict.unknownAdjTypeCount).toBeNull();
    expect(strict.reasons.join(' ')).toContain('逐行校验');
  });

  it('计数查询按 cluster + 窗口 + dataset 版本限定，并只匹配 unknown/qfq', async () => {
    let captured: any = null;
    const prisma = {
      candle: {
        count: async (args: any) => {
          captured = args;
          return 0;
        },
      },
    };
    await collectMarketDataAdmission(prisma, { ...window, datasetVersionId: 'dsv-1' }, { strict: true });
    expect(captured.where.stock).toEqual({ clusterKey: 'friend-network-cluster' });
    expect(captured.where.datasetVersionId).toBe('dsv-1');
    expect(captured.where.OR).toEqual([
      { adjType: null },
      { adjType: { notIn: ['hfq', 'none'] } },
    ]);
  });
});

describe('M5 assertStrictMarketDataAdmission（M7 评估 / 验收显式入口）', () => {
  it('hfq / none 通过；空集合通过', () => {
    expect(() => assertStrictMarketDataAdmission([
      { adjType: 'hfq' },
      { adjType: 'none' },
    ])).not.toThrow();
    expect(() => assertStrictMarketDataAdmission([])).not.toThrow();
  });

  it('未知(null) / 未提供 / 前复权(qfq) 一律拒绝，并在信息中给出计数', () => {
    for (const rows of [
      [{ adjType: null }],
      [{ adjType: undefined }],
      [{}],
      [{ adjType: 'qfq' }],
    ]) {
      expect(() => assertStrictMarketDataAdmission(rows)).toThrow(StrictBacktestRejectedError);
    }
    expect(() => assertStrictMarketDataAdmission([{ adjType: 'hfq' }, { adjType: null }]))
      .toThrow(/1\/2 条/);
  });

  it('isAdmissibleCandleAdjType 只接受 hfq/none', () => {
    expect(isAdmissibleCandleAdjType('hfq')).toBe(true);
    expect(isAdmissibleCandleAdjType('none')).toBe(true);
    expect(isAdmissibleCandleAdjType('qfq')).toBe(false);
    expect(isAdmissibleCandleAdjType(null)).toBe(false);
    expect(isAdmissibleCandleAdjType(undefined)).toBe(false);
  });
});

describe('M5 回测窗口双重时间边界', () => {
  const asOf = day('2026-03-03T06:00:00Z'); // 盘中 14:00 北京

  it('base 只取 asOf 已可见的 K 线；future 只取评估窗口内可见的 K 线', () => {
    const { marginAfter } = computeMarginWindow(asOf);
    expect(marginAfter.toISOString()).toBe('2026-03-23T06:00:00.000Z');

    const rows = [
      { stockId: 's1', tradingDay: day('2026-03-02T00:00:00Z'), close: 10, visibleAt: null },
      // 当日日线：业务时间已到但 15:00 前未收盘 → 不得进入特征
      { stockId: 's1', tradingDay: day('2026-03-03T00:00:00Z'), close: 11, visibleAt: null },
      { stockId: 's1', tradingDay: day('2026-03-04T00:00:00Z'), close: 12, visibleAt: null },
      // 超出 marginAfter 的评估窗口
      { stockId: 's1', tradingDay: day('2026-03-28T00:00:00Z'), close: 13, visibleAt: null },
      // 显式可见时间晚于评估上界
      { stockId: 's1', tradingDay: day('2026-03-05T00:00:00Z'), close: 14, visibleAt: day('2026-04-01T00:00:00Z') },
    ];

    const { base, future } = partitionReplayCandles(rows, { asOf, evaluationCutoff: marginAfter });

    expect(base.map(row => row.tradingDay.toISOString())).toEqual(['2026-03-02T00:00:00.000Z']);
    expect(future.map(row => row.tradingDay.toISOString())).toEqual(['2026-03-04T00:00:00.000Z']);
    for (const row of base) {
      expect(isCandleVisibleAsOf(row, asOf)).toBe(true);
    }
    for (const row of future) {
      expect(isCandleVisibleAsOf(row, marginAfter)).toBe(true);
    }
  });

  it('evaluationAsOf 只收窄评估上界，绝不回退到 now', () => {
    const evaluationAsOf = day('2026-03-10T06:00:00Z');
    const { marginBefore, marginAfter } = computeMarginWindow(asOf, evaluationAsOf);
    expect(marginAfter.getTime()).toBe(evaluationAsOf.getTime());
    expect(marginBefore.getTime()).toBe(asOf.getTime() - 30 * 24 * 60 * 60 * 1000);
  });
});

describe('M5 股票历史状态数据缺口', () => {
  const asOf = day('2026-03-03T06:00:00Z');

  it('无适用 StockStatusHistory 记录的标的进入 coverageGapSymbols，不套用当前名单', async () => {
    const rows = [{
      symbol: '600000',
      effectiveFrom: day('2026-01-01T00:00:00Z'),
      isST: false,
      industry: '银行',
      listedAt: null,
      delistedAt: null,
      source: 'test',
    }];
    const prisma = {
      stockStatusHistory: {
        findMany: async (args: any) => rows.filter(row => row.symbol === args?.where?.symbol),
      },
    };

    const { statusBySymbol, coverageGapSymbols } = await resolveReplayStatusesAsOf(
      prisma,
      ['600000', '600001'],
      asOf,
    );

    expect([...coverageGapSymbols]).toEqual(['600001']);
    expect(statusBySymbol.get('600000')?.industry).toBe('银行');
    expect(statusBySymbol.has('600001')).toBe(false);
  });

  it('缺少 stockStatusHistory 委托（轻量替身）时返回空集合，不抛错', async () => {
    const { statusBySymbol, coverageGapSymbols } = await resolveReplayStatusesAsOf({}, ['600000'], asOf);
    expect(statusBySymbol.size).toBe(0);
    expect(coverageGapSymbols.size).toBe(0);
  });

  it('数据缺口标的的行业保持 null；有历史记录的标的用历史行业', () => {
    const candlesByStockId = new Map<string, any[]>([
      ['stock-gap', [
        { stockId: 'stock-gap', tradingDay: day('2026-03-02T00:00:00Z'), close: 10, visibleAt: null },
        { stockId: 'stock-gap', tradingDay: day('2026-03-04T00:00:00Z'), close: 11, visibleAt: null },
        { stockId: 'stock-gap', tradingDay: day('2026-03-05T00:00:00Z'), close: 12, visibleAt: null },
        { stockId: 'stock-gap', tradingDay: day('2026-03-06T00:00:00Z'), close: 13, visibleAt: null },
      ]],
    ]);

    const items = calculateReconciliationData({
      recommendations: [
        { symbol: '600000', industry: '当前行业A' },
        { symbol: '600001', industry: '当前行业B' },
      ],
      stockMap: new Map([
        ['600000', { id: 'stock-gap', symbol: '600000' }],
        ['600001', { id: 'stock-gap', symbol: '600001' }],
      ]),
      candlesByStockId,
      snapshotMap: new Map(),
      statusBySymbol: new Map([[
        '600001',
        {
          symbol: '600001',
          effectiveFrom: day('2026-01-01T00:00:00Z'),
          isST: true,
          industry: '历史行业B',
          listedAt: null,
          delistedAt: null,
          source: 'test',
        },
      ]]),
      coverageGapSymbols: new Set(['600000']),
      asOf,
      scoreResult: { profileUsed: 'short_news', halfLifeDaysUsed: 2, maxWindowDaysUsed: 7 },
    });

    const gapItem = items.find(item => item.symbol === '600000')!;
    const knownItem = items.find(item => item.symbol === '600001')!;
    expect(gapItem.industry).toBeNull();
    expect(knownItem.industry).toBe('历史行业B');
    expect(gapItem.p0).toBe(10);
    expect(gapItem.yield1Day).toBeCloseTo(0.1, 6);
  });
});

/** 最小回测数据源替身：只具备准入统计 + trace 委托，用于验证准入发生在评分之前。 */
const createAdmissionRunStub = (unknownAdjTypeCount: number | null) => {
  const state = { countCalls: 0, steps: [] as any[], traceUpdates: [] as any[] };
  const stub: any = {
    candle: unknownAdjTypeCount === null
      ? {}
      : {
        count: async () => {
          state.countCalls += 1;
          return unknownAdjTypeCount;
        },
      },
    runTrace: {
      findUnique: async () => null,
      upsert: async (args: any) => args.create,
      update: async (args: any) => {
        state.traceUpdates.push(args.data);
        return args.data;
      },
    },
    pipelineStepTrace: {
      upsert: async (args: any) => {
        state.steps.push(args.create);
        return args.create;
      },
      update: async () => ({}),
      findMany: async () => [],
    },
  };
  return { stub, state };
};

describe('M5 回测入口行情准入', () => {
  const asOf = day('2026-03-03T06:00:00Z');
  const baseInput = { asOf, clusterKey: 'friend-network-cluster' };

  it('默认（未开启 strictDataAdmission）不因 unknown adjType 抛错，且仍采集计数证据', async () => {
    const { stub, state } = createAdmissionRunStub(5);
    let caught: unknown = null;
    try {
      await new BacktestEngine().runBacktest(stub, { ...baseInput, traceId: 'trace-permissive' });
    } catch (err) {
      caught = err;
    }

    expect(state.countCalls).toBe(1);
    // 后续阶段因替身能力不足失败，但绝不是被行情口径缺口拦截
    expect(caught).not.toBeNull();
    expect(caught instanceof StrictBacktestRejectedError).toBe(false);
  });

  it('strictDataAdmission=true 且有缺口 → 在评分开始前就抛错并标记 trace FAILED', async () => {
    const { stub, state } = createAdmissionRunStub(3);
    await expect(new BacktestEngine().runBacktest(stub, {
      ...baseInput,
      traceId: 'trace-strict',
      strictDataAdmission: true,
    })).rejects.toThrow(StrictBacktestRejectedError);

    expect(state.countCalls).toBe(1);
    expect(state.steps).toHaveLength(0);
    expect(state.traceUpdates.some(update => update.status === 'FAILED')).toBe(true);
  });

  it('strict 但数据源无计数能力 → 不在入口处抛错（改为行级校验）', async () => {
    const { stub, state } = createAdmissionRunStub(null);
    let caught: unknown = null;
    try {
      await new BacktestEngine().runBacktest(stub, {
        ...baseInput,
        traceId: 'trace-strict-no-count',
        strictDataAdmission: true,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof StrictBacktestRejectedError).toBe(false);
    expect(state.countCalls).toBe(0);
  });
});

describe('M5 readCandles 可见性下推与列透出', () => {
  const asOf = day('2026-03-03T06:00:00Z'); // 盘中 14:00 北京

  /** 捕获 SQL 的原始路径替身：$queryRawUnsafe 存在时 readCandles 走 SQL。 */
  const createRawStub = (rows: readonly any[]) => {
    const captured: { sql: string; params: unknown[] } = { sql: '', params: [] };
    const prisma: any = {
      $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
        captured.sql = sql;
        captured.params = params;
        return rows;
      },
    };
    return { prisma, captured };
  };

  it('SQL 侧下推 visibleAt 过滤，并选取 tradingStatus / adjType 列', async () => {
    const { prisma, captured } = createRawStub([
      {
        stockId: 's1',
        tradingDay: day('2026-03-02T00:00:00Z'),
        close: 10,
        tradingStatus: 'NORMAL',
        adjType: 'hfq',
        visibleAt: null,
        datasetVersionId: null,
      },
    ]);

    const rows = await readCandles(prisma, { clusterKey: 'c', asOf, stockIds: ['s1'] });

    expect(captured.sql).toContain('(c."visibleAt" IS NULL OR c."visibleAt" <= $1)');
    // 列名必须带引号，否则 Postgres 会折成小写 tradingstatus 并报 42703。
    expect(captured.sql).toContain('c."tradingStatus"');
    expect(captured.sql).toContain('c."adjType"');
    expect(rows).toEqual([
      expect.objectContaining({
        stockId: 's1',
        tradingStatus: 'NORMAL',
        adjType: 'hfq',
      }),
    ]);
  });

  it('SQL 返回的盘中未收盘日线仍被 JS 二次过滤（双保险）', async () => {
    const { prisma } = createRawStub([
      // SQL 粗过滤只保证 visibleAt IS NULL，回退 15:00 的判定必须由 JS 完成
      { stockId: 's1', tradingDay: day('2026-03-03T00:00:00Z'), close: 11, visibleAt: null, adjType: 'hfq' },
      { stockId: 's1', tradingDay: day('2026-03-02T00:00:00Z'), close: 10, visibleAt: null, adjType: 'hfq' },
    ]);

    const rows = await readCandles(prisma, { clusterKey: 'c', asOf, stockIds: ['s1'] });
    expect(rows.map(row => row.tradingDay.toISOString())).toEqual(['2026-03-02T00:00:00.000Z']);
    expect(rows.every(row => isCandleVisibleAsOf(row, asOf))).toBe(true);
  });

  it('SQL 路径透出 qfq / 未知 adjType，供 strict 校验识别缺口', async () => {
    const { prisma } = createRawStub([
      { stockId: 's1', tradingDay: day('2026-03-02T00:00:00Z'), close: 10, visibleAt: null, adjType: 'qfq' },
      { stockId: 's2', tradingDay: day('2026-03-02T00:00:00Z'), close: 10, visibleAt: null, adjType: null },
    ]);

    const rows = await readCandles(prisma, { clusterKey: 'c', asOf, stockIds: ['s1', 's2'] });
    expect(rows.map(row => row.adjType)).toEqual(['qfq', null]);
    expect(() => assertStrictMarketDataAdmission(rows)).toThrow(StrictBacktestRejectedError);
  });
});
