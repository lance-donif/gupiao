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
    expect(db.candleFindManyCalls).toBe(1);
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
