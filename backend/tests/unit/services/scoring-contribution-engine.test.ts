import { describe, expect, it } from 'vitest';
import { ScoringContributionEngine } from '../../../src/services/scoring-contribution-engine.js';
import { TempStockRecommendationService } from '../../../src/services/temp-stock-recommendation-service.js';

class MockPrismaClient {
  public normalizedNewsRecordList: any[] = [];
  public stockExposureFactList: any[] = [];
  public causalSignalCandidateList: any[] = [];
  public graphSnapshotRecord: any = null;
  public stockList: any[] = [];
  public candleList: any[] = [];
  public evidenceContributionsCreated: any[] = [];
  public stockFeatureSnapshotsCreated: any[] = [];
  public recommendationSnapshotsCreated: any[] = [];
  public marketSignalSnapshotsCreated: any[] = [];
  public exposureMatchCacheRows: any[] = [];
  public keywordAliasRows: any[] = [];
  public keywordPerformancePenaltyRows: any[] = [];
  public factSnapshotRows: any[] = [];
  public candleFindManyCalls = 0;

  public $executeRawUnsafe?: (sql: string, ...params: any[]) => Promise<number>;

  public constructor(options: { rawSql?: boolean } = {}) {
    if (!options.rawSql) {
      return;
    }
    this.$executeRawUnsafe = async (sql: string, ...params: any[]) => {
      const rows = JSON.parse(String(params[0] ?? '[]'));
      if (sql.includes('INSERT INTO "EvidenceContribution"')) {
        this.evidenceContributionsCreated.push(...rows);
      }
      else if (sql.includes('INSERT INTO "ExposureMatchCache"')) {
        this.exposureMatchCacheRows.push(...rows);
      }
      return rows.length;
    };
  }

  public readonly normalizedNewsRecord = {
    findMany: async () => this.normalizedNewsRecordList,
  };

  public readonly stockExposureFact = {
    findMany: async (args?: any) => {
      let rows = this.stockExposureFactList;
      if (args?.where?.keyword?.in) {
        const keywords = new Set(args.where.keyword.in);
        rows = rows.filter(row => keywords.has(row.keyword));
      }
      if (args?.where?.exposureType) {
        rows = rows.filter(row => row.exposureType === args.where.exposureType);
      }
      if (args?.where?.status) {
        rows = rows.filter(row => row.status === args.where.status);
      }
      if (args?.where?.symbol?.in) {
        const symbols = new Set(args.where.symbol.in);
        rows = rows.filter(row => symbols.has(row.symbol));
      }
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.validFrom?.lte) {
        rows = rows.filter(row => row.validFrom <= args.where.validFrom.lte);
      }
      return rows;
    },
  };

  public readonly keywordAlias = {
    findMany: async (args?: any) => {
      let rows = this.keywordAliasRows;
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.status) {
        rows = rows.filter(row => row.status === args.where.status);
      }
      if (args?.where?.validFrom?.lte) {
        rows = rows.filter(row => row.validFrom <= args.where.validFrom.lte);
      }
      return rows;
    },
  };

  public readonly keywordPerformancePenalty = {
    findMany: async (args?: any) => {
      let rows = this.keywordPerformancePenaltyRows;
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.keyword?.in) {
        const keywords = new Set(args.where.keyword.in);
        rows = rows.filter(row => keywords.has(row.keyword));
      }
      if (args?.where?.validFrom?.lte) {
        rows = rows.filter(row => row.validFrom <= args.where.validFrom.lte);
      }
      if (args?.where?.validTo?.gte) {
        rows = rows.filter(row => row.validTo >= args.where.validTo.gte);
      }
      if (Array.isArray(args?.where?.OR)) {
        rows = rows.filter((row) => {
          return args.where.OR.some((condition: any) => {
            if (condition.validTo === null) {
              return row.validTo === null;
            }
            if (condition.validTo?.gte) {
              return row.validTo === null || row.validTo >= condition.validTo.gte;
            }
            return true;
          });
        });
      }
      return rows;
    },
  };

  public readonly factSnapshot = {
    upsert: async (args: { where: { traceId: string }; create: any; update: any }) => {
      const index = this.factSnapshotRows.findIndex(row => row.traceId === args.where.traceId);
      if (index >= 0) {
        this.factSnapshotRows[index] = {
          ...this.factSnapshotRows[index],
          ...args.update,
        };
        return this.factSnapshotRows[index];
      }
      this.factSnapshotRows.push(args.create);
      return args.create;
    },
  };

  public readonly causalSignalCandidate = {
    findMany: async (args?: any) => {
      if (args?.where?.traceId) {
        return this.causalSignalCandidateList.filter(row => row.traceId === args.where.traceId);
      }
      return this.causalSignalCandidateList;
    },
  };

  public readonly graphSnapshot = {
    findUnique: async (args?: any) => {
      if (!this.graphSnapshotRecord) {
        return null;
      }
      if (args?.where?.traceId && this.graphSnapshotRecord.traceId !== args.where.traceId) {
        return null;
      }
      return this.graphSnapshotRecord;
    },
  };

  public readonly stock = {
    findMany: async (args?: any) => {
      let rows = this.stockList;
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
      let rows = this.candleList;
      if (args?.where?.stockId?.in) {
        const stockIds = new Set(args.where.stockId.in);
        rows = rows.filter(row => stockIds.has(row.stockId));
      }
      else if (args?.where?.stockId) {
        rows = rows.filter(row => row.stockId === args.where.stockId);
      }
      else if (args?.where?.stock?.symbol?.in) {
        const symbols = new Set(args.where.stock.symbol.in);
        const stockIds = new Set(
          this.stockList
            .filter(stock => (!args.where.stock.clusterKey || stock.clusterKey === args.where.stock.clusterKey) && symbols.has(stock.symbol))
            .map(stock => stock.id),
        );
        rows = rows.filter(row => stockIds.has(row.stockId));
      }
      if (args?.where?.tradingDay?.lte) {
        rows = rows.filter(row => row.tradingDay <= args.where.tradingDay.lte);
      }
      rows.sort((a, b) => {
        if (Array.isArray(args?.orderBy)) {
          const stockCompare = String(a.stockId).localeCompare(String(b.stockId));
          if (stockCompare !== 0) {
            return stockCompare;
          }
          return b.tradingDay.getTime() - a.tradingDay.getTime();
        }
        return args?.orderBy?.tradingDay === 'asc'
          ? a.tradingDay.getTime() - b.tradingDay.getTime()
          : b.tradingDay.getTime() - a.tradingDay.getTime();
      });
      const selectedRows = args?.take ? rows.slice(0, args.take) : rows;
      if (args?.select?.stock) {
        return selectedRows.map((row) => {
          const stock = this.stockList.find(item => item.id === row.stockId);
          return {
            close: row.close,
            tradingDay: row.tradingDay,
            stock: stock ? { symbol: stock.symbol } : null,
          };
        });
      }
      return selectedRows;
    },
  };

  public readonly marketSignalSnapshot = {
    findMany: async (args?: any) => {
      let rows = this.marketSignalSnapshotsCreated;
      if (args?.where?.traceId) {
        rows = rows.filter(row => row.traceId === args.where.traceId);
      }
      if (args?.where?.symbol?.in) {
        const symbols = new Set(args.where.symbol.in);
        rows = rows.filter(row => symbols.has(row.symbol));
      }
      return rows;
    },
    createMany: async (args: { data: any[] }) => {
      this.marketSignalSnapshotsCreated.push(...args.data);
      return { count: args.data.length };
    },
  };

  public readonly evidenceContribution = {
    createMany: async (args: { data: any[] }) => {
      this.evidenceContributionsCreated.push(...args.data);
      return { count: args.data.length };
    },
    findMany: async (args?: any) => {
      let rows = this.evidenceContributionsCreated;
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (Array.isArray(args?.where?.OR)) {
        rows = rows.filter((row) => {
          return args.where.OR.some((condition: any) => {
            return (!condition.traceId || row.traceId === condition.traceId)
              && (!condition.symbol || row.symbol === condition.symbol);
          });
        });
      }
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
    findMany: async (args?: any) => {
      let rows = this.recommendationSnapshotsCreated;
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.asOf?.gte) {
        rows = rows.filter(row => row.asOf >= args.where.asOf.gte);
      }
      if (args?.where?.asOf?.lt) {
        rows = rows.filter(row => row.asOf < args.where.asOf.lt);
      }
      return rows;
    },
    createMany: async (args: { data: any[] }) => {
      this.recommendationSnapshotsCreated.push(...args.data);
      return { count: args.data.length };
    },
  };
}

const addNews = (
  db: MockPrismaClient,
  input: {
    id: string;
    title: string;
    content: string;
    clusterKey: string;
    publishedAt: Date;
    reprintWeight?: number;
  },
): void => {
  db.normalizedNewsRecordList.push({
    id: input.id,
    title: input.title,
    content: input.content,
    source: '测试源',
    url: `https://example.com/${input.id}`,
    publishedAt: input.publishedAt,
    clusterKey: input.clusterKey,
    reprintWeight: input.reprintWeight ?? 1,
  });
};

const addSignal = (
  db: MockPrismaClient,
  input: {
    traceId: string;
    asOf: Date;
    clusterKey: string;
    newsId: string;
    keyword: string;
    businessVariable?: string;
    confidence?: string;
    direction?: 'positive' | 'mixed' | 'negative';
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
    direction: input.direction ?? 'positive',
    confidence: input.confidence ?? '0.8000',
    evidenceText: `${input.keyword} 证据`,
    extractorType: 'llm',
    modelVersion: 'test-model',
    promptVersion: 'causal-signal-extraction-v1',
    status: 'candidate',
  });
};

const addExposure = (
  db: MockPrismaClient,
  input: {
    clusterKey: string;
    symbol: string;
    stockName: string;
    keyword: string;
    sourceName: string;
    confidence?: string;
    memberCount?: number;
    taxonomyLevel?: string | null;
    exposureType?: string;
    source?: string;
  },
): void => {
  db.stockExposureFactList.push({
    clusterKey: input.clusterKey,
    symbol: input.symbol,
    stockName: input.stockName,
    keyword: input.keyword,
    exposureType: input.exposureType ?? (input.taxonomyLevel ? 'industry_exposure' : 'business_exposure'),
    taxonomyLevel: input.taxonomyLevel ?? null,
    source: input.source ?? (input.taxonomyLevel ? 'tickflow_sw_universe' : 'manual_verified'),
    sourceId: `${input.keyword}-${input.symbol}`,
    sourceName: input.sourceName,
    confidence: input.confidence ?? '0.9000',
    memberCount: input.memberCount ?? 1,
    validFrom: new Date('2026-05-24T00:00:00.000Z'),
    validTo: null,
    status: 'active',
  });
};

const addAlias = (
  db: MockPrismaClient,
  input: {
    clusterKey: string;
    sourceKeyword: string;
    canonicalKeyword: string;
    relationType: string;
    confidence?: number;
    validFrom?: Date;
    status?: string;
  },
): void => {
  db.keywordAliasRows.push({
    clusterKey: input.clusterKey,
    sourceKeyword: input.sourceKeyword,
    canonicalKeyword: input.canonicalKeyword,
    relationType: input.relationType,
    confidence: input.confidence ?? 0.88,
    source: 'test_alias',
    sourceId: `${input.sourceKeyword}-${input.canonicalKeyword}`,
    evidenceText: `${input.sourceKeyword} -> ${input.canonicalKeyword}`,
    validFrom: input.validFrom ?? new Date('2026-05-24T00:00:00.000Z'),
    validTo: null,
    status: input.status ?? 'active',
  });
};

const addStockWithCandles = (
  db: MockPrismaClient,
  input: {
    clusterKey: string;
    symbol: string;
    stockId: string;
    baseClose: number;
    latestClose: number;
    latestVolume: number;
  },
): void => {
  db.stockList.push({
    id: input.stockId,
    clusterKey: input.clusterKey,
    symbol: input.symbol,
  });

  const start = new Date('2026-04-24T00:00:00.000Z');
  for (let index = 0; index < 22; index += 1) {
    const progress = index / 21;
    const close = input.baseClose + (input.latestClose - input.baseClose) * progress;
    const volume = index === 21 ? input.latestVolume : 1_000_000 + index * 1_000;
    db.candleList.push({
      stockId: input.stockId,
      tradingDay: new Date(start.getTime() + index * 24 * 60 * 60 * 1000),
      open: close * 0.99,
      high: close * 1.02,
      low: close * 0.98,
      close,
      volume,
    });
  }
};

describe('scoring contribution engine', () => {
  it('creates evidence contributions from causal signal candidates and stock exposure facts', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-24T15:59:59.999Z');
    const clusterKey = 'global';
    const traceId = 'trace-causal-exposure';

    addNews(mockDb, {
      id: 'news-silver',
      title: '光伏装机需求大增 白银库存下降',
      content: '光伏装机需求大幅增长，白银库存持续下降。',
      publishedAt: new Date('2026-05-24T08:00:00.000Z'),
      clusterKey,
    });
    addSignal(mockDb, {
      traceId,
      asOf,
      clusterKey,
      newsId: 'news-silver',
      keyword: '白银',
      businessVariable: '供给不足',
    });
    addExposure(mockDb, {
      clusterKey,
      symbol: '000630',
      stockName: '铜陵有色',
      keyword: '白银',
      sourceName: '白银库存',
    });

    const result = await new ScoringContributionEngine().execute(mockDb, {
      traceId,
      asOf,
      clusterKey,
    });

    expect(result.contributionCount).toBe(1);
    expect(result.snapshotCount).toBe(1);
    expect(mockDb.evidenceContributionsCreated[0]).toEqual(expect.objectContaining({
      traceId,
      newsId: 'news-silver',
      symbol: '000630',
      keyword: '白银',
    }));
    expect(mockDb.evidenceContributionsCreated[0].reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('因果关键词 [白银]'),
      expect.stringContaining('经营变量 [供给不足]'),
      expect.stringContaining('股票暴露事实 [白银库存]'),
    ]));
  });

  it('does not let historical limit-up news facts alone create scoring evidence', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-24T15:59:59.999Z');
    const clusterKey = 'global';
    const traceId = 'trace-historical-fact-only';

    addNews(mockDb, {
      id: 'news-chip',
      title: '半导体设备需求改善',
      content: '半导体设备需求改善。',
      publishedAt: new Date('2026-05-24T08:00:00.000Z'),
      clusterKey,
    });
    addSignal(mockDb, {
      traceId,
      asOf,
      clusterKey,
      newsId: 'news-chip',
      keyword: '半导体',
    });
    addExposure(mockDb, {
      clusterKey,
      symbol: '603001',
      stockName: '奥康国际',
      keyword: '半导体',
      sourceName: '历史涨停新闻',
      exposureType: 'industry_exposure',
      source: 'historical_limitup_news',
      confidence: '0.9700',
    });

    const result = await new ScoringContributionEngine().execute(mockDb, {
      traceId,
      asOf,
      clusterKey,
    });

    expect(result.contributionCount).toBe(0);
    expect(mockDb.evidenceContributionsCreated).toHaveLength(0);
  });

  it('maps causal keywords to existing exposure keywords through active keyword aliases', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-24T15:59:59.999Z');
    const clusterKey = 'global';
    const traceId = 'trace-keyword-expansion';

    addNews(mockDb, {
      id: 'news-dairy',
      title: '原奶需求改善 乳制品销量回暖',
      content: '液奶需求筑底改善，乳制品销量回暖。',
      publishedAt: new Date('2026-05-24T08:00:00.000Z'),
      clusterKey,
    });
    addSignal(mockDb, {
      traceId,
      asOf,
      clusterKey,
      newsId: 'news-dairy',
      keyword: '原奶',
      businessVariable: '需求改善',
    });
    addExposure(mockDb, {
      clusterKey,
      symbol: '600887',
      stockName: '伊利股份',
      keyword: '乳品',
      sourceName: 'SW3乳品',
      confidence: '0.9200',
      memberCount: 16,
      taxonomyLevel: 'SW3',
    });
    addAlias(mockDb, {
      clusterKey,
      sourceKeyword: '原奶',
      canonicalKeyword: '乳品',
      relationType: 'historical_news_alias',
      confidence: 0.88,
    });

    const result = await new ScoringContributionEngine().execute(mockDb, {
      traceId,
      asOf,
      clusterKey,
    });

    expect(result.contributionCount).toBe(1);
    expect(mockDb.evidenceContributionsCreated[0]).toEqual(expect.objectContaining({
      symbol: '600887',
      keyword: '乳品',
      sourceKeyword: '原奶',
      matchedExposureKeyword: '乳品',
      matchMethod: 'historical_news_alias',
    }));
    expect(mockDb.evidenceContributionsCreated[0].reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('因果关键词 [原奶]'),
      expect.stringContaining('匹配暴露词 [乳品]'),
    ]));
  });

  it('does not broaden alias canonical keywords to less specific exposure keywords', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-24T15:59:59.999Z');
    const clusterKey = 'global';
    const traceId = 'trace-alias-specificity';

    addNews(mockDb, {
      id: 'news-mlcc',
      title: 'MLCC作为核心被动元件',
      content: 'MLCC作为核心被动元件，需求提升。',
      publishedAt: new Date('2026-05-24T08:00:00.000Z'),
      clusterKey,
    });
    addSignal(mockDb, {
      traceId,
      asOf,
      clusterKey,
      newsId: 'news-mlcc',
      keyword: 'MLCC',
      businessVariable: '需求提升',
    });
    addExposure(mockDb, {
      clusterKey,
      symbol: '000001',
      stockName: '宽元件股',
      keyword: '元件',
      sourceName: 'SW2元件',
      confidence: '0.8400',
      memberCount: 42,
      taxonomyLevel: 'SW2',
    });
    addExposure(mockDb, {
      clusterKey,
      symbol: '000002',
      stockName: '被动元件股',
      keyword: '被动元件',
      sourceName: 'SW3被动元件',
      confidence: '0.9200',
      memberCount: 11,
      taxonomyLevel: 'SW3',
    });
    addAlias(mockDb, {
      clusterKey,
      sourceKeyword: 'MLCC',
      canonicalKeyword: '被动元件',
      relationType: 'rule_news_alias',
      confidence: 0.9,
    });

    await new ScoringContributionEngine().execute(mockDb, {
      traceId,
      asOf,
      clusterKey,
    });

    expect(mockDb.evidenceContributionsCreated).toHaveLength(1);
    expect(mockDb.evidenceContributionsCreated[0]).toEqual(expect.objectContaining({
      symbol: '000002',
      matchedExposureKeyword: '被动元件',
      matchMethod: 'rule_news_alias',
    }));
  });

  it('persists exposure match cache from real evidence contribution matches on the SQL path', async () => {
    const mockDb = new MockPrismaClient({ rawSql: true });
    const asOf = new Date('2026-05-24T15:59:59.999Z');
    const clusterKey = 'global';
    const traceId = 'trace-exposure-match-cache';

    addNews(mockDb, {
      id: 'news-dairy-cache',
      title: '原奶需求改善 乳品销量回暖',
      content: '原奶需求改善，乳品销量回暖。',
      publishedAt: new Date('2026-05-24T08:00:00.000Z'),
      clusterKey,
    });
    addSignal(mockDb, {
      traceId,
      asOf,
      clusterKey,
      newsId: 'news-dairy-cache',
      keyword: '原奶',
      businessVariable: '需求改善',
    });
    addExposure(mockDb, {
      clusterKey,
      symbol: '600887',
      stockName: '伊利股份',
      keyword: '乳品',
      sourceName: 'SW3乳品',
      confidence: '0.9200',
      memberCount: 16,
      taxonomyLevel: 'SW3',
    });
    addAlias(mockDb, {
      clusterKey,
      sourceKeyword: '原奶',
      canonicalKeyword: '乳品',
      relationType: 'historical_news_alias',
      confidence: 0.88,
    });

    const result = await new ScoringContributionEngine().execute(mockDb, {
      traceId,
      asOf,
      clusterKey,
    });

    expect(result.contributionCount).toBe(1);
    expect(result.metrics).toEqual(expect.objectContaining({
      exposureMatchCacheRows: 1,
    }));
    expect(mockDb.exposureMatchCacheRows).toEqual([
      expect.objectContaining({
        clusterKey,
        sourceKeyword: '原奶',
        exposureKeyword: '乳品',
        matchMethod: 'historical_news_alias',
      }),
    ]);
  });

  it('does not score direct stock or keyword mentions without causal signals and exposure facts', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'global';

    addNews(mockDb, {
      id: 'news-direct-stock',
      title: '中国铝业涨停',
      content: '新闻直接提到中国铝业，但没有因果候选和暴露事实。',
      publishedAt: new Date(asOf.getTime() - 1000),
      clusterKey,
    });

    const result = await new ScoringContributionEngine().execute(mockDb, {
      traceId: 'trace-direct-mention',
      asOf,
      clusterKey,
    });

    expect(result.contributionCount).toBe(0);
    expect(result.snapshotCount).toBe(0);
    expect(mockDb.evidenceContributionsCreated).toHaveLength(0);
  });

  it('dilutes broad industry exposure so a large universe cannot dominate narrow exposure', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-24T15:59:59.999Z');
    const clusterKey = 'global';
    const traceId = 'trace-broad-exposure';

    addNews(mockDb, {
      id: 'news-chem',
      title: '化工产品价格上涨 需求增加',
      content: '化工产品价格上涨，需求增加。',
      publishedAt: new Date('2026-05-24T08:00:00.000Z'),
      clusterKey,
    });
    addSignal(mockDb, {
      traceId,
      asOf,
      clusterKey,
      newsId: 'news-chem',
      keyword: '化工',
      businessVariable: '价格上涨',
    });
    addExposure(mockDb, {
      clusterKey,
      symbol: '600001',
      stockName: '宽行业股',
      keyword: '化工',
      sourceName: 'SW1基础化工',
      confidence: '0.7600',
      memberCount: 200,
      taxonomyLevel: 'SW1',
    });
    addExposure(mockDb, {
      clusterKey,
      symbol: '600002',
      stockName: '窄行业股',
      keyword: '化工',
      sourceName: 'SW3炼油化工',
      confidence: '0.9200',
      memberCount: 4,
      taxonomyLevel: 'SW3',
    });

    await new ScoringContributionEngine().execute(mockDb, {
      traceId,
      asOf,
      clusterKey,
    });

    const wide = mockDb.evidenceContributionsCreated.find(row => row.symbol === '600001');
    const narrow = mockDb.evidenceContributionsCreated.find(row => row.symbol === '600002');
    expect(Number(wide.finalContribScore)).toBeLessThan(Number(narrow.finalContribScore));
    expect(wide.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('宽度惩罚系数'),
    ]));
  });

  it('prevents single stock score monopoly even with 100 highly duplicate reprint news', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'global';
    const traceId = 'trace-reprint-cap';

    addExposure(mockDb, {
      clusterKey,
      symbol: '600000',
      stockName: '浦发银行',
      keyword: '信贷',
      sourceName: '银行信贷业务暴露',
    });

    for (let i = 0; i < 100; i++) {
      const newsId = i === 0 ? 'news-original' : `news-reprint-${i}`;
      addNews(mockDb, {
        id: newsId,
        title: '信贷支持政策强化',
        content: '信贷支持政策强化，银行信贷投放增加。',
        publishedAt: new Date(asOf.getTime() - (12 * 60 + i * 5) * 60 * 1000),
        clusterKey,
        reprintWeight: i === 0 ? 1 : 0.15,
      });
      addSignal(mockDb, {
        traceId,
        asOf,
        clusterKey,
        newsId,
        keyword: '信贷',
        businessVariable: '信贷投放增加',
        confidence: '0.9000',
      });
    }

    const result = await new ScoringContributionEngine().execute(mockDb, {
      traceId,
      asOf,
      clusterKey,
      newsWindowDays: 7,
    });

    expect(result.contributionCount).toBe(100);
    expect(mockDb.evidenceContributionsCreated).toHaveLength(100);
    expect(mockDb.stockFeatureSnapshotsCreated).toHaveLength(1);

    const snapshot = mockDb.stockFeatureSnapshotsCreated[0];
    const newsFrequencyScore = Number(snapshot.newsFrequencyScore);
    expect(snapshot.symbol).toBe('600000');
    expect(newsFrequencyScore).toBeLessThanOrEqual(35.0);
    expect(newsFrequencyScore).toBeGreaterThan(20.0);
    expect(snapshot.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('评分组件：证据'),
    ]));
  });

  it('adds capped graph relationship confidence and weak signal bonus under equal news contribution', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'global';
    const traceId = 'trace-with-graph-snapshot';

    addNews(mockDb, {
      id: 'news-metals',
      title: '白银铜需求同步回暖',
      content: '白银库存下降，铜库存下降。',
      publishedAt: new Date('2026-05-24T06:00:00.000Z'),
      clusterKey,
    });
    for (const keyword of ['白银', '铜']) {
      addSignal(mockDb, {
        traceId,
        asOf,
        clusterKey,
        newsId: 'news-metals',
        keyword,
        businessVariable: '库存下降',
      });
    }
    addExposure(mockDb, {
      clusterKey,
      symbol: '600111',
      stockName: '北方稀土',
      keyword: '白银',
      sourceName: '白银伴生矿',
    });
    addExposure(mockDb, {
      clusterKey,
      symbol: '000630',
      stockName: '铜陵有色',
      keyword: '铜',
      sourceName: '铜矿产能',
    });
    mockDb.graphSnapshotRecord = {
      traceId,
      asOf,
      clusterKey,
      nodesJson: [
        { keyword: '白银', category: 'theme', frequency: 1, temperature: 'warming', weakSignal: true },
        { keyword: '光伏', category: 'industry', frequency: 3, temperature: 'hot', weakSignal: false },
        { keyword: '铜', category: 'theme', frequency: 1, temperature: 'warming', weakSignal: false },
      ],
      edgesJson: [
        {
          sourceKeyword: '白银',
          targetKeyword: '光伏',
          relationType: 'supply_chain',
          direction: 'source_to_target',
          confidence: 0.9,
          status: 'active',
          weakSignal: true,
          evidence: ['光伏用银需求抬升'],
          reasoning: '白银是光伏产业链瓶颈材料',
          updatedAt: '2026-05-24T08:00:00.000Z',
        },
      ],
    };

    await new ScoringContributionEngine().execute(mockDb, {
      traceId,
      asOf,
      clusterKey,
      scoringProfile: 'short_news',
    });

    const silverSnapshot = mockDb.stockFeatureSnapshotsCreated.find(item => item.symbol === '600111');
    const copperSnapshot = mockDb.stockFeatureSnapshotsCreated.find(item => item.symbol === '000630');

    expect(Number(silverSnapshot.newsFrequencyScore)).toBe(Number(copperSnapshot.newsFrequencyScore));
    expect(Number(silverSnapshot.relationConfidenceScore)).toBeGreaterThan(0);
    expect(Number(silverSnapshot.weakSignalBonus)).toBeGreaterThan(0);
    expect(Number(copperSnapshot.relationConfidenceScore)).toBe(0);
    expect(Number(copperSnapshot.weakSignalBonus)).toBe(0);
    expect(Number(silverSnapshot.aggregatedScore)).toBeGreaterThan(Number(copperSnapshot.aggregatedScore));
  });

  it('caps graph relationship confidence and weak signal bonus to avoid graph monopoly', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'global';
    const traceId = 'trace-with-capped-graph-score';

    addNews(mockDb, {
      id: 'news-silver',
      title: '白银需求回暖',
      content: '白银库存下降。',
      publishedAt: new Date('2026-05-24T06:00:00.000Z'),
      clusterKey,
    });
    addSignal(mockDb, {
      traceId,
      asOf,
      clusterKey,
      newsId: 'news-silver',
      keyword: '白银',
      businessVariable: '库存下降',
    });
    addExposure(mockDb, {
      clusterKey,
      symbol: '600111',
      stockName: '北方稀土',
      keyword: '白银',
      sourceName: '白银伴生矿',
    });
    mockDb.graphSnapshotRecord = {
      traceId,
      asOf,
      clusterKey,
      nodesJson: [
        { keyword: '白银', category: 'theme', frequency: 1, temperature: 'warming', weakSignal: true },
        ...Array.from({ length: 8 }, (_, index) => ({
          keyword: `关联主题${index + 1}`,
          category: 'theme',
          frequency: 1,
          temperature: 'warming',
          weakSignal: false,
        })),
      ],
      edgesJson: Array.from({ length: 8 }, (_, index) => ({
        sourceKeyword: '白银',
        targetKeyword: `关联主题${index + 1}`,
        relationType: 'supply_chain',
        direction: 'source_to_target',
        confidence: 0.95,
        status: 'active',
        weakSignal: true,
        evidence: [`白银关联主题${index + 1}`],
        reasoning: `白银关联主题${index + 1}`,
        updatedAt: '2026-05-24T08:00:00.000Z',
      })),
    };

    await new ScoringContributionEngine().execute(mockDb, {
      traceId,
      asOf,
      clusterKey,
      scoringProfile: 'short_news',
    });

    const snapshot = mockDb.stockFeatureSnapshotsCreated[0];
    const newsFrequencyScore = Number(snapshot.newsFrequencyScore);
    const relationConfidenceScore = Number(snapshot.relationConfidenceScore);
    const weakSignalBonus = Number(snapshot.weakSignalBonus);
    const aggregatedScore = Number(snapshot.aggregatedScore);

    expect(Number(snapshot.boardMatchScore)).toBeGreaterThan(0);
    expect(relationConfidenceScore).toBe(9);
    expect(weakSignalBonus).toBe(6);
    expect(aggregatedScore).toBeCloseTo(newsFrequencyScore + Number(snapshot.boardMatchScore) + 15, 4);
    expect(snapshot.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('图谱关系置信度封顶 2.00'),
      expect.stringContaining('图谱弱信号封顶 1.00'),
    ]));
  });

  it('differentiates same-industry stocks with market confirmation signals', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-24T15:59:59.999Z');
    const clusterKey = 'global';
    const traceId = 'trace-market-confirmation';

    addNews(mockDb, {
      id: 'news-chem-market',
      title: '化工产品价格上涨 需求增加',
      content: '化工产品价格上涨，需求增加。',
      publishedAt: new Date('2026-05-24T08:00:00.000Z'),
      clusterKey,
    });
    addSignal(mockDb, {
      traceId,
      asOf,
      clusterKey,
      newsId: 'news-chem-market',
      keyword: '化工',
      businessVariable: '价格上涨',
    });
    for (const symbol of ['600101', '600102']) {
      addExposure(mockDb, {
        clusterKey,
        symbol,
        stockName: `化工股${symbol}`,
        keyword: '化工',
        sourceName: 'SW3化工',
        confidence: '0.9000',
        memberCount: 4,
        taxonomyLevel: 'SW3',
      });
    }
    addStockWithCandles(mockDb, {
      clusterKey,
      symbol: '600101',
      stockId: 'stock-600101',
      baseClose: 10,
      latestClose: 12,
      latestVolume: 3_000_000,
    });
    addStockWithCandles(mockDb, {
      clusterKey,
      symbol: '600102',
      stockId: 'stock-600102',
      baseClose: 10,
      latestClose: 9.8,
      latestVolume: 900_000,
    });

    await new ScoringContributionEngine().execute(mockDb, {
      traceId,
      asOf,
      clusterKey,
    });

    const strong = mockDb.stockFeatureSnapshotsCreated.find(item => item.symbol === '600101');
    const weak = mockDb.stockFeatureSnapshotsCreated.find(item => item.symbol === '600102');

    expect(Number(strong.newsFrequencyScore)).toBe(Number(weak.newsFrequencyScore));
    expect(Number(strong.boardMatchScore)).toBe(Number(weak.boardMatchScore));
    expect(Number(strong.aggregatedScore)).toBeGreaterThan(Number(weak.aggregatedScore));
    expect(strong.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('市场确认信号'),
      expect.stringContaining('最新用于评分交易日'),
    ]));
  });

  it('applies active keyword performance penalties and ignores expired penalties', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-29T12:00:00.000Z');
    const clusterKey = 'global';
    const traceId = 'trace-keyword-performance-penalty';

    addNews(mockDb, {
      id: 'news-metals-penalty',
      title: '白银铜需求同步回暖',
      content: '白银需求回暖，铜需求回暖。',
      publishedAt: new Date('2026-05-29T08:00:00.000Z'),
      clusterKey,
    });
    for (const keyword of ['白银', '铜']) {
      addSignal(mockDb, {
        traceId,
        asOf,
        clusterKey,
        newsId: 'news-metals-penalty',
        keyword,
        businessVariable: '需求回暖',
      });
      addExposure(mockDb, {
        clusterKey,
        symbol: keyword === '白银' ? '600111' : '000630',
        stockName: keyword === '白银' ? '白银股' : '铜股',
        keyword,
        sourceName: `${keyword}业务暴露`,
      });
    }
    mockDb.keywordPerformancePenaltyRows = [
      {
        clusterKey,
        keyword: '白银',
        factor: '0.6000',
        lossPct: '-0.041000',
        triggerSymbol: '600100',
        triggerTraceId: 'trace-loss',
        validFrom: new Date('2026-05-29T09:00:00.000Z'),
        validTo: new Date('2026-06-05T09:00:00.000Z'),
        reason: '测试有效惩罚',
      },
      {
        clusterKey,
        keyword: '铜',
        factor: '0.1000',
        lossPct: '-0.080000',
        triggerSymbol: '600200',
        triggerTraceId: 'trace-expired',
        validFrom: new Date('2026-05-20T09:00:00.000Z'),
        validTo: new Date('2026-05-27T09:00:00.000Z'),
        reason: '测试过期惩罚',
      },
    ];

    const result = await new ScoringContributionEngine().execute(mockDb, {
      traceId,
      asOf,
      clusterKey,
    });

    expect(result.contributionCount).toBe(2);
    const silver = mockDb.evidenceContributionsCreated.find(row => row.keyword === '白银');
    const copper = mockDb.evidenceContributionsCreated.find(row => row.keyword === '铜');
    expect(Number(silver.finalContribScore)).toBeLessThan(Number(copper.finalContribScore));
    expect(silver.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('关键词表现惩罚 0.6000'),
    ]));
    expect(copper.reasons.some((reason: string) => reason.includes('关键词表现惩罚'))).toBe(false);
  });

  it('uses movement evidence only as market confirmation for stocks that already have evidence', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-24T15:59:59.999Z');
    const clusterKey = 'global';
    const traceId = 'trace-movement-confirmation';

    addNews(mockDb, {
      id: 'news-chip-movement',
      title: '半导体设备订单增长',
      content: '半导体设备订单增长，需求增加。',
      publishedAt: new Date('2026-05-24T08:00:00.000Z'),
      clusterKey,
    });
    addSignal(mockDb, {
      traceId,
      asOf,
      clusterKey,
      newsId: 'news-chip-movement',
      keyword: '半导体设备',
      businessVariable: '订单增长',
    });
    for (const symbol of ['600301', '600302']) {
      addExposure(mockDb, {
        clusterKey,
        symbol,
        stockName: `设备股${symbol}`,
        keyword: '半导体设备',
        sourceName: 'SW3半导体设备',
        confidence: '0.9000',
        memberCount: 4,
        taxonomyLevel: 'SW3',
      });
      addStockWithCandles(mockDb, {
        clusterKey,
        symbol,
        stockId: `stock-${symbol}`,
        baseClose: 10,
        latestClose: 11,
        latestVolume: 2_000_000,
      });
    }
    addExposure(mockDb, {
      clusterKey,
      symbol: '600301',
      stockName: '设备股600301',
      keyword: '火箭发射',
      sourceName: '个股异动',
      confidence: '0.8000',
      exposureType: 'movement_evidence',
      source: 'akshare_stock_changes_em',
    });
    addExposure(mockDb, {
      clusterKey,
      symbol: '600999',
      stockName: '无证据异动股',
      keyword: '火箭发射',
      sourceName: '个股异动',
      confidence: '0.9000',
      exposureType: 'movement_evidence',
      source: 'akshare_stock_changes_em',
    });

    await new ScoringContributionEngine().execute(mockDb, {
      traceId,
      asOf,
      clusterKey,
    });

    const confirmed = mockDb.stockFeatureSnapshotsCreated.find(item => item.symbol === '600301');
    const plain = mockDb.stockFeatureSnapshotsCreated.find(item => item.symbol === '600302');

    expect(mockDb.evidenceContributionsCreated.map(row => row.symbol).sort()).toEqual(['600301', '600302']);
    expect(mockDb.evidenceContributionsCreated.some(row => row.symbol === '600999')).toBe(false);
    expect(Number(confirmed.aggregatedScore)).toBeGreaterThan(Number(plain.aggregatedScore));
    expect(confirmed.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('异动确认'),
      expect.stringContaining('仅在已有 EvidenceContribution 候选后作为市场确认调整'),
      expect.stringContaining('异动事实 [个股异动] 火箭发射'),
    ]));
  });

  it('loads market confirmation candles in one batch and persists market signal snapshots', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-24T15:59:59.999Z');
    const clusterKey = 'global';
    const traceId = 'trace-market-batch';

    addNews(mockDb, {
      id: 'news-batch',
      title: '机器人订单增长 算力需求增加',
      content: '机器人订单增长，算力需求增加。',
      publishedAt: new Date('2026-05-24T08:00:00.000Z'),
      clusterKey,
    });
    for (const keyword of ['机器人', '算力']) {
      addSignal(mockDb, {
        traceId,
        asOf,
        clusterKey,
        newsId: 'news-batch',
        keyword,
        businessVariable: '需求增加',
      });
    }
    for (const row of [
      ['600201', '机器人股', '机器人', 'stock-600201'],
      ['600202', '算力股', '算力', 'stock-600202'],
    ] as const) {
      addExposure(mockDb, {
        clusterKey,
        symbol: row[0],
        stockName: row[1],
        keyword: row[2],
        sourceName: `${row[2]}暴露`,
      });
      addStockWithCandles(mockDb, {
        clusterKey,
        symbol: row[0],
        stockId: row[3],
        baseClose: 10,
        latestClose: 11,
        latestVolume: 2_000_000,
      });
    }

    await new ScoringContributionEngine().execute(mockDb, {
      traceId,
      asOf,
      clusterKey,
    });

    expect(mockDb.candleFindManyCalls).toBe(1);
    expect(mockDb.marketSignalSnapshotsCreated.map(row => row.symbol).sort()).toEqual(['600201', '600202']);
    expect(mockDb.stockFeatureSnapshotsCreated).toHaveLength(2);
  });

  it('loads physical features and generates recommendations with primary signal type cap', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'global';
    const traceId = 'test-trace-id-999';

    for (const row of [
      ['600000', '浦发银行', '金融科技'],
      ['000001', '平安银行', '金融科技'],
      ['601398', '工商银行', '金融科技'],
      ['300024', '机器人', '机器人'],
    ] as const) {
      addExposure(mockDb, {
        clusterKey,
        symbol: row[0],
        stockName: row[1],
        keyword: row[2],
        sourceName: `${row[2]}暴露`,
      });
      addStockWithCandles(mockDb, {
        clusterKey,
        symbol: row[0],
        stockId: `stock-${row[0]}`,
        baseClose: 10,
        latestClose: 11,
        latestVolume: 2_000_000,
      });
    }

    mockDb.stockFeatureSnapshotsCreated = [
      { traceId, symbol: '600000', asOf, clusterKey, newsFrequencyScore: 8.0, relationConfidenceScore: 0.0, boardMatchScore: 0.0, weakSignalBonus: 0.0, aggregatedScore: 8.0, reasons: [] },
      { traceId, symbol: '000001', asOf, clusterKey, newsFrequencyScore: 7.5, relationConfidenceScore: 0.0, boardMatchScore: 0.0, weakSignalBonus: 0.0, aggregatedScore: 7.5, reasons: [] },
      { traceId, symbol: '601398', asOf, clusterKey, newsFrequencyScore: 7.0, relationConfidenceScore: 0.0, boardMatchScore: 0.0, weakSignalBonus: 0.0, aggregatedScore: 7.0, reasons: [] },
      { traceId, symbol: '300024', asOf, clusterKey, newsFrequencyScore: 6.0, relationConfidenceScore: 0.0, boardMatchScore: 0.0, weakSignalBonus: 0.0, aggregatedScore: 6.0, reasons: [] },
    ];
    mockDb.evidenceContributionsCreated = [
      { traceId, asOf, clusterKey, newsId: 'news-bank-1', symbol: '600000', keyword: '订单增加', finalContribScore: 0.8 },
      { traceId, asOf, clusterKey, newsId: 'news-bank-2', symbol: '000001', keyword: '订单增加', finalContribScore: 0.7 },
      { traceId, asOf, clusterKey, newsId: 'news-bank-3', symbol: '601398', keyword: '订单增加', finalContribScore: 0.6 },
      { traceId, asOf, clusterKey, newsId: 'news-robot', symbol: '300024', keyword: '机器人', finalContribScore: 0.5 },
    ];

    const recommendations = await new TempStockRecommendationService().generatePhysicalRecommendations(
      mockDb,
      traceId,
      asOf,
      clusterKey,
      3,
      2,
    );

    expect(recommendations).toHaveLength(3);
    expect(recommendations[0]?.symbol).toBe('600000');
    expect(recommendations[1]?.symbol).toBe('000001');
    expect(recommendations[2]?.symbol).toBe('300024');
    expect(recommendations[0]?.matchedSignals).toEqual(['订单增加']);
    expect(recommendations[2]?.matchedSignals).toEqual(['机器人']);
    expect(mockDb.recommendationSnapshotsCreated).toHaveLength(3);
    expect(mockDb.recommendationSnapshotsCreated[0]).toEqual(expect.objectContaining({
      rank: 1,
      symbol: '600000',
      stockName: '浦发银行',
      industry: '金融科技',
    }));
  });

  it('uses authoritative stock exposure facts for recommendation stock info instead of historical or movement facts', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'global';
    const traceId = 'test-trace-stock-info-source';

    mockDb.stockFeatureSnapshotsCreated = [
      {
        traceId,
        symbol: '603001',
        asOf,
        clusterKey,
        newsFrequencyScore: 20,
        relationConfidenceScore: 0,
        boardMatchScore: 8,
        weakSignalBonus: 0,
        aggregatedScore: 28,
        reasons: [
          '评分组件：证据 20.0000/45，图谱 0.0000/20，暴露 8.0000/15，市场 0.0000/20，总分 28.0000/100',
        ],
      },
    ];
    mockDb.evidenceContributionsCreated = [
      { traceId, asOf, clusterKey, newsId: 'news-1', symbol: '603001', keyword: '服装家纺', finalContribScore: 0.8 },
    ];
    addExposure(mockDb, {
      clusterKey,
      symbol: '603001',
      stockName: '奥康国际',
      keyword: '半导体',
      sourceName: '历史涨停新闻',
      exposureType: 'industry_exposure',
      source: 'historical_limitup_news',
      confidence: '0.9700',
    });
    addExposure(mockDb, {
      clusterKey,
      symbol: '603001',
      stockName: '奥康国际',
      keyword: '火箭发射',
      sourceName: '个股异动',
      exposureType: 'movement_evidence',
      source: 'akshare_stock_changes_em',
      confidence: '0.9000',
    });
    addExposure(mockDb, {
      clusterKey,
      symbol: '603001',
      stockName: '奥康国际',
      keyword: '服装家纺',
      sourceName: 'SW2服装家纺',
      taxonomyLevel: 'SW2',
      source: 'tickflow_sw_universe',
      confidence: '0.8400',
    });
    addStockWithCandles(mockDb, {
      clusterKey,
      symbol: '603001',
      stockId: 'stock-603001',
      baseClose: 10,
      latestClose: 11,
      latestVolume: 2_000_000,
    });

    const recommendations = await new TempStockRecommendationService().generatePhysicalRecommendations(
      mockDb,
      traceId,
      asOf,
      clusterKey,
      1,
      1,
    );

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]?.industry).toBe('服装家纺');
    expect(recommendations[0]?.industry).not.toBe('半导体');
    expect(recommendations[0]?.industry).not.toBe('火箭发射');
  });

  it('reports shortfall diagnostics instead of padding recommendations without evidence', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'global';
    const traceId = 'test-trace-shortfall';

    for (const row of [
      ['600000', '浦发银行', '订单增加'],
      ['000001', '平安银行', '订单增加'],
      ['300024', '机器人', '机器人'],
    ] as const) {
      addExposure(mockDb, {
        clusterKey,
        symbol: row[0],
        stockName: row[1],
        keyword: row[2],
        sourceName: `${row[2]}暴露`,
      });
      addStockWithCandles(mockDb, {
        clusterKey,
        symbol: row[0],
        stockId: `stock-${row[0]}`,
        baseClose: 10,
        latestClose: 11,
        latestVolume: 2_000_000,
      });
    }
    mockDb.stockFeatureSnapshotsCreated = [
      { traceId, symbol: '600000', asOf, clusterKey, newsFrequencyScore: 18.0, relationConfidenceScore: 0.0, boardMatchScore: 8.0, weakSignalBonus: 0.0, aggregatedScore: 26.0, reasons: [] },
      { traceId, symbol: '000001', asOf, clusterKey, newsFrequencyScore: 17.5, relationConfidenceScore: 0.0, boardMatchScore: 8.0, weakSignalBonus: 0.0, aggregatedScore: 25.5, reasons: [] },
      { traceId, symbol: '300024', asOf, clusterKey, newsFrequencyScore: 16.0, relationConfidenceScore: 0.0, boardMatchScore: 8.0, weakSignalBonus: 0.0, aggregatedScore: 24.0, reasons: [] },
    ];
    mockDb.evidenceContributionsCreated = [
      { traceId, asOf, clusterKey, newsId: 'news-bank-1', symbol: '600000', keyword: '订单增加', finalContribScore: 0.8 },
      { traceId, asOf, clusterKey, newsId: 'news-bank-2', symbol: '000001', keyword: '订单增加', finalContribScore: 0.7 },
      { traceId, asOf, clusterKey, newsId: 'news-robot', symbol: '300024', keyword: '机器人', finalContribScore: 0.5 },
    ];

    const result = await new TempStockRecommendationService().generatePhysicalRecommendationsWithDiagnostics(
      mockDb,
      traceId,
      asOf,
      clusterKey,
      30,
      5,
    );

    expect(result.recommendations).toHaveLength(3);
    expect(result.diagnostics).toEqual(expect.objectContaining({
      featureSnapshotCount: 3,
      evidenceCandidateCount: 3,
      selectedCount: 3,
      limit: 30,
      uniqueSignalTypes: 2,
    }));
    expect(result.diagnostics.shortfallReasons).toEqual(expect.arrayContaining([
      expect.stringContaining('因果贡献候选只有 3 只'),
      expect.stringContaining('可贡献信号类型只有 2 个'),
    ]));
  });

  it('supplements an evidence shortfall with real positive movement facts', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'global';
    const traceId = 'test-trace-movement-supplement';

    addExposure(mockDb, {
      clusterKey,
      symbol: '600000',
      stockName: '因果证据股',
      keyword: '电池',
      sourceName: '电池暴露',
      taxonomyLevel: 'SW3',
    });
    addStockWithCandles(mockDb, {
      clusterKey,
      symbol: '600000',
      stockId: 'stock-600000',
      baseClose: 10,
      latestClose: 11,
      latestVolume: 2_000_000,
    });
    mockDb.stockFeatureSnapshotsCreated.push({
      traceId,
      symbol: '600000',
      asOf,
      clusterKey,
      newsFrequencyScore: 20,
      relationConfidenceScore: 0,
      boardMatchScore: 8,
      weakSignalBonus: 0,
      aggregatedScore: 28,
      reasons: [],
    });
    mockDb.evidenceContributionsCreated.push({
      traceId,
      asOf,
      clusterKey,
      newsId: 'news-600000',
      symbol: '600000',
      keyword: '电池',
      matchedExposureKeyword: '电池',
      finalContribScore: 0.8,
    });

    for (let index = 0; index < 5; index += 1) {
      const symbol = `60001${index}`;
      mockDb.stockExposureFactList.push({
        id: `movement-${symbol}`,
        clusterKey,
        symbol,
        stockName: `Movement Stock ${index + 1}`,
        keyword: '大笔买入',
        exposureType: 'movement_evidence',
        taxonomyLevel: null,
        source: 'akshare_stock_board_change_em',
        sourceId: `${symbol}:大笔买入`,
        sourceName: '板块异动',
        confidence: `${0.9 - index * 0.01}`,
        memberCount: 1,
        evidenceJson: {
          rawFields: {
            板块名称: `补充板块${index + 1}`,
            板块异动最频繁个股及所属类型股票代码: symbol,
            '板块异动最频繁个股及所属类型-股票名称': `补充股${index + 1}`,
            '板块异动最频繁个股及所属类型-买卖方向': '大笔买入',
            涨跌幅: 1 + index,
          },
        },
        validFrom: new Date('2026-05-24T00:00:00.000Z'),
        validTo: null,
        status: 'active',
      });
      addStockWithCandles(mockDb, {
        clusterKey,
        symbol,
        stockId: `stock-${symbol}`,
        baseClose: 10,
        latestClose: 11 + index / 10,
        latestVolume: 2_000_000,
      });
    }

    const result = await new TempStockRecommendationService().generatePhysicalRecommendationsWithDiagnostics(
      mockDb,
      traceId,
      asOf,
      clusterKey,
      4,
      5,
    );

    expect(result.recommendations.map(item => item.symbol)).toEqual(['600000', '600010', '600011', '600012']);
    expect(result.recommendations[1]?.stockName).toBe('补充股1');
    expect(result.recommendations[1]?.scoreBreakdown.supplementalSource).toBe('movement_evidence');
    expect(result.diagnostics).toEqual(expect.objectContaining({
      evidenceCandidateCount: 1,
      supplementalCandidateCount: 5,
      supplementalSelectedCount: 3,
      selectedCount: 4,
      limit: 4,
    }));
    expect(result.diagnostics.shortfallReasons).toEqual([]);
    expect(mockDb.recommendationSnapshotsCreated).toHaveLength(4);
  });

  it('excludes 688-prefixed and ST stocks even when they have evidence', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'global';
    const traceId = 'test-trace-stock-filter';

    for (const row of [
      ['688001', '科创高分', '半导体', 99],
      ['600001', '*ST高分', '半导体', 98],
      ['600002', '正常股份', '半导体', 60],
    ] as const) {
      addExposure(mockDb, {
        clusterKey,
        symbol: row[0],
        stockName: row[1],
        keyword: row[2],
        sourceName: `${row[2]}暴露`,
      });
      addStockWithCandles(mockDb, {
        clusterKey,
        symbol: row[0],
        stockId: `stock-${row[0]}`,
        baseClose: 10,
        latestClose: 11,
        latestVolume: 2_000_000,
      });
      mockDb.stockFeatureSnapshotsCreated.push({
        traceId,
        symbol: row[0],
        asOf,
        clusterKey,
        newsFrequencyScore: 20,
        relationConfidenceScore: 0,
        boardMatchScore: 8,
        weakSignalBonus: 0,
        aggregatedScore: row[3],
        reasons: [],
      });
      mockDb.evidenceContributionsCreated.push({
        traceId,
        asOf,
        clusterKey,
        newsId: `news-${row[0]}`,
        symbol: row[0],
        keyword: row[2],
        matchedExposureKeyword: row[2],
        finalContribScore: 0.5,
      });
    }

    const result = await new TempStockRecommendationService().generatePhysicalRecommendationsWithDiagnostics(
      mockDb,
      traceId,
      asOf,
      clusterKey,
      3,
      5,
    );

    expect(result.recommendations.map(item => item.symbol)).toEqual(['600002']);
    expect(result.diagnostics.excludedByStockFilter).toBe(2);
    expect(result.diagnostics.shortfallReasons).toEqual(expect.arrayContaining([
      expect.stringContaining('排除 2 只 688 开头或 ST 股票'),
    ]));
  });

  it('excludes stocks whose latest visible five trading day gain exceeds 20 percent', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'global';
    const traceId = 'test-trace-recent-week-gain-filter';

    for (const row of [
      ['600010', '短期过热', 99, 0.201],
      ['600011', '边界可选', 98, 0.2],
      ['600012', '正常低涨幅', 97, 0.08],
    ] as const) {
      addExposure(mockDb, {
        clusterKey,
        symbol: row[0],
        stockName: row[1],
        keyword: '机器人',
        sourceName: '机器人暴露',
      });
      addStockWithCandles(mockDb, {
        clusterKey,
        symbol: row[0],
        stockId: `stock-${row[0]}`,
        baseClose: 10,
        latestClose: 11,
        latestVolume: 2_000_000,
      });
      mockDb.stockFeatureSnapshotsCreated.push({
        traceId,
        symbol: row[0],
        asOf,
        clusterKey,
        newsFrequencyScore: 20,
        relationConfidenceScore: 0,
        boardMatchScore: 8,
        weakSignalBonus: 0,
        aggregatedScore: row[2],
        reasons: [
          `marketSignal=${JSON.stringify({
            score: 10,
            latestTradingDay: '2026-05-22',
            momentum5dPct: row[3],
          })}`,
        ],
      });
      mockDb.evidenceContributionsCreated.push({
        traceId,
        asOf,
        clusterKey,
        newsId: `news-${row[0]}`,
        symbol: row[0],
        keyword: '机器人',
        matchedExposureKeyword: '机器人',
        finalContribScore: 0.5,
      });
    }

    const result = await new TempStockRecommendationService().generatePhysicalRecommendationsWithDiagnostics(
      mockDb,
      traceId,
      asOf,
      clusterKey,
      3,
      5,
    );

    expect(result.recommendations.map(item => item.symbol)).toEqual(['600011', '600012']);
    expect(result.diagnostics.excludedByRecentWeekGain).toBe(1);
    expect(result.diagnostics.shortfallReasons).toEqual(expect.arrayContaining([
      expect.stringContaining('最近 5 个交易日涨幅超过 20%'),
    ]));
  });

  it('can select 30 recommendations when six signal types each provide five evidenced stocks', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'global';
    const traceId = 'test-trace-thirty';
    const keywords = ['乳品', '玻纤制造', '航运', '半导体', '机器人', '计算机设备'];

    for (const [keywordIndex, keyword] of keywords.entries()) {
      for (let itemIndex = 0; itemIndex < 5; itemIndex += 1) {
        const symbol = `${keywordIndex + 1}${String(itemIndex).padStart(5, '0')}`;
        addExposure(mockDb, {
          clusterKey,
          symbol,
          stockName: `${keyword}股${itemIndex + 1}`,
          keyword,
          sourceName: `SW3${keyword}`,
          taxonomyLevel: 'SW3',
        });
        addStockWithCandles(mockDb, {
          clusterKey,
          symbol,
          stockId: `stock-${symbol}`,
          baseClose: 10,
          latestClose: 11,
          latestVolume: 2_000_000,
        });
        mockDb.stockFeatureSnapshotsCreated.push({
          traceId,
          symbol,
          asOf,
          clusterKey,
          newsFrequencyScore: 20 - keywordIndex,
          relationConfidenceScore: 0,
          boardMatchScore: 8,
          weakSignalBonus: 0,
          aggregatedScore: 30 - keywordIndex - itemIndex / 10,
          reasons: [],
        });
        mockDb.evidenceContributionsCreated.push({
          traceId,
          asOf,
          clusterKey,
          newsId: `news-${keywordIndex}-${itemIndex}`,
          symbol,
          keyword,
          matchedExposureKeyword: keyword,
          finalContribScore: 0.5,
        });
      }
    }

    const result = await new TempStockRecommendationService().generatePhysicalRecommendationsWithDiagnostics(
      mockDb,
      traceId,
      asOf,
      clusterKey,
      30,
      5,
    );

    expect(result.recommendations).toHaveLength(30);
    expect(result.diagnostics.shortfallReasons).toEqual([]);
    expect(Object.values(result.diagnostics.signalTypeCounts)).toEqual([5, 5, 5, 5, 5, 5]);
  });

  it('does not exclude stocks and keywords recommended on the previous Beijing day', async () => {
    const mockDb = new MockPrismaClient();
    const asOf = new Date('2026-05-25T09:00:00.000Z');
    const previousAsOf = new Date('2026-05-24T09:00:00.000Z');
    const clusterKey = 'global';
    const traceId = 'test-trace-cooldown-current';
    const previousTraceId = 'test-trace-cooldown-previous';

    mockDb.recommendationSnapshotsCreated.push({
      traceId: previousTraceId,
      asOf: previousAsOf,
      clusterKey,
      rank: 1,
      symbol: '600100',
      stockName: '昨日股票',
      industry: '乳品',
      finalScore: 88,
      reasons: [],
      scoreBreakdown: {},
    });
    mockDb.evidenceContributionsCreated.push({
      traceId: previousTraceId,
      asOf: previousAsOf,
      clusterKey,
      newsId: 'news-previous',
      symbol: '600100',
      keyword: '乳品',
      matchedExposureKeyword: '乳品',
      sourceKeyword: '原奶',
      finalContribScore: 0.8,
    });

    for (const row of [
      ['600100', '昨日股票', '算力', 99],
      ['600101', '同词新股', '原奶', 98],
      ['600102', '可推荐股', '机器人', 97],
    ] as const) {
      addExposure(mockDb, {
        clusterKey,
        symbol: row[0],
        stockName: row[1],
        keyword: row[2],
        sourceName: `${row[2]}暴露`,
      });
      addStockWithCandles(mockDb, {
        clusterKey,
        symbol: row[0],
        stockId: `stock-${row[0]}`,
        baseClose: 10,
        latestClose: 11,
        latestVolume: 2_000_000,
      });
      mockDb.stockFeatureSnapshotsCreated.push({
        traceId,
        symbol: row[0],
        asOf,
        clusterKey,
        newsFrequencyScore: 20,
        relationConfidenceScore: 0,
        boardMatchScore: 8,
        weakSignalBonus: 0,
        aggregatedScore: row[3],
        reasons: [],
      });
      mockDb.evidenceContributionsCreated.push({
        traceId,
        asOf,
        clusterKey,
        newsId: `news-${row[0]}`,
        symbol: row[0],
        keyword: row[2],
        finalContribScore: 0.5,
      });
    }

    const result = await new TempStockRecommendationService().generatePhysicalRecommendationsWithDiagnostics(
      mockDb,
      traceId,
      asOf,
      clusterKey,
      3,
      5,
    );

    expect(result.recommendations.map(item => item.symbol)).toEqual(['600100', '600101', '600102']);
    expect(result.diagnostics.excludedByPreviousDayStock).toBe(0);
    expect(result.diagnostics.excludedByPreviousDayKeyword).toBe(0);
    expect(result.diagnostics.shortfallReasons).toEqual([]);
  });
});
