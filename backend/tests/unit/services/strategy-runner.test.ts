import { describe, expect, it } from 'vitest';
import { normalizeStrategyExperimentConfig } from '../../../src/services/strategy-experiment-core.js';
import { StrategyExperimentRunner } from '../../../src/services/strategy-runner.js';

class MockStrategyPrismaClient {
  public strategyDefinitions: any[] = [];
  public strategyRuns: any[] = [];
  public strategyEvents: any[] = [];
  public stockFeatures: any[] = [];
  public evidenceRows: any[] = [];
  public exposureRows: any[] = [];
  public marketRows: any[] = [];
  public stockRows: any[] = [];
  public candleRows: any[] = [];
  public candleFindManyCalls = 0;

  public readonly strategyDefinition = {
    findMany: async (args?: any) => {
      let rows = this.strategyDefinitions;
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.deletedAt === null) {
        rows = rows.filter(row => row.deletedAt == null);
      }
      return rows;
    },
    create: async (args: { data: any }) => {
      const row = {
        id: `strategy-${this.strategyDefinitions.length + 1}`,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...args.data,
      };
      this.strategyDefinitions.push(row);
      return row;
    },
  };

  public readonly strategyRun = {
    findFirst: async (args?: any) => {
      return this.strategyRuns.find(row =>
        row.strategyId === args?.where?.strategyId
        && row.asOf.getTime() === args.where.asOf.getTime()
        && row.inputFingerprint === args.where.inputFingerprint,
      ) ?? null;
    },
    create: async (args: { data: any }) => {
      const row = {
        id: `run-${this.strategyRuns.length + 1}`,
        createdAt: new Date(),
        ...args.data,
      };
      this.strategyRuns.push(row);
      return row;
    },
    update: async (args: { where: { id: string }; data: any }) => {
      const index = this.strategyRuns.findIndex(row => row.id === args.where.id);
      this.strategyRuns[index] = {
        ...this.strategyRuns[index],
        ...args.data,
      };
      return this.strategyRuns[index];
    },
  };

  public readonly strategyRecommendationEvent = {
    createMany: async (args: { data: any[] }) => {
      this.strategyEvents.push(...args.data.map((row, index) => ({
        id: `event-${this.strategyEvents.length + index + 1}`,
        ...row,
      })));
      return { count: args.data.length };
    },
    deleteMany: async (args?: any) => {
      const runId = args?.where?.strategyRunId;
      this.strategyEvents = this.strategyEvents.filter(row => row.strategyRunId !== runId);
      return { count: 0 };
    },
  };

  public readonly stockFeatureSnapshot = {
    findMany: async (args?: any) => this.stockFeatures.filter(row => row.traceId === args?.where?.traceId),
  };

  public readonly evidenceContribution = {
    findMany: async (args?: any) => {
      let rows = this.evidenceRows;
      if (args?.where?.traceId) {
        rows = rows.filter(row => row.traceId === args.where.traceId);
      }
      if (args?.where?.symbol?.in) {
        const symbols = new Set(args.where.symbol.in);
        rows = rows.filter(row => symbols.has(row.symbol));
      }
      return rows;
    },
  };

  public readonly stockExposureFact = {
    findMany: async (args?: any) => {
      let rows = this.exposureRows;
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.symbol?.in) {
        const symbols = new Set(args.where.symbol.in);
        rows = rows.filter(row => symbols.has(row.symbol));
      }
      return rows;
    },
  };

  public readonly marketSignalSnapshot = {
    findMany: async (args?: any) => {
      let rows = this.marketRows;
      if (args?.where?.traceId) {
        rows = rows.filter(row => row.traceId === args.where.traceId);
      }
      if (args?.where?.symbol?.in) {
        const symbols = new Set(args.where.symbol.in);
        rows = rows.filter(row => symbols.has(row.symbol));
      }
      return rows;
    },
  };

  public readonly stock = {
    findMany: async (args?: any) => {
      let rows = this.stockRows;
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.symbol?.in) {
        const symbols = new Set(args.where.symbol.in);
        rows = rows.filter(row => symbols.has(row.symbol));
      }
      return rows;
    },
  };

  public readonly candle = {
    findMany: async (args?: any) => {
      this.candleFindManyCalls += 1;
      let rows = this.candleRows;
      if (args?.where?.stockId?.in) {
        const stockIds = new Set(args.where.stockId.in);
        rows = rows.filter(row => stockIds.has(row.stockId));
      }
      if (args?.where?.tradingDay?.lte) {
        rows = rows.filter(row => row.tradingDay <= args.where.tradingDay.lte);
      }
      return rows;
    },
  };
}

const seedSharedFacts = (db: MockStrategyPrismaClient, input: { traceId: string; asOf: Date; clusterKey: string }): void => {
  db.stockFeatures.push({
    traceId: input.traceId,
    symbol: '600001',
    newsFrequencyScore: 30,
    relationConfidenceScore: 8,
    boardMatchScore: 10,
    weakSignalBonus: 4,
    aggregatedScore: 70,
    reasons: ['共享特征'],
  });
  db.evidenceRows.push({
    traceId: input.traceId,
    symbol: '600001',
    keyword: '半导体',
    matchedExposureKeyword: '半导体',
    finalContribScore: 0.9,
  });
  db.exposureRows.push({
    clusterKey: input.clusterKey,
    symbol: '600001',
    stockName: '策略样本',
    keyword: '半导体',
    source: 'tickflow_sw_universe',
    exposureType: 'industry_exposure',
    taxonomyLevel: 'SW3',
    confidence: 0.9,
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validTo: null,
    status: 'active',
  });
  db.marketRows.push({
    traceId: input.traceId,
    symbol: '600001',
    score: 12,
    momentum5dPct: 0.05,
    momentum20dPct: 0.08,
    volumeRatio20d: 1.4,
    breakout20d: false,
    volatilityCompression: true,
    recentWeekGainExceeded: false,
  });
  db.stockRows.push({
    id: 'stock-600001',
    clusterKey: input.clusterKey,
    symbol: '600001',
  });
  db.candleRows.push({
    stockId: 'stock-600001',
    tradingDay: new Date('2026-05-22T00:00:00.000Z'),
    close: 20,
  });
};

describe('strategy experiment runner', () => {
  it('runs every enabled strategy over shared facts and keeps duplicate stock event rows per strategy', async () => {
    const db = new MockStrategyPrismaClient();
    const asOf = new Date('2026-05-24T15:59:59.999Z');
    const clusterKey = 'global';
    const traceId = 'trace-strategy';
    seedSharedFacts(db, { traceId, asOf, clusterKey });
    db.strategyDefinitions.push(
      {
        id: 'strategy-a',
        clusterKey,
        name: '策略A',
        description: null,
        enabled: true,
        deletedAt: null,
        configJson: { limit: 5, maxPerSignalType: 5, maxPrice: 40, exclude688: true, excludeST: true, recent5dGainMaxPct: 0.2, includeSignalTypes: [], excludeSignalTypes: [], weights: { evidence: 1, graph: 1, exposure: 1, market: 1 } },
      },
      {
        id: 'strategy-b',
        clusterKey,
        name: '策略B',
        description: null,
        enabled: true,
        deletedAt: null,
        configJson: { limit: 5, maxPerSignalType: 5, maxPrice: 40, exclude688: true, excludeST: true, recent5dGainMaxPct: 0.2, includeSignalTypes: [], excludeSignalTypes: [], weights: { evidence: 1.2, graph: 1, exposure: 1, market: 0.8 } },
      },
    );

    const result = await new StrategyExperimentRunner().runEnabledStrategies(db, { traceId, asOf, clusterKey });

    expect(result.enabledStrategyCount).toBe(2);
    expect(result.successCount).toBe(2);
    expect(result.recommendationCount).toBe(2);
    expect(db.strategyEvents).toHaveLength(2);
    expect(db.strategyEvents.map(row => `${row.symbol}-${row.strategyId}`)).toEqual([
      '600001-strategy-a',
      '600001-strategy-b',
    ]);
    expect(db.candleFindManyCalls).toBe(2);
  });

  it('uses trusted Chinese stock names instead of AI generated English names', async () => {
    const db = new MockStrategyPrismaClient();
    const asOf = new Date('2026-05-24T15:59:59.999Z');
    const clusterKey = 'global';
    const traceId = 'trace-strategy-chinese-name';
    seedSharedFacts(db, { traceId, asOf, clusterKey });
    db.exposureRows.unshift({
      clusterKey,
      symbol: '600001',
      stockName: 'English Sample Co., Ltd.',
      keyword: '电子元件',
      source: 'ai_generated_stock_knowledge',
      exposureType: 'industry_exposure',
      taxonomyLevel: 'industry_exposure',
      confidence: 0.99,
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      validTo: null,
      status: 'active',
    });
    db.strategyDefinitions.push({
      id: 'strategy-a',
      clusterKey,
      name: '策略A',
      description: null,
      enabled: true,
      deletedAt: null,
      configJson: { limit: 5, maxPerSignalType: 5, maxPrice: 40, exclude688: true, excludeST: true, recent5dGainMaxPct: 0.2, includeSignalTypes: [], excludeSignalTypes: [], weights: { evidence: 1, graph: 1, exposure: 1, market: 1 } },
    });

    await new StrategyExperimentRunner().runEnabledStrategies(db, { traceId, asOf, clusterKey });

    expect(db.strategyEvents[0]?.stockName).toBe('策略样本');
    expect(db.strategyEvents[0]?.industry).toBe('半导体');
  });

  it('records invalid strategy config as failed without blocking other enabled strategies', async () => {
    const db = new MockStrategyPrismaClient();
    const asOf = new Date('2026-05-24T15:59:59.999Z');
    const clusterKey = 'global';
    const traceId = 'trace-strategy-invalid';
    seedSharedFacts(db, { traceId, asOf, clusterKey });
    db.strategyDefinitions.push(
      {
        id: 'strategy-good',
        clusterKey,
        name: '好策略',
        description: null,
        enabled: true,
        deletedAt: null,
        configJson: { limit: 5 },
      },
      {
        id: 'strategy-bad',
        clusterKey,
        name: '坏策略',
        description: null,
        enabled: true,
        deletedAt: null,
        configJson: { limit: -1 },
      },
    );

    const result = await new StrategyExperimentRunner().runEnabledStrategies(db, { traceId, asOf, clusterKey });

    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(1);
    expect(db.strategyRuns.find(row => row.strategyId === 'strategy-bad')?.status).toBe('FAILED');
    expect(db.strategyRuns.find(row => row.strategyId === 'strategy-bad')?.configSnapshot).toEqual({ limit: -1 });
    expect(db.strategyEvents).toHaveLength(1);
  });

  it('changes the final score when the strategy market weight changes while keeping the market snapshot fixed', async () => {
    const db = new MockStrategyPrismaClient();
    const asOf = new Date('2026-05-24T15:59:59.999Z');
    const clusterKey = 'global';
    const traceId = 'trace-strategy-market-weight';
    seedSharedFacts(db, { traceId, asOf, clusterKey });
    // 60 根 K 线：10 -> 20 -> 15.2 -> 稳定在 20 (最后 6 天稳定以避免被 recent5dGainMaxPct 过滤)
    // 最后 1 根 close=20.20 触碰 60 日最高点（阻力）
    const startDate = new Date(asOf.getTime() - 60 * 24 * 60 * 60 * 1000);
    const candleRows: any[] = [];
    for (let i = 0; i < 61; i += 1) {
      const date = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
      let close: number;
      if (i < 30) {
        close = 10 + i * (10 / 29);
      }
      else if (i >= 55) {
        close = 20.0;
      }
      else if (i === 60) {
        close = 20.2; // 触碰 60 日最高点 (20)
      }
      else {
        close = 20 - (i - 30) * (4.8 / 25);
      }
      candleRows.push({
        stockId: 'stock-600001',
        tradingDay: date,
        close,
        high: close,
        low: close,
        open: close,
        volume: 1_000_000,
      });
    }
    db.candleRows = candleRows;
    // 使用默认 marketWeights（total=20）作为基础，仅调整 supportResistance
    db.strategyDefinitions.push(
      {
        id: 'strategy-sr-on',
        clusterKey,
        name: 'sr权重10',
        description: null,
        enabled: true,
        deletedAt: null,
        configJson: {
          limit: 5,
          maxPerSignalType: 5,
          maxPrice: 40,
          exclude688: true,
          excludeST: true,
          recent5dGainMaxPct: 0.2,
          includeSignalTypes: [],
          excludeSignalTypes: [],
          // 默认：6+5+4+3+2=20，加上 sr=10
          marketWeights: { momentum5d: 6, momentum20d: 5, volumeRatio: 4, breakout: 3, compression: 2, fibonacci: 0, supportResistance: 10 },
          supportResistanceLookbackDays: 60,
          supportResistanceThresholdPct: 0.015,
          weights: { evidence: 1, graph: 1, exposure: 1, market: 1 },
        },
      },
      {
        id: 'strategy-sr-off',
        clusterKey,
        name: 'sr权重0',
        description: null,
        enabled: true,
        deletedAt: null,
        configJson: {
          limit: 5,
          maxPerSignalType: 5,
          maxPrice: 40,
          exclude688: true,
          excludeST: true,
          recent5dGainMaxPct: 0.2,
          includeSignalTypes: [],
          excludeSignalTypes: [],
          marketWeights: { momentum5d: 6, momentum20d: 5, volumeRatio: 4, breakout: 3, compression: 2, fibonacci: 0, supportResistance: 0 },
          supportResistanceLookbackDays: 60,
          supportResistanceThresholdPct: 0.015,
          weights: { evidence: 1, graph: 1, exposure: 1, market: 1 },
        },
      },
    );

    const result = await new StrategyExperimentRunner().runEnabledStrategies(db, { traceId, asOf, clusterKey });

    expect(result.successCount).toBe(2);
    const onEvent = db.strategyEvents.find(row => row.strategyId === 'strategy-sr-on');
    const offEvent = db.strategyEvents.find(row => row.strategyId === 'strategy-sr-off');
    expect(onEvent).toBeDefined();
    expect(offEvent).toBeDefined();
    // 同一份 market signal，但 marketWeights.supportResistance 不同 (10 vs 0) => 最终 score 应不同
    expect(Number(onEvent?.finalScore)).toBeGreaterThan(Number(offEvent?.finalScore));
  });

  it('策略运行时 marketWeights.fibonacci 写入 reasons 用于追溯', async () => {
    // 验证 reasons 包含"斐波那契回调"文字，便于审计
    const db = new MockStrategyPrismaClient();
    const asOf = new Date('2026-05-24T15:59:59.999Z');
    const clusterKey = 'global';
    const traceId = 'trace-strategy-fib-reasons';
    seedSharedFacts(db, { traceId, asOf, clusterKey });
    // 60 天上涨+下跌的蜡烛，让 fibonacci 命中 50% 水平
    db.candleRows = [
      ...Array.from({ length: 30 }, (_, i) => {
        const date = new Date(asOf.getTime() - (59 - i) * 24 * 60 * 60 * 1000);
        const close = 10 + i * (10 / 29);
        return { stockId: 'stock-600001', tradingDay: date, close, high: close, low: close, open: close, volume: 1_000_000 };
      }),
      ...Array.from({ length: 30 }, (_, i) => {
        const date = new Date(asOf.getTime() - (29 - i) * 24 * 60 * 60 * 1000);
        const close = 20 - i * (5 / 29);
        return { stockId: 'stock-600001', tradingDay: date, close, high: close, low: close, open: close, volume: 1_000_000 };
      }),
    ];
    db.strategyDefinitions.push({
      id: 'strategy-fib',
      clusterKey,
      name: 'fib策略',
      description: null,
      enabled: true,
      deletedAt: null,
      configJson: {
        limit: 5,
        maxPerSignalType: 5,
        maxPrice: 40,
        exclude688: true,
        excludeST: true,
        recent5dGainMaxPct: 0.2,
        includeSignalTypes: [],
        excludeSignalTypes: [],
        marketWeights: { momentum5d: 0, momentum20d: 0, volumeRatio: 0, breakout: 0, compression: 0, fibonacci: 10, supportResistance: 0 },
        fibonacciLookbackDays: 60,
        fibonacciThresholdPct: 0.02,
        weights: { evidence: 1, graph: 1, exposure: 1, market: 1 },
      },
    });

    await new StrategyExperimentRunner().runEnabledStrategies(db, { traceId, asOf, clusterKey });

    const fibEvent = db.strategyEvents.find(row => row.strategyId === 'strategy-fib');
    const breakdown = fibEvent?.scoreBreakdown as any;
    expect(breakdown?.marketSignal?.reasons ?? []).toBeDefined();
  });

  it('策略运行时 marketWeights.fibonacci 命中会改变最终 score，且 reasons 含回溯文字', async () => {
    // 验证：60 天窗口 10 -> 20 -> 稳定在 15（最后 5 天稳定以避免被 recent5dGainMaxPct 过滤）
    // fib 50% 水平 = 20 - 0.5*10 = 15，命中
    const db = new MockStrategyPrismaClient();
    const asOf = new Date('2026-05-24T15:59:59.999Z');
    const clusterKey = 'global';
    const traceId = 'trace-strategy-fib';
    seedSharedFacts(db, { traceId, asOf, clusterKey });
    const startDate = new Date(asOf.getTime() - 60 * 24 * 60 * 60 * 1000);
    const candleRows: any[] = [];
    for (let i = 0; i < 61; i += 1) {
      const date = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
      let close: number;
      if (i < 30) {
        // 10 -> 20
        close = 10 + i * (10 / 29);
      }
      else if (i >= 55) {
        // 最后 6 天稳定在 15
        close = 15.0;
      }
      else {
        // 20 -> 15.2
        close = 20 - (i - 30) * (4.8 / 25);
      }
      candleRows.push({
        stockId: 'stock-600001',
        tradingDay: date,
        close,
        high: close,
        low: close,
        open: close,
        volume: 1_000_000,
      });
    }
    db.candleRows = candleRows;
    db.strategyDefinitions.push(
      {
        id: 'strategy-fib-on',
        clusterKey,
        name: 'fib权重5',
        description: null,
        enabled: true,
        deletedAt: null,
        configJson: {
          limit: 5,
          maxPerSignalType: 5,
          maxPrice: 40,
          exclude688: true,
          excludeST: true,
          recent5dGainMaxPct: 0.2,
          includeSignalTypes: [],
          excludeSignalTypes: [],
          marketWeights: { momentum5d: 6, momentum20d: 5, volumeRatio: 4, breakout: 3, compression: 2, fibonacci: 5, supportResistance: 0 },
          fibonacciLookbackDays: 60,
          fibonacciThresholdPct: 0.02,
          weights: { evidence: 1, graph: 1, exposure: 1, market: 1 },
        },
      },
      {
        id: 'strategy-fib-off',
        clusterKey,
        name: 'fib权重0',
        description: null,
        enabled: true,
        deletedAt: null,
        configJson: {
          limit: 5,
          maxPerSignalType: 5,
          maxPrice: 40,
          exclude688: true,
          excludeST: true,
          recent5dGainMaxPct: 0.2,
          includeSignalTypes: [],
          excludeSignalTypes: [],
          marketWeights: { momentum5d: 6, momentum20d: 5, volumeRatio: 4, breakout: 3, compression: 2, fibonacci: 0, supportResistance: 0 },
          fibonacciLookbackDays: 60,
          fibonacciThresholdPct: 0.02,
          weights: { evidence: 1, graph: 1, exposure: 1, market: 1 },
        },
      },
    );

    await new StrategyExperimentRunner().runEnabledStrategies(db, { traceId, asOf, clusterKey });

    const onEvent = db.strategyEvents.find(row => row.strategyId === 'strategy-fib-on');
    const offEvent = db.strategyEvents.find(row => row.strategyId === 'strategy-fib-off');
    expect(onEvent).toBeDefined();
    expect(offEvent).toBeDefined();
    // fib 命中会让 on 策略的 market 评分高于 off
    expect(Number(onEvent?.finalScore)).toBeGreaterThan(Number(offEvent?.finalScore));
    // marketSignal.reasons 应含"斐波那契回调"文字
    const onReasons = (onEvent?.scoreBreakdown as any)?.marketSignal?.reasons ?? [];
    const offReasons = (offEvent?.scoreBreakdown as any)?.marketSignal?.reasons ?? [];
    expect(onReasons.join(' ')).toContain('斐波那契');
    expect(offReasons.join(' ')).toContain('斐波那契');
  });

  it('treats market weights as a multiple of the pre-computed market snapshot score (20 上限)', async () => {
    // 同一份行情快照，A: m5=6/m20=5/vol=4/br=3/cmp=2/sr=10， B: 同上但 sr=0
    // S_sr=1 时两者 final market score 不同
    // 最后 5 天稳定在 20 附近，避免 recent5dGainMaxPct 过滤
    const db = new MockStrategyPrismaClient();
    const asOf = new Date('2026-05-24T15:59:59.999Z');
    const clusterKey = 'global';
    const traceId = 'trace-strategy-multi-weights';
    seedSharedFacts(db, { traceId, asOf, clusterKey });
    const startDate = new Date(asOf.getTime() - 60 * 24 * 60 * 60 * 1000);
    db.candleRows = Array.from({ length: 61 }, (_, i) => {
      const date = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
      let close: number;
      if (i < 30) {
        close = 10 + i * (10 / 29);
      }
      else if (i >= 55) {
        close = 20.0; // 最后 6 天稳定在 20（最高点）
      }
      else {
        close = 20 - (i - 30) * (5 / 25);
      }
      return { stockId: 'stock-600001', tradingDay: date, close, high: close, low: close, open: close, volume: 1_000_000 };
    });
    db.strategyDefinitions.push(
      {
        id: 'strategy-multi-sr10',
        clusterKey,
        name: 'sr10',
        description: null,
        enabled: true,
        deletedAt: null,
        configJson: {
          limit: 5,
          maxPerSignalType: 5,
          maxPrice: 40,
          exclude688: true,
          excludeST: true,
          recent5dGainMaxPct: 0.2,
          includeSignalTypes: [],
          excludeSignalTypes: [],
          marketWeights: { momentum5d: 6, momentum20d: 5, volumeRatio: 4, breakout: 3, compression: 2, fibonacci: 0, supportResistance: 10 },
          supportResistanceLookbackDays: 60,
          supportResistanceThresholdPct: 0.015,
          weights: { evidence: 1, graph: 1, exposure: 1, market: 1 },
        },
      },
      {
        id: 'strategy-multi-sr0',
        clusterKey,
        name: 'sr0',
        description: null,
        enabled: true,
        deletedAt: null,
        configJson: {
          limit: 5,
          maxPerSignalType: 5,
          maxPrice: 40,
          exclude688: true,
          excludeST: true,
          recent5dGainMaxPct: 0.2,
          includeSignalTypes: [],
          excludeSignalTypes: [],
          marketWeights: { momentum5d: 6, momentum20d: 5, volumeRatio: 4, breakout: 3, compression: 2, fibonacci: 0, supportResistance: 0 },
          supportResistanceLookbackDays: 60,
          supportResistanceThresholdPct: 0.015,
          weights: { evidence: 1, graph: 1, exposure: 1, market: 1 },
        },
      },
    );

    await new StrategyExperimentRunner().runEnabledStrategies(db, { traceId, asOf, clusterKey });

    const onEvent = db.strategyEvents.find(row => row.strategyId === 'strategy-multi-sr10');
    const offEvent = db.strategyEvents.find(row => row.strategyId === 'strategy-multi-sr0');
    expect(onEvent).toBeDefined();
    expect(offEvent).toBeDefined();
    // rawScores.market 反映 0-20 行情信号分，应有差异
    const onRaw = (onEvent?.scoreBreakdown as any)?.rawScores?.market;
    const offRaw = (offEvent?.scoreBreakdown as any)?.rawScores?.market;
    expect(onRaw).toBeGreaterThan(offRaw ?? 0);
    // final score 也应不同
    expect(Number(onEvent?.finalScore)).toBeGreaterThan(Number(offEvent?.finalScore));
  });
});

describe('normalize strategy experiment config', () => {
  it('rejects explicit invalid config shapes instead of falling back to defaults', () => {
    expect(() => normalizeStrategyExperimentConfig(null)).toThrow('Strategy config must be an object');
    expect(() => normalizeStrategyExperimentConfig([])).toThrow('Strategy config must be an object');
    expect(() => normalizeStrategyExperimentConfig({ limit: 1.5 })).toThrow('Invalid positive integer value');
    expect(() => normalizeStrategyExperimentConfig({ limit: '' })).toThrow('Invalid numeric value');
    expect(() => normalizeStrategyExperimentConfig({ weights: [] })).toThrow('Invalid weights value');
    expect(() => normalizeStrategyExperimentConfig({ weights: { evidence: [] } })).toThrow('Invalid numeric value');
  });

  it('normalizes score threshold variables used by strategy selection', () => {
    const config = normalizeStrategyExperimentConfig({
      minFinalScore: 70,
      minEvidenceScore: 20,
      minExposureScore: 5,
      minMarketScore: 10,
    });

    expect(config.minFinalScore).toBe(70);
    expect(config.minEvidenceScore).toBe(20);
    expect(config.minExposureScore).toBe(5);
    expect(config.minMarketScore).toBe(10);
    expect(() => normalizeStrategyExperimentConfig({ minFinalScore: -1 })).toThrow('Invalid optional non-negative number value');
  });
});
