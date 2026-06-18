import { describe, expect, it } from 'vitest';
import { BacktestEngine } from '../../../src/services/backtest-engine.js';
import { ScoringContributionEngine } from '../../../src/services/scoring-contribution-engine.js';

class MockBacktestPrismaClient {
  public normalizedNewsRecordList: any[] = [];
  public causalSignalCandidateList: any[] = [];
  public stockExposureFactList: any[] = [];
  public stockList: any[] = [];
  public candleList: any[] = [];

  public evidenceContributionsCreated: any[] = [];
  public stockFeatureSnapshotsCreated: any[] = [];
  public recommendationSnapshotsCreated: any[] = [];
  public runTracesCreated: any[] = [];
  public pipelineStepTracesCreated: any[] = [];
  public strategyDefinitions: any[] = [];
  public strategyRuns: any[] = [];
  public strategyEvents: any[] = [];
  public performanceReports: any[] = [];
  public marketSignals: any[] = [];
  public transactionCalls: any[][] = [];

  public async $transaction(promises: Promise<any>[] | ((tx: any) => Promise<any>)): Promise<any[]> {
    if (typeof promises === 'function') {
      return promises(this);
    }
    this.transactionCalls.push(promises as any[]);
    return Promise.all(promises);
  }

  public readonly normalizedNewsRecord = {
    findMany: async (args?: any) => {
      let filtered = this.normalizedNewsRecordList;
      if (args?.where?.clusterKey) {
        filtered = filtered.filter(n => n.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.publishedAt?.lte) {
        filtered = filtered.filter(n => n.publishedAt <= args.where.publishedAt.lte);
      }
      if (args?.where?.publishedAt?.gte) {
        filtered = filtered.filter(n => n.publishedAt >= args.where.publishedAt.gte);
      }
      return filtered;
    },
  };

  public readonly causalSignalCandidate = {
    findMany: async (args?: any) => {
      let filtered = this.causalSignalCandidateList;
      if (args?.where?.traceId) {
        filtered = filtered.filter(row => row.traceId === args.where.traceId);
      }
      if (args?.where?.clusterKey) {
        filtered = filtered.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.asOf?.lte) {
        filtered = filtered.filter(row => row.asOf <= args.where.asOf.lte);
      }
      if (args?.where?.status) {
        filtered = filtered.filter(row => row.status === args.where.status);
      }
      return filtered;
    },
  };

  public readonly stockExposureFact = {
    findMany: async (args?: any) => {
      let filtered = this.stockExposureFactList;
      if (args?.where?.clusterKey) {
        filtered = filtered.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.keyword?.in) {
        const keywords = new Set(args.where.keyword.in);
        filtered = filtered.filter(row => keywords.has(row.keyword));
      }
      if (args?.where?.symbol?.in) {
        const symbols = new Set(args.where.symbol.in);
        filtered = filtered.filter(row => symbols.has(row.symbol));
      }
      if (args?.where?.status) {
        filtered = filtered.filter(row => row.status === args.where.status);
      }
      if (args?.where?.validFrom?.lte) {
        filtered = filtered.filter(row => row.validFrom <= args.where.validFrom.lte);
      }
      return filtered;
    },
  };

  public readonly graphSnapshot = {
    findUnique: async () => null,
  };

  public readonly evidenceContribution = {
    createMany: async (args: { data: any[] }) => {
      this.evidenceContributionsCreated.push(...args.data);
      return { count: args.data.length };
    },
    findMany: async (args?: any) => {
      let filtered = this.evidenceContributionsCreated;
      if (args?.where?.clusterKey) {
        filtered = filtered.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.traceId) {
        filtered = filtered.filter(row => row.traceId === args.where.traceId);
      }
      if (args?.where?.symbol?.in) {
        const symbols = new Set(args.where.symbol.in);
        filtered = filtered.filter(row => symbols.has(row.symbol));
      }
      if (Array.isArray(args?.where?.OR)) {
        filtered = filtered.filter(row => {
          return args.where.OR.some((cond: any) => {
            return (!cond.traceId || row.traceId === cond.traceId)
              && (!cond.symbol || row.symbol === cond.symbol);
          });
        });
      }
      return filtered;
    },
  };

  public readonly stockFeatureSnapshot = {
    createMany: async (args: { data: any[] }) => {
      this.stockFeatureSnapshotsCreated.push(...args.data);
      return { count: args.data.length };
    },
    findMany: async (args?: any) => {
      if (args?.where?.traceId) {
        return this.stockFeatureSnapshotsCreated.filter(f => f.traceId === args.where.traceId);
      }
      return this.stockFeatureSnapshotsCreated;
    },
  };

  public readonly recommendationSnapshot = {
    findUnique: async (args: { where: { traceId_symbol: { traceId: string; symbol: string } } }) => {
      const { traceId, symbol } = args.where.traceId_symbol;
      return this.recommendationSnapshotsCreated.find(rec => rec.traceId === traceId && rec.symbol === symbol) ?? null;
    },
    findMany: async (args?: any) => {
      let filtered = this.recommendationSnapshotsCreated;
      if (args?.where?.clusterKey) {
        filtered = filtered.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.traceId) {
        filtered = filtered.filter(row => row.traceId === args.where.traceId);
      }
      if (args?.where?.symbol?.in) {
        const symbols = new Set(args.where.symbol.in);
        filtered = filtered.filter(row => symbols.has(row.symbol));
      }
      if (args?.where?.asOf) {
        const asOfFilter = args.where.asOf;
        if (asOfFilter.gte) {
          filtered = filtered.filter(row => new Date(row.asOf) >= asOfFilter.gte);
        }
        if (asOfFilter.lt) {
          filtered = filtered.filter(row => new Date(row.asOf) < asOfFilter.lt);
        }
      }
      return filtered;
    },
    createMany: async (args: { data: any[] }) => {
      this.recommendationSnapshotsCreated.push(...args.data);
      return { count: args.data.length };
    },
    update: async (args: { where: { traceId_symbol: { traceId: string; symbol: string } }; data: any }) => {
      const { traceId, symbol } = args.where.traceId_symbol;
      const index = this.recommendationSnapshotsCreated.findIndex(
        rec => rec.traceId === traceId && rec.symbol === symbol,
      );
      if (index !== -1) {
        this.recommendationSnapshotsCreated[index] = {
          ...this.recommendationSnapshotsCreated[index],
          ...args.data,
        };
      }
      return this.recommendationSnapshotsCreated[index];
    },
  };

  public readonly stock = {
    findMany: async (args?: any) => {
      let filtered = this.stockList;
      if (args?.where?.clusterKey) {
        filtered = filtered.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.symbol?.in) {
        const symbols = new Set(args.where.symbol.in);
        filtered = filtered.filter(row => symbols.has(row.symbol));
      }
      return filtered;
    },
    findUnique: async (args: { where: { clusterKey_symbol: { clusterKey: string; symbol: string } } }) => {
      const { clusterKey, symbol } = args.where.clusterKey_symbol;
      return this.stockList.find(s => s.clusterKey === clusterKey && s.symbol === symbol) ?? null;
    },
  };

  public readonly candle = {
    findMany: async (args?: any) => {
      let filtered = this.candleList;
      const stockIdFilter = args?.where?.stockId;
      if (stockIdFilter) {
        if (stockIdFilter.in) {
          const ids = new Set(stockIdFilter.in.map(String));
          filtered = filtered.filter(c => ids.has(String(c.stockId)));
        } else {
          filtered = filtered.filter(c => String(c.stockId) === String(stockIdFilter));
        }
      }

      const tradingDayFilter = args?.where?.tradingDay;
      if (tradingDayFilter) {
        if (tradingDayFilter.lte) {
          filtered = filtered.filter(c => c.tradingDay <= tradingDayFilter.lte);
        }
        if (tradingDayFilter.gt) {
          filtered = filtered.filter(c => c.tradingDay > tradingDayFilter.gt);
        }
        if (tradingDayFilter.gte) {
          filtered = filtered.filter(c => c.tradingDay >= tradingDayFilter.gte);
        }
      }

      if (args?.orderBy?.tradingDay) {
        filtered.sort((a, b) => args.orderBy.tradingDay === 'asc'
          ? a.tradingDay.getTime() - b.tradingDay.getTime()
          : b.tradingDay.getTime() - a.tradingDay.getTime());
      }

      return args?.take ? filtered.slice(0, args.take) : filtered;
    },
  };

  public readonly runTrace = {
    create: async (args: { data: any }) => {
      this.runTracesCreated.push({ ...args.data });
      return args.data;
    },
    update: async (args: { where: { traceId: string }; data: any }) => {
      const index = this.runTracesCreated.findIndex(trace => trace.traceId === args.where.traceId);
      if (index !== -1) {
        this.runTracesCreated[index] = {
          ...this.runTracesCreated[index],
          ...args.data,
        };
      }
      return this.runTracesCreated[index];
    },
  };

  public readonly pipelineStepTrace = {
    create: async (args: { data: any }) => {
      this.pipelineStepTracesCreated.push({ ...args.data });
      return args.data;
    },
    update: async (args: { where: { traceId_stepName: { traceId: string; stepName: string } }; data: any }) => {
      const { traceId, stepName } = args.where.traceId_stepName;
      const index = this.pipelineStepTracesCreated.findIndex(
        step => step.traceId === traceId && step.stepName === stepName,
      );
      if (index !== -1) {
        this.pipelineStepTracesCreated[index] = {
          ...this.pipelineStepTracesCreated[index],
          ...args.data,
        };
      }
      return this.pipelineStepTracesCreated[index];
    },
  };

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
    findMany: async (args?: any) => {
      let rows = this.strategyRuns;
      if (args?.where?.traceId) {
        rows = rows.filter(row => row.traceId === args.where.traceId);
      }
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.status) {
        rows = rows.filter(row => row.status === args.where.status);
      }
      // attach recommendations property
      return rows.map(row => ({
        ...row,
        recommendations: this.strategyEvents.filter(event => event.strategyRunId === row.id),
      }));
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
      if (index !== -1) {
        this.strategyRuns[index] = {
          ...this.strategyRuns[index],
          ...args.data,
        };
      }
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

  public readonly strategyPerformanceReport = {
    create: async (args: { data: any }) => {
      const row = { id: `report-${this.performanceReports.length + 1}`, ...args.data };
      this.performanceReports.push(row);
      return row;
    },
    upsert: async (args: any) => {
      const where = args.where.strategyId_asOf;
      const index = this.performanceReports.findIndex(row =>
        row.strategyId === where.strategyId && row.asOf.getTime() === where.asOf.getTime(),
      );
      if (index >= 0) {
        this.performanceReports[index] = {
          ...this.performanceReports[index],
          ...args.update,
        };
        return this.performanceReports[index];
      }
      const created = { id: `report-${this.performanceReports.length + 1}`, ...args.create };
      this.performanceReports.push(created);
      return created;
    },
  };

  public readonly marketSignalSnapshot = {
    findMany: async (args?: any) => {
      let rows = this.marketSignals;
      if (args?.where?.traceId) {
        rows = rows.filter(row => row.traceId === args.where.traceId);
      }
      if (args?.where?.symbol?.in) {
        const symbols = new Set(args.where.symbol.in);
        rows = rows.filter(row => symbols.has(row.symbol));
      }
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.asOf) {
        rows = rows.filter(row => row.asOf === args.where.asOf);
      }
      return rows;
    },
    createMany: async (args: { data: any[] }) => {
      this.marketSignals.push(...args.data);
      return { count: args.data.length };
    },
  };

  public readonly factSnapshot = {
    upsert: async (args: { where: { traceId: string }; create: any; update: any }) => {
      return { traceId: args.where.traceId, ...args.create };
    },
  };
}

const addNews = (
  db: MockBacktestPrismaClient,
  input: {
    id: string;
    title: string;
    clusterKey: string;
    publishedAt: Date;
    content?: string;
  },
): void => {
  db.normalizedNewsRecordList.push({
    id: input.id,
    title: input.title,
    content: input.content ?? input.title,
    source: '测试源',
    url: `https://example.com/${input.id}`,
    publishedAt: input.publishedAt,
    clusterKey: input.clusterKey,
    reprintWeight: 1.0,
  });
};

const addSignal = (
  db: MockBacktestPrismaClient,
  input: {
    traceId: string;
    asOf: Date;
    clusterKey: string;
    newsId: string;
    keyword: string;
    businessVariable?: string;
  },
): void => {
  db.causalSignalCandidateList.push({
    traceId: input.traceId,
    asOf: input.asOf,
    clusterKey: input.clusterKey,
    newsId: input.newsId,
    event: `${input.keyword} 相关事件`,
    businessVariable: input.businessVariable ?? '需求增加',
    assetOrThemeKeyword: input.keyword,
    direction: 'positive',
    confidence: '0.8000',
    evidenceText: `${input.keyword} 证据`,
    extractorType: 'llm',
    modelVersion: 'test-model',
    promptVersion: 'causal-signal-extraction-v1',
    status: 'candidate',
  });
};

const addExposure = (
  db: MockBacktestPrismaClient,
  input: {
    clusterKey: string;
    symbol: string;
    stockName: string;
    keyword: string;
  },
): void => {
  db.stockExposureFactList.push({
    clusterKey: input.clusterKey,
    symbol: input.symbol,
    stockName: input.stockName,
    keyword: input.keyword,
    exposureType: 'business_exposure',
    taxonomyLevel: null,
    source: 'test_exposure',
    sourceId: `${input.keyword}-${input.symbol}`,
    sourceName: `${input.keyword}业务暴露`,
    confidence: '0.9000',
    memberCount: 1,
    validFrom: new Date('2026-05-24T00:00:00.000Z'),
    validTo: null,
    status: 'active',
  });
};

const addStockWithCandles = (
  db: MockBacktestPrismaClient,
  input: {
    clusterKey: string;
    symbol: string;
    asOf: Date;
    baseClose?: number;
  },
): void => {
  const stockId = `stock-${input.symbol}`;
  db.stockList.push({ id: stockId, symbol: input.symbol, clusterKey: input.clusterKey });
  const baseClose = input.baseClose ?? 10;
  const earliestVisible = new Date(input.asOf.getTime() - 24 * 60 * 60 * 1000);
  for (let index = 20; index >= 1; index -= 1) {
    const close = baseClose * (1 + (20 - index) * 0.002);
    db.candleList.push({
      id: `c-${input.symbol}-past-${index}`,
      stockId,
      tradingDay: new Date(earliestVisible.getTime() - index * 24 * 60 * 60 * 1000),
      open: close * 0.99,
      high: close * 1.01,
      low: close * 0.98,
      close,
      volume: 1_000_000 + index * 1000,
    });
  }
  db.candleList.push(
    { id: `c-${input.symbol}-0`, stockId, tradingDay: new Date(input.asOf.getTime() - 2 * 60 * 60 * 1000), open: baseClose * 0.99, high: baseClose * 1.01, low: baseClose * 0.98, close: baseClose, volume: 1_500_000 },
    { id: `c-${input.symbol}-1`, stockId, tradingDay: new Date(input.asOf.getTime() + 1 * 24 * 60 * 60 * 1000), open: baseClose, high: baseClose * 1.12, low: baseClose * 0.99, close: baseClose * 1.1, volume: 1_600_000 },
    { id: `c-${input.symbol}-2`, stockId, tradingDay: new Date(input.asOf.getTime() + 2 * 24 * 60 * 60 * 1000), open: baseClose, high: baseClose * 1.07, low: baseClose * 0.99, close: baseClose * 1.05, volume: 1_400_000 },
    { id: `c-${input.symbol}-3`, stockId, tradingDay: new Date(input.asOf.getTime() + 3 * 24 * 60 * 60 * 1000), open: baseClose, high: baseClose * 1.02, low: baseClose * 0.88, close: baseClose * 0.9, volume: 1_300_000 },
    { id: `c-${input.symbol}-4`, stockId, tradingDay: new Date(input.asOf.getTime() + 4 * 24 * 60 * 60 * 1000), open: baseClose, high: baseClose * 1.16, low: baseClose * 0.99, close: baseClose * 1.15, volume: 1_700_000 },
    { id: `c-${input.symbol}-5`, stockId, tradingDay: new Date(input.asOf.getTime() + 5 * 24 * 60 * 60 * 1000), open: baseClose, high: baseClose * 1.22, low: baseClose * 0.99, close: baseClose * 1.2, volume: 1_800_000 },
  );
};

const seedRecommendationPath = (
  db: MockBacktestPrismaClient,
  input: {
    traceId: string;
    asOf: Date;
    clusterKey: string;
    newsId: string;
    symbol: string;
    stockName: string;
    keyword: string;
    publishedAt?: Date;
  },
): void => {
  addNews(db, {
    id: input.newsId,
    title: `${input.keyword}需求增加`,
    clusterKey: input.clusterKey,
    publishedAt: input.publishedAt ?? new Date(input.asOf.getTime() - 4 * 60 * 60 * 1000),
  });
  addSignal(db, {
    traceId: input.traceId,
    asOf: input.asOf,
    clusterKey: input.clusterKey,
    newsId: input.newsId,
    keyword: input.keyword,
  });
  addExposure(db, {
    clusterKey: input.clusterKey,
    symbol: input.symbol,
    stockName: input.stockName,
    keyword: input.keyword,
  });
  addStockWithCandles(db, {
    clusterKey: input.clusterKey,
    symbol: input.symbol,
    asOf: input.asOf,
  });
};

describe('backtest engine', () => {
  it('enforces temporal isolation barrier and reconciles returns cleanly', async () => {
    const mockDb = new MockBacktestPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'friend-network-cluster';
    const traceId = 'test-backtest-trace-888';

    seedRecommendationPath(mockDb, {
      traceId,
      asOf,
      clusterKey,
      newsId: 'news-past',
      symbol: '600000',
      stockName: '浦发银行',
      keyword: '信贷',
    });
    addNews(mockDb, {
      id: 'news-future',
      title: '未来新闻不应可见',
      clusterKey,
      publishedAt: new Date(asOf.getTime() + 10 * 60 * 60 * 1000),
    });
    addSignal(mockDb, {
      traceId,
      asOf,
      clusterKey,
      newsId: 'news-future',
      keyword: '信贷',
    });

    const result = await new BacktestEngine().runBacktest(mockDb, {
      traceId,
      asOf,
      clusterKey,
    });

    const pastContrib = mockDb.evidenceContributionsCreated.filter(c => c.newsId === 'news-past');
    const futureContrib = mockDb.evidenceContributionsCreated.filter(c => c.newsId === 'news-future');

    expect(pastContrib).toHaveLength(1);
    expect(futureContrib).toHaveLength(0);
    expect(result.recommendationsCreated).toBe(1);
    expect(result.reconciledCount).toBe(1);

    const snapshot = mockDb.recommendationSnapshotsCreated[0];
    expect(snapshot.symbol).toBe('600000');
    expect(snapshot.isReconciled).toBe(true);
    expect(Number(snapshot.realizedPrice)).toBe(10.0);
    expect(Number(snapshot.yield1Day)).toBeCloseTo(0.10, 4);
    expect(Number(snapshot.yield3Day)).toBeCloseTo(-0.10, 4);
    expect(Number(snapshot.yield5Day)).toBeCloseTo(0.20, 4);
  });

  it('persists StrategyPerformanceReport with win rate / profit ratio / max drawdown after reconciliation', async () => {
    const mockDb = new MockBacktestPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'friend-network-cluster';
    const traceId = 'test-perf-report-trace';
    mockDb.strategyDefinitions.push({
      id: 'strategy-perf',
      clusterKey,
      name: '绩效策略',
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
        weights: { evidence: 1, graph: 1, exposure: 1, market: 1 },
      },
    });

    seedRecommendationPath(mockDb, {
      traceId,
      asOf,
      clusterKey,
      newsId: 'news-past',
      symbol: '600000',
      stockName: '浦发银行',
      keyword: '信贷',
    });

    const result = await new BacktestEngine().runBacktest(mockDb, { traceId, asOf, clusterKey });

    expect(result.reconciledCount).toBe(1);
    expect(mockDb.performanceReports).toHaveLength(1);

    const report = mockDb.performanceReports[0];
    expect(report.strategyId).toBe('strategy-perf');
    expect(report.strategyNameSnapshot).toBe('绩效策略');
    expect(report.clusterKey).toBe(clusterKey);
    expect(report.recommendationCount).toBe(1);
    // yield5Day 已知约为 0.20（看 seedRecommendationPath 的蜡烛结构）
    expect(Number(report.avgReturnPct)).toBeGreaterThan(0);
    expect(Number(report.avgReturnPct)).toBeCloseTo(0.20, 2);
    expect(Number(report.winRate)).toBe(1);
    // 单只推荐正收益，profitRatio=avgWinning / |avgLosing|，avgLosing=0 -> null
    expect(report.profitRatio === null || Number(report.profitRatio) > 0).toBe(true);
    expect(report.maxDrawdown).not.toBeNull();
  });

  it('reconciles in a single batched candle query and persists via $transaction', async () => {
    const mockDb = new MockBacktestPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'friend-network-cluster';
    const traceId = 'test-batched-reconcile';

    // 3 候选，1 批 candle.findMany
    for (const row of [
      ['600001', '股票A', '题材A'],
      ['600002', '股票B', '题材B'],
      ['600003', '股票C', '题材C'],
    ] as const) {
      seedRecommendationPath(mockDb, {
        traceId,
        asOf,
        clusterKey,
        newsId: `news-${row[0]}`,
        symbol: row[0],
        stockName: row[1],
        keyword: row[2],
      });
    }

    const result = await new BacktestEngine().runBacktest(mockDb, { traceId, asOf, clusterKey });

    expect(result.reconciledCount).toBe(3);
    // 3 个 update 走 $transaction
    expect(mockDb.transactionCalls).toHaveLength(1);
    expect(mockDb.transactionCalls[0]).toHaveLength(3);
  });

  it('can run inside an existing daily trace without creating or completing RunTrace', async () => {
    const mockDb = new MockBacktestPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'friend-network-cluster';
    const traceId = 'existing-daily-trace';

    mockDb.runTracesCreated = [{
      traceId,
      clusterKey,
      kind: 'DAILY_RECOMMENDATION',
      asOf,
      status: 'PENDING',
      metrics: {},
    }];
    seedRecommendationPath(mockDb, {
      traceId,
      asOf,
      clusterKey,
      newsId: 'news-past',
      symbol: '600000',
      stockName: '浦发银行',
      keyword: '信贷',
    });

    const result = await new BacktestEngine().runBacktest(mockDb, {
      traceId,
      asOf,
      clusterKey,
      manageTrace: false,
    });

    expect(result.recommendationsCreated).toBe(1);
    expect(mockDb.runTracesCreated).toHaveLength(1);
    expect(mockDb.runTracesCreated[0]).toEqual(expect.objectContaining({
      traceId,
      status: 'PENDING',
      kind: 'DAILY_RECOMMENDATION',
    }));
  });

  it('applies different decay rates based on short_news vs fundamental_theme profiles', async () => {
    const mockDb = new MockBacktestPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'friend-network-cluster';
    const keyword = '白银光伏';

    seedRecommendationPath(mockDb, {
      traceId: 'trace-short',
      asOf,
      clusterKey,
      newsId: 'news-20-days-ago',
      symbol: '600595',
      stockName: '中孚实业',
      keyword,
      publishedAt: new Date(asOf.getTime() - 20 * 24 * 60 * 60 * 1000),
    });
    addSignal(mockDb, {
      traceId: 'trace-fundamental',
      asOf,
      clusterKey,
      newsId: 'news-20-days-ago',
      keyword,
    });

    const engine = new ScoringContributionEngine();
    const resultShort = await engine.execute(mockDb, {
      traceId: 'trace-short',
      asOf,
      clusterKey,
      scoringProfile: 'short_news',
    });
    const resultFundamental = await engine.execute(mockDb, {
      traceId: 'trace-fundamental',
      asOf,
      clusterKey,
      scoringProfile: 'fundamental_theme',
    });

    expect(resultShort.contributionCount).toBe(0);
    expect(resultFundamental.contributionCount).toBe(1);
    const contrib = mockDb.evidenceContributionsCreated.find(c => c.traceId === 'trace-fundamental');
    expect(contrib).toBeDefined();
    expect(Number(contrib.finalContribScore)).toBeCloseTo(0.45, 2);
  });

  it('solidifies and loads profile settings in recommendation snapshots for replay consistency', async () => {
    const mockDb = new MockBacktestPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'friend-network-cluster';
    const traceId = 'replay-check-trace-123';

    seedRecommendationPath(mockDb, {
      traceId,
      asOf,
      clusterKey,
      newsId: 'news-1',
      symbol: '600000',
      stockName: '浦发银行',
      keyword: '信贷',
      publishedAt: new Date(asOf.getTime() - 24 * 60 * 60 * 1000),
    });

    const result = await new BacktestEngine().runBacktest(mockDb, {
      traceId,
      asOf,
      clusterKey,
      scoringProfile: 'industry_cycle',
    });

    expect(result.profileUsed).toBe('industry_cycle');
    expect(result.halfLifeDaysUsed).toBe(10);
    expect(result.maxWindowDaysUsed).toBe(30);

    const snapshot = mockDb.recommendationSnapshotsCreated[0];
    expect(snapshot.scoreBreakdown.scoringProfile).toBe('industry_cycle');
    expect(snapshot.scoreBreakdown.halfLifeDaysUsed).toBe(10);
    expect(snapshot.scoreBreakdown.maxWindowDaysUsed).toBe(30);
  });

  it('isolates recommendation results strictly between different clusterKeys without contamination', async () => {
    const mockDb = new MockBacktestPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');

    seedRecommendationPath(mockDb, {
      traceId: 'trace-cluster-a',
      asOf,
      clusterKey: 'cluster-a',
      newsId: 'news-a',
      symbol: '600000',
      stockName: '浦发银行',
      keyword: '信贷',
    });
    seedRecommendationPath(mockDb, {
      traceId: 'trace-cluster-b',
      asOf,
      clusterKey: 'cluster-b',
      newsId: 'news-b',
      symbol: '300024',
      stockName: '机器人',
      keyword: '机器人',
    });

    const resultA = await new BacktestEngine().runBacktest(mockDb, {
      traceId: 'trace-cluster-a',
      asOf,
      clusterKey: 'cluster-a',
    });
    const resultB = await new BacktestEngine().runBacktest(mockDb, {
      traceId: 'trace-cluster-b',
      asOf,
      clusterKey: 'cluster-b',
    });

    expect(resultA.recommendationsCreated).toBe(1);
    expect(resultB.recommendationsCreated).toBe(1);
    const recsA = mockDb.recommendationSnapshotsCreated.filter(r => r.traceId === 'trace-cluster-a');
    const recsB = mockDb.recommendationSnapshotsCreated.filter(r => r.traceId === 'trace-cluster-b');
    expect(recsA[0]?.symbol).toBe('600000');
    expect(recsB[0]?.symbol).toBe('300024');
    expect(recsA.some(r => r.symbol === '300024')).toBe(false);
    expect(recsB.some(r => r.symbol === '600000')).toBe(false);
  });

  it('prevents future causal signals from leaking into historical recommendations', async () => {
    const mockDb = new MockBacktestPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'friend-network-cluster';
    const traceId = 'trace-future-signal-leak';

    seedRecommendationPath(mockDb, {
      traceId,
      asOf,
      clusterKey,
      newsId: 'news-bank',
      symbol: '600000',
      stockName: '浦发银行',
      keyword: '信贷',
    });
    addNews(mockDb, {
      id: 'news-robot',
      title: '机器人需求增加',
      clusterKey,
      publishedAt: new Date(asOf.getTime() - 1000),
    });
    addSignal(mockDb, {
      traceId,
      asOf: new Date(asOf.getTime() + 10 * 60 * 1000),
      clusterKey,
      newsId: 'news-robot',
      keyword: '机器人',
    });
    addExposure(mockDb, {
      clusterKey,
      symbol: '300024',
      stockName: '机器人',
      keyword: '机器人',
    });
    addStockWithCandles(mockDb, {
      clusterKey,
      symbol: '300024',
      asOf,
      baseClose: 20,
    });

    const result = await new BacktestEngine().runBacktest(mockDb, {
      traceId,
      asOf,
      clusterKey,
    });

    expect(result.recommendationsCreated).toBe(1);
    const recs = mockDb.recommendationSnapshotsCreated.filter(r => r.traceId === traceId);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.symbol).toBe('600000');
  });

  it('writes replay-ready RunTrace step summaries with stable parameter structure', async () => {
    const mockDb = new MockBacktestPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'friend-network-cluster';
    const traceId = 'trace-replay-summary';

    seedRecommendationPath(mockDb, {
      traceId,
      asOf,
      clusterKey,
      newsId: 'news-1',
      symbol: '600000',
      stockName: '浦发银行',
      keyword: '信贷',
    });

    await new BacktestEngine().runBacktest(mockDb, {
      traceId,
      asOf,
      clusterKey,
      scoringProfile: 'industry_cycle',
      recommendationLimit: 5,
      maxPerIndustry: 1,
    });

    const scoringStep = mockDb.pipelineStepTracesCreated.find(step => step.stepName === 'scoring');
    const recommendationStep = mockDb.pipelineStepTracesCreated.find(step => step.stepName === 'recommendation');

    expect(scoringStep?.inputSummary).toMatchInlineSnapshot({
      asOf: expect.any(Date),
    }, `
      {
        "asOf": Any<Date>,
        "clusterKey": "friend-network-cluster",
        "halfLifeDays": 10,
        "limit": 5,
        "maxPerIndustry": 1,
        "maxWindowDays": 30,
        "newsWindowDays": 7,
        "profile": "industry_cycle",
      }
    `);
    expect(recommendationStep?.inputSummary).toMatchObject({
      asOf,
      clusterKey,
      profile: 'industry_cycle',
      halfLifeDays: 10,
      maxWindowDays: 30,
      limit: 5,
      maxPerIndustry: 1,
    });
    expect(recommendationStep?.outputSummary.recommendations).toEqual([
      expect.objectContaining({
        symbol: '600000',
        rank: 1,
        finalScore: expect.any(Number),
        scoreBreakdown: expect.objectContaining({
          keywordFrequencyScore: expect.any(Number),
          relationshipConfidenceScore: expect.any(Number),
          boardMatchScore: expect.any(Number),
        }),
      }),
    ]);
  });

});
