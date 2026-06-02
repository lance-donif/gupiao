import type { IExposureCandidateExtractor } from '../../../src/services/limitup-evidence-initialization.js';
import { describe, expect, it } from 'vitest';
import { CoverageInitializationRepository } from '../../../src/repositories/coverage-initialization-repository.js';
import {
  CoverageGapAnalyzer,
  EvidencePromotionService,
  ExposureCandidateValidationService,
  FactSnapshotService,
  HistoricalExposureCandidateGenerator,
  HistoricalLimitUpCaseRebuilder,
  HistoricalNewsWindowLoader,
  KeywordAliasPromotionService,
  resolveHistoricalNewsWindowBounds,
  resolveLimitRule,
  RuleBasedAliasCandidateGenerator,
} from '../../../src/services/limitup-evidence-initialization.js';

class MockCoveragePrismaClient {
  public stocks: any[] = [];
  public candles: any[] = [];
  public historicalLimitUpCases: any[] = [];
  public coverageGapCases: any[] = [];
  public recommendations: any[] = [];
  public evidenceRows: any[] = [];
  public featureRows: any[] = [];
  public signalRows: any[] = [];
  public newsRows: any[] = [];
  public exposureCandidates: any[] = [];
  public exposureFacts: any[] = [];
  public keywordAliases: any[] = [];
  public factSnapshots: any[] = [];

  public readonly stock = {
    findMany: async (args?: any) => {
      let rows = this.stocks;
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      return rows;
    },
  };

  public readonly candle = {
    findMany: async (args?: any) => {
      let rows = this.candles;
      if (args?.where?.stockId?.in) {
        const ids = new Set(args.where.stockId.in);
        rows = rows.filter(row => ids.has(row.stockId));
      }
      if (args?.where?.tradingDay?.lte) {
        rows = rows.filter(row => row.tradingDay <= args.where.tradingDay.lte);
      }
      return rows.sort((left, right) => {
        const stockCompare = String(left.stockId).localeCompare(String(right.stockId));
        return stockCompare || left.tradingDay.getTime() - right.tradingDay.getTime();
      });
    },
  };

  public readonly historicalLimitUpCase = {
    createMany: async (args: { data: any[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const row of args.data) {
        const exists = this.historicalLimitUpCases.some(existing =>
          existing.traceId === row.traceId
          && existing.symbol === row.symbol
          && existing.tradeDate.getTime() === row.tradeDate.getTime(),
        );
        if (!exists || !args.skipDuplicates) {
          this.historicalLimitUpCases.push({
            id: `case-${this.historicalLimitUpCases.length + 1}`,
            ...row,
          });
          count += 1;
        }
      }
      return { count };
    },
    findMany: async (args?: any) => {
      let rows = this.historicalLimitUpCases;
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.tradeDate instanceof Date) {
        rows = rows.filter(row => row.tradeDate.getTime() === args.where.tradeDate.getTime());
      }
      else if (args?.where?.tradeDate?.gte && args?.where?.tradeDate?.lt) {
        rows = rows.filter(row =>
          row.tradeDate >= args.where.tradeDate.gte
          && row.tradeDate < args.where.tradeDate.lt,
        );
      }
      if (args?.where?.sealedLimit === true) {
        rows = rows.filter(row => row.sealedLimit === true);
      }
      return rows;
    },
  };

  public readonly coverageGapCase = {
    createMany: async (args: { data: any[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const row of args.data) {
        const exists = this.coverageGapCases.some(existing =>
          existing.traceId === row.traceId
          && existing.symbol === row.symbol
          && existing.tradeDate.getTime() === row.tradeDate.getTime()
          && existing.gapStage === row.gapStage
          && existing.missReason === row.missReason,
        );
        if (!exists || !args.skipDuplicates) {
          this.coverageGapCases.push({
            id: `gap-${this.coverageGapCases.length + 1}`,
            ...row,
          });
          count += 1;
        }
      }
      return { count };
    },
    findMany: async (args?: any) => {
      let rows = this.coverageGapCases;
      if (args?.where?.traceId) {
        rows = rows.filter(row => row.traceId === args.where.traceId);
      }
      return rows;
    },
  };

  public readonly recommendationSnapshot = {
    findMany: async (args?: any) => {
      let rows = this.recommendations;
      if (args?.where?.traceId) {
        rows = rows.filter(row => row.traceId === args.where.traceId);
      }
      return rows;
    },
  };

  public readonly evidenceContribution = {
    findMany: async (args?: any) => {
      let rows = this.evidenceRows;
      if (args?.where?.traceId) {
        rows = rows.filter(row => row.traceId === args.where.traceId);
      }
      return rows;
    },
  };

  public readonly stockFeatureSnapshot = {
    findMany: async (args?: any) => {
      let rows = this.featureRows;
      if (args?.where?.traceId) {
        rows = rows.filter(row => row.traceId === args.where.traceId);
      }
      return rows;
    },
  };

  public readonly normalizedNewsRecord = {
    findMany: async (args?: any) => {
      let rows = this.newsRows;
      if (typeof args?.where?.id === 'string') {
        rows = rows.filter(row => row.id === args.where.id);
      }
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.id?.in) {
        const ids = new Set(args.where.id.in);
        rows = rows.filter(row => ids.has(row.id));
      }
      if (args?.where?.publishedAt?.gte) {
        rows = rows.filter(row => row.publishedAt >= args.where.publishedAt.gte);
      }
      if (args?.where?.publishedAt?.lte) {
        rows = rows.filter(row => row.publishedAt <= args.where.publishedAt.lte);
      }
      return rows;
    },
    findUnique: async (args?: any) => {
      return this.newsRows.find(row => row.id === args?.where?.id) ?? null;
    },
  };

  public readonly stockExposureCandidate = {
    createMany: async (args: { data: any[]; skipDuplicates?: boolean }) => {
      this.exposureCandidates.push(...args.data.map((row, index) => ({
        id: `candidate-${this.exposureCandidates.length + index + 1}`,
        ...row,
      })));
      return { count: args.data.length };
    },
    findMany: async (args?: any) => {
      let rows = this.exposureCandidates;
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.status) {
        rows = rows.filter(row => row.status === args.where.status);
      }
      return typeof args?.take === 'number' ? rows.slice(0, args.take) : rows;
    },
    update: async (args: { where: { id: string }; data: any }) => {
      const index = this.exposureCandidates.findIndex(row => row.id === args.where.id);
      this.exposureCandidates[index] = {
        ...this.exposureCandidates[index],
        ...args.data,
      };
      return this.exposureCandidates[index];
    },
  };

  public readonly stockExposureFact = {
    createMany: async (args: { data: any[]; skipDuplicates?: boolean }) => {
      this.exposureFacts.push(...args.data);
      return { count: args.data.length };
    },
    upsert: async (args: { create: any }) => {
      this.exposureFacts.push(args.create);
      return args.create;
    },
    findMany: async (args?: any) => {
      let rows = this.exposureFacts;
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.symbol?.in) {
        const symbols = new Set(args.where.symbol.in);
        rows = rows.filter(row => symbols.has(row.symbol));
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

  public readonly keywordAlias = {
    createMany: async (args: { data: any[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const row of args.data) {
        const exists = this.keywordAliases.some(existing =>
          existing.clusterKey === row.clusterKey
          && existing.sourceKeyword === row.sourceKeyword
          && existing.canonicalKeyword === row.canonicalKeyword
          && existing.relationType === row.relationType
          && existing.source === row.source
          && existing.sourceId === row.sourceId,
        );
        if (!exists || !args.skipDuplicates) {
          this.keywordAliases.push({
            id: `alias-${this.keywordAliases.length + 1}`,
            ...row,
          });
          count += 1;
        }
      }
      return { count };
    },
    findMany: async (args?: any) => {
      let rows = this.keywordAliases;
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.status) {
        rows = rows.filter(row => row.status === args.where.status);
      }
      if (args?.where?.validFrom?.lte) {
        rows = rows.filter(row => row.validFrom <= args.where.validFrom.lte);
      }
      return typeof args?.take === 'number' ? rows.slice(0, args.take) : rows;
    },
    update: async (args: { where: { id: string }; data: any }) => {
      const index = this.keywordAliases.findIndex(row => row.id === args.where.id);
      this.keywordAliases[index] = {
        ...this.keywordAliases[index],
        ...args.data,
      };
      return this.keywordAliases[index];
    },
  };

  public readonly causalSignalCandidate = {
    findMany: async (args?: any) => {
      let rows = this.signalRows;
      if (args?.where?.traceId) {
        rows = rows.filter(row => row.traceId === args.where.traceId);
      }
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.status) {
        rows = rows.filter(row => row.status === args.where.status);
      }
      if (args?.where?.asOf?.lte) {
        rows = rows.filter(row => row.asOf <= args.where.asOf.lte);
      }
      return rows;
    },
  };

  public readonly factSnapshot = {
    upsert: async (args: { where: { traceId: string }; create: any; update: any }) => {
      const index = this.factSnapshots.findIndex(row => row.traceId === args.where.traceId);
      if (index >= 0) {
        this.factSnapshots[index] = {
          ...this.factSnapshots[index],
          ...args.update,
        };
        return this.factSnapshots[index];
      }
      this.factSnapshots.push(args.create);
      return args.create;
    },
    findUnique: async (args: { where: { traceId: string } }) => {
      return this.factSnapshots.find(row => row.traceId === args.where.traceId) ?? null;
    },
  };
}

class FixedExposureExtractor implements IExposureCandidateExtractor {
  public readonly modelVersion = 'test-model';
  public readonly promptVersion = 'test-prompt';

  public async extract() {
    return [{
      keyword: '液冷',
      exposureType: 'concept_exposure',
      sourceId: 'news-1',
      sourceName: '测试新闻',
      evidenceText: '液冷服务器需求增长',
      confidence: 0.82,
      aliasSuggestions: [{
        sourceKeyword: '液冷服务器',
        canonicalKeyword: '液冷',
        confidence: 0.8,
        evidenceText: '液冷服务器需求增长',
      }],
    }] as const;
  }
}

describe('limit-up evidence initialization', () => {
  it('adds repository rows idempotently', async () => {
    const db = new MockCoveragePrismaClient();
    const repository = new CoverageInitializationRepository(db);
    const row = {
      traceId: 'trace-a',
      clusterKey: 'global',
      symbol: '600001',
      stockName: '样本股份',
      tradeDate: new Date('2026-05-25T00:00:00.000Z'),
      touchLimit: true,
      sealedLimit: true,
      prevClose: 10,
      high: 11,
      close: 11,
      boardType: 'MAIN',
      limitThresholdPct: 0.1,
      diagnosticsJson: {},
    };

    await repository.writeHistoricalLimitUpCases([row]);
    await repository.writeHistoricalLimitUpCases([row]);

    expect(db.historicalLimitUpCases).toHaveLength(1);
  });

  it('rebuilds sealed limit-up cases from previous close and current candle', async () => {
    const db = new MockCoveragePrismaClient();
    db.stocks.push({ id: 'stock-1', clusterKey: 'global', symbol: '600001', name: '样本股份' });
    db.candles.push(
      { stockId: 'stock-1', tradingDay: new Date('2026-05-24T00:00:00.000Z'), close: 10, high: 10.1 },
      { stockId: 'stock-1', tradingDay: new Date('2026-05-25T00:00:00.000Z'), close: 11, high: 11 },
    );

    const result = await new HistoricalLimitUpCaseRebuilder().rebuild(db, {
      traceId: 'trace-limit',
      clusterKey: 'global',
      asOf: new Date('2026-05-25T15:00:00.000Z'),
      days: 1,
      mode: 'sealed',
    });

    expect(result.sealedCount).toBe(1);
    expect(db.historicalLimitUpCases[0]).toEqual(expect.objectContaining({
      symbol: '600001',
      sealedLimit: true,
      boardType: 'MAIN',
    }));
  });

  it('classifies missed sealed limit-up cases by evidence chain', async () => {
    const db = new MockCoveragePrismaClient();
    db.stocks.push({ id: 'stock-1', clusterKey: 'global', symbol: '600001', name: '样本股份' });
    db.historicalLimitUpCases.push({
      id: 'case-1',
      traceId: 'limit-trace',
      clusterKey: 'global',
      symbol: '600001',
      stockName: '样本股份',
      tradeDate: new Date('2026-05-25T00:00:00.000Z'),
      touchLimit: true,
      sealedLimit: true,
    });

    const result = await new CoverageGapAnalyzer().analyze(db, {
      traceId: 'recommend-trace',
      clusterKey: 'global',
      asOf: new Date('2026-05-24T15:00:00.000Z'),
      targetDate: new Date('2026-05-25T00:00:00.000Z'),
      mode: 'sealed',
    });

    expect(result.unselectedCount).toBe(1);
    expect(result.reasonCounts.no_evidence_chain).toBe(1);
    expect(db.coverageGapCases[0]).toEqual(expect.objectContaining({
      missReason: 'no_evidence_chain',
      gapStage: 'evidence_generation',
    }));
  });

  it('loads historical news window from T-3 to T0 15:00 Beijing time', async () => {
    const db = new MockCoveragePrismaClient();
    db.newsRows.push({
      id: 'news-1',
      clusterKey: 'global',
      title: '液冷服务器需求增长',
      content: '液冷服务器需求增长',
      source: '测试新闻',
      publishedAt: new Date('2026-05-24T08:00:00.000Z'),
    });

    const bounds = resolveHistoricalNewsWindowBounds(new Date('2026-05-25T00:00:00.000Z'), 3);
    expect(bounds.windowEnd.toISOString()).toBe('2026-05-25T07:00:00.000Z');

    const result = await new HistoricalNewsWindowLoader().load(db, {
      clusterKey: 'global',
      tradeDate: new Date('2026-05-25T00:00:00.000Z'),
    });

    expect(result.status).toBe('ready');
    expect(result.news).toHaveLength(1);
  });

  it('generates pending candidates only when source evidence exists', async () => {
    const db = new MockCoveragePrismaClient();
    db.coverageGapCases.push({
      id: 'gap-1',
      traceId: 'trace-candidates',
      clusterKey: 'global',
      symbol: '600001',
      stockName: '样本股份',
      tradeDate: new Date('2026-05-25T00:00:00.000Z'),
    });
    db.newsRows.push({
      id: 'news-1',
      clusterKey: 'global',
      title: '液冷服务器需求增长',
      content: '液冷服务器需求增长',
      source: '测试新闻',
      publishedAt: new Date('2026-05-24T08:00:00.000Z'),
    });

    const result = await new HistoricalExposureCandidateGenerator(new FixedExposureExtractor()).generate(db, {
      traceId: 'trace-candidates',
      clusterKey: 'global',
      asOf: new Date('2026-05-26T00:00:00.000Z'),
    });

    expect(result.candidateCount).toBe(1);
    expect(db.exposureCandidates[0]).toEqual(expect.objectContaining({
      status: 'pending_review',
      evidenceText: '液冷服务器需求增长',
      validFromCandidate: new Date('2026-05-26T00:00:00.000Z'),
    }));
  });

  it('promotes validated candidates with validation-time validFrom and active aliases', async () => {
    const db = new MockCoveragePrismaClient();
    db.newsRows.push({
      id: 'news-1',
      clusterKey: 'global',
      title: '液冷服务器需求增长',
      content: '液冷服务器需求增长',
      source: '测试新闻',
      publishedAt: new Date('2026-05-24T08:00:00.000Z'),
    });
    db.exposureCandidates.push({
      id: 'candidate-1',
      traceId: 'trace-promotion',
      clusterKey: 'global',
      symbol: '600001',
      stockName: '样本股份',
      keyword: '液冷',
      exposureType: 'concept_exposure',
      taxonomyLevel: null,
      source: 'historical_limitup_news',
      sourceId: 'news-1',
      sourceName: '测试新闻',
      confidence: 0.82,
      evidenceText: '液冷服务器需求增长',
      evidenceJson: {
        aliasSuggestions: [{
          sourceKeyword: '液冷服务器',
          canonicalKeyword: '液冷',
          confidence: 0.8,
        }],
      },
      memberCount: null,
      validFrom: new Date('2026-05-24T00:00:00.000Z'),
      validTo: null,
      status: 'validated',
    });
    const validFrom = new Date('2026-05-26T09:00:00.000Z');

    const result = await new EvidencePromotionService().promote(db, {
      clusterKey: 'global',
      status: 'validated',
      validFrom,
    });

    expect(result.promotedFactCount).toBe(1);
    expect(db.exposureFacts[0].validFrom).toBe(validFrom);
    expect(db.keywordAliases[0]).toEqual(expect.objectContaining({
      status: 'active',
      sourceKeyword: '液冷服务器',
      canonicalKeyword: '液冷',
      validFrom,
    }));
    expect(db.exposureCandidates[0].status).toBe('promoted');
  });

  it('validates pending candidates only when source evidence is still locatable', async () => {
    const db = new MockCoveragePrismaClient();
    db.newsRows.push({
      id: 'news-1',
      clusterKey: 'global',
      title: '液冷服务器需求增长',
      content: '液冷服务器需求增长',
      source: '测试新闻',
      publishedAt: new Date('2026-05-24T08:00:00.000Z'),
    });
    db.exposureCandidates.push(
      {
        id: 'candidate-1',
        clusterKey: 'global',
        sourceId: 'news-1',
        evidenceText: '液冷服务器需求增长',
        confidence: 0.82,
        status: 'pending_review',
      },
      {
        id: 'candidate-2',
        clusterKey: 'global',
        sourceId: 'news-1',
        evidenceText: '不存在的证据',
        confidence: 0.81,
        status: 'pending_review',
      },
    );

    const result = await new ExposureCandidateValidationService().validate(db, {
      clusterKey: 'global',
    });

    expect(result).toEqual({
      candidateCount: 2,
      validatedCount: 1,
      rejectedCount: 1,
    });
    expect(db.exposureCandidates[0]).toEqual(expect.objectContaining({
      status: 'validated',
      failureReason: null,
    }));
    expect(db.exposureCandidates[1]).toEqual(expect.objectContaining({
      status: 'rejected',
      failureReason: 'evidence_text_not_found',
    }));
  });

  it('generates rule alias candidates from missed cases, causal signals, and existing exposures', async () => {
    const db = new MockCoveragePrismaClient();
    db.coverageGapCases.push({
      id: 'gap-1',
      traceId: 'trace-source',
      clusterKey: 'global',
      symbol: '600001',
      stockName: '样本股份',
      tradeDate: new Date('2026-05-25T00:00:00.000Z'),
      status: 'open',
    });
    db.signalRows.push({
      traceId: 'trace-source',
      clusterKey: 'global',
      newsId: 'news-1',
      assetOrThemeKeyword: '电子级氢氟酸',
      evidenceText: '电子级氢氟酸需求增长',
      confidence: 0.86,
      status: 'candidate',
      asOf: new Date('2026-05-24T15:00:00.000Z'),
    });
    db.newsRows.push({
      id: 'news-1',
      clusterKey: 'global',
      title: '电子级氢氟酸需求增长',
      content: '电子级氢氟酸需求增长',
      source: '测试新闻',
      publishedAt: new Date('2026-05-24T08:00:00.000Z'),
    });
    db.exposureFacts.push({
      id: 'fact-1',
      clusterKey: 'global',
      symbol: '600001',
      stockName: '样本股份',
      keyword: '氢氟酸',
      exposureType: 'concept_exposure',
      source: 'seed',
      sourceId: 'seed-1',
      status: 'active',
      validFrom: new Date('2026-05-24T00:00:00.000Z'),
      validTo: null,
    });

    const result = await new RuleBasedAliasCandidateGenerator().generate(db, {
      traceId: 'trace-alias',
      sourceTraceId: 'trace-source',
      clusterKey: 'global',
      asOf: new Date('2026-05-24T15:00:00.000Z'),
    });

    expect(result.generatedAliasCount).toBe(1);
    expect(db.keywordAliases[0]).toEqual(expect.objectContaining({
      status: 'candidate',
      sourceKeyword: '电子级氢氟酸',
      canonicalKeyword: '氢氟酸',
      sourceId: 'news-1',
      evidenceText: '电子级氢氟酸需求增长',
    }));
  });

  it('does not generate rule aliases when source and exposure words are only separately mentioned', async () => {
    const db = new MockCoveragePrismaClient();
    db.coverageGapCases.push({
      id: 'gap-1',
      traceId: 'trace-source',
      clusterKey: 'global',
      symbol: '600001',
      stockName: '样本股份',
      tradeDate: new Date('2026-05-25T00:00:00.000Z'),
      status: 'open',
    });
    db.signalRows.push({
      traceId: 'trace-source',
      clusterKey: 'global',
      newsId: 'news-1',
      assetOrThemeKeyword: 'MLCC',
      evidenceText: 'MLCC行业迎来爆发时刻',
      confidence: 0.9,
      status: 'candidate',
      asOf: new Date('2026-05-24T15:00:00.000Z'),
    });
    db.newsRows.push({
      id: 'news-1',
      clusterKey: 'global',
      title: 'MLCC行业迎来爆发时刻',
      content: '被动元件需求提升',
      source: '测试新闻',
      publishedAt: new Date('2026-05-24T08:00:00.000Z'),
    });
    db.exposureFacts.push({
      id: 'fact-1',
      clusterKey: 'global',
      symbol: '600001',
      stockName: '样本股份',
      keyword: '被动元件',
      exposureType: 'industry_exposure',
      source: 'seed',
      sourceId: 'seed-1',
      status: 'active',
      validFrom: new Date('2026-05-24T00:00:00.000Z'),
      validTo: null,
    });

    const result = await new RuleBasedAliasCandidateGenerator().generate(db, {
      traceId: 'trace-alias',
      sourceTraceId: 'trace-source',
      clusterKey: 'global',
      asOf: new Date('2026-05-24T15:00:00.000Z'),
    });

    expect(result.generatedAliasCount).toBe(0);
    expect(db.keywordAliases).toHaveLength(0);
  });

  it('does not generate rule aliases for broad non-SW3 industry exposures', async () => {
    const db = new MockCoveragePrismaClient();
    db.coverageGapCases.push({
      id: 'gap-1',
      traceId: 'trace-source',
      clusterKey: 'global',
      symbol: '600001',
      stockName: '样本股份',
      tradeDate: new Date('2026-05-25T00:00:00.000Z'),
      status: 'open',
    });
    db.signalRows.push({
      traceId: 'trace-source',
      clusterKey: 'global',
      newsId: 'news-1',
      assetOrThemeKeyword: 'MLCC',
      evidenceText: 'MLCC作为电子电路的核心被动元件',
      confidence: 0.9,
      status: 'candidate',
      asOf: new Date('2026-05-24T15:00:00.000Z'),
    });
    db.newsRows.push({
      id: 'news-1',
      clusterKey: 'global',
      title: 'MLCC作为电子电路的核心被动元件',
      content: 'MLCC作为电子电路的核心被动元件',
      source: '测试新闻',
      publishedAt: new Date('2026-05-24T08:00:00.000Z'),
    });
    db.exposureFacts.push({
      id: 'fact-1',
      clusterKey: 'global',
      symbol: '600001',
      stockName: '样本股份',
      keyword: '电子',
      exposureType: 'industry_exposure',
      taxonomyLevel: 'SW1',
      source: 'seed',
      sourceId: 'seed-1',
      status: 'active',
      validFrom: new Date('2026-05-24T00:00:00.000Z'),
      validTo: null,
    });

    const result = await new RuleBasedAliasCandidateGenerator().generate(db, {
      traceId: 'trace-alias',
      sourceTraceId: 'trace-source',
      clusterKey: 'global',
      asOf: new Date('2026-05-24T15:00:00.000Z'),
    });

    expect(result.generatedAliasCount).toBe(0);
    expect(db.keywordAliases).toHaveLength(0);
  });

  it('promotes keyword alias candidates with validation-time validFrom', async () => {
    const db = new MockCoveragePrismaClient();
    db.newsRows.push({
      id: 'news-1',
      clusterKey: 'global',
      title: '电子级氢氟酸需求增长',
      content: '电子级氢氟酸需求增长',
      source: '测试新闻',
      publishedAt: new Date('2026-05-24T08:00:00.000Z'),
    });
    db.keywordAliases.push({
      id: 'alias-1',
      clusterKey: 'global',
      sourceKeyword: '电子级氢氟酸',
      canonicalKeyword: '氢氟酸',
      relationType: 'rule_news_alias',
      confidence: 0.86,
      source: 'rule_based_news_signal',
      sourceId: 'news-1',
      evidenceText: '电子级氢氟酸需求增长',
      validFrom: new Date('2026-05-24T15:00:00.000Z'),
      status: 'candidate',
    });
    const validFrom = new Date('2026-05-26T09:00:00.000Z');

    const result = await new KeywordAliasPromotionService().promote(db, {
      clusterKey: 'global',
      validFrom,
    });

    expect(result.promotedCount).toBe(1);
    expect(db.keywordAliases[0]).toEqual(expect.objectContaining({
      status: 'active',
      validFrom,
    }));
  });

  it('creates stable fact snapshots from active facts and aliases', async () => {
    const db = new MockCoveragePrismaClient();
    const asOf = new Date('2026-05-26T00:00:00.000Z');
    db.exposureFacts.push({
      clusterKey: 'global',
      symbol: '600001',
      keyword: '液冷',
      exposureType: 'concept_exposure',
      source: 'historical_limitup_news',
      sourceId: 'news-1',
      validFrom: new Date('2026-05-26T00:00:00.000Z'),
      validTo: null,
      status: 'active',
    });
    db.keywordAliases.push({
      clusterKey: 'global',
      sourceKeyword: '液冷服务器',
      canonicalKeyword: '液冷',
      relationType: 'historical_news_alias',
      source: 'historical_limitup_news',
      sourceId: 'news-1',
      validFrom: new Date('2026-05-26T00:00:00.000Z'),
      validTo: null,
      status: 'active',
    });

    const first = await new FactSnapshotService().ensure(db, {
      traceId: 'trace-fact',
      clusterKey: 'global',
      asOf,
    });
    const second = await new FactSnapshotService().ensure(db, {
      traceId: 'trace-fact',
      clusterKey: 'global',
      asOf,
    });

    expect(first.factHash).toBe(second.factHash);
    expect(first.activeExposureCount).toBe(1);
    expect(first.activeAliasCount).toBe(1);
  });

  it('uses 20 percent board rule for STAR and CHINEXT stocks', () => {
    expect(resolveLimitRule('300001', '创业板样本')).toEqual({
      boardType: 'CHINEXT',
      limitThresholdPct: 0.2,
    });
    expect(resolveLimitRule('688001', '科创板样本')).toEqual({
      boardType: 'STAR',
      limitThresholdPct: 0.2,
    });
  });
});
