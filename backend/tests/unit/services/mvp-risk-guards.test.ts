import { describe, expect, it } from 'vitest';
import {
  CausalSignalExtractionService,
  OpenAiCompatibleCausalSignalExtractor,
} from '../../../src/services/causal-signal-extraction-service.js';
import { TempStockRecommendationService } from '../../../src/services/temp-stock-recommendation-service.js';

class CausalSignalMockPrismaClient {
  public readonly createdRows: any[] = [];

  public readonly causalSignalCandidate = {
    findMany: async () => [],
    createMany: async (args: { data: any[] }) => {
      this.createdRows.push(...args.data);
      return { count: args.data.length };
    },
  };
}

class RecommendationMockPrismaClient {
  public readonly stockFeatureSnapshotRows: any[] = [];
  public readonly stockExposureFactRows: any[] = [];
  public readonly evidenceContributionRows: any[] = [];
  public readonly recommendationSnapshotRows: any[] = [];

  public readonly stockFeatureSnapshot = {
    findMany: async (args?: any) => {
      if (args?.where?.traceId) {
        return this.stockFeatureSnapshotRows.filter(row => row.traceId === args.where.traceId);
      }
      return this.stockFeatureSnapshotRows;
    },
  };

  public readonly stockExposureFact = {
    findMany: async (args?: any) => {
      let rows = this.stockExposureFactRows;
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

  public readonly evidenceContribution = {
    findMany: async (args?: any) => {
      let rows = this.evidenceContributionRows;
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

  public readonly recommendationSnapshot = {
    createMany: async (args: { data: any[] }) => {
      this.recommendationSnapshotRows.push(...args.data);
      return { count: args.data.length };
    },
  };
}

const addExposure = (
  db: RecommendationMockPrismaClient,
  input: {
    readonly traceId: string;
    readonly asOf: Date;
    readonly clusterKey: string;
    readonly symbol: string;
    readonly stockName: string;
    readonly keyword: string;
    readonly score: number;
    readonly momentum5dPct?: number | null;
    readonly hasEvidence?: boolean;
  },
): void => {
  db.stockExposureFactRows.push({
    clusterKey: input.clusterKey,
    symbol: input.symbol,
    stockName: input.stockName,
    keyword: input.keyword,
    taxonomyLevel: 'SW3',
    confidence: '0.9000',
    validFrom: new Date('2026-05-01T00:00:00.000Z'),
    validTo: null,
    status: 'active',
  });

  db.stockFeatureSnapshotRows.push({
    traceId: input.traceId,
    symbol: input.symbol,
    asOf: input.asOf,
    clusterKey: input.clusterKey,
    newsFrequencyScore: 20,
    relationConfidenceScore: 6,
    boardMatchScore: 8,
    weakSignalBonus: 2,
    aggregatedScore: input.score,
    reasons: [
      `marketSignal=${JSON.stringify({
        score: 10,
        latestTradingDay: '2026-05-22',
        latestMarketTradingDay: '2026-05-22',
        momentum5dPct: input.momentum5dPct ?? 0,
        momentum20dPct: 0,
      })}`,
    ],
  });

  if (input.hasEvidence ?? true) {
    db.evidenceContributionRows.push({
      traceId: input.traceId,
      asOf: input.asOf,
      clusterKey: input.clusterKey,
      newsId: `news-${input.symbol}`,
      symbol: input.symbol,
      keyword: input.keyword,
      matchedExposureKeyword: input.keyword,
      finalContribScore: 0.8,
    });
  }
};

describe('MVP recommendation risk guards', () => {
  it('fails LLM extraction before request when payload exceeds the default 240000 character limit', async () => {
    const db = new CausalSignalMockPrismaClient();
    let requestCount = 0;
    const fetchImpl = async (): Promise<Response> => {
      requestCount += 1;
      return new Response('{}', { status: 200 });
    };

    await expect(new CausalSignalExtractionService(new OpenAiCompatibleCausalSignalExtractor({
      baseUrl: 'https://llm.example/v1',
      apiKey: 'test-key',
      model: 'gpt-5.4-mini',
      fetchImpl: fetchImpl as typeof fetch,
      maxRetries: 0,
    })).execute(db, {
      traceId: 'trace-oversized-default-limit',
      asOf: new Date('2026-05-24T15:59:59.999Z'),
      clusterKey: 'global',
      batchSize: 1,
      news: [{
        id: 'news-oversized',
        title: `白银库存下降${'长标题'.repeat(80_000)}`,
        content: '白银库存下降，供给不足。',
        source: 'aktools',
        publishedAt: new Date('2026-05-24T08:00:00.000Z'),
      }],
    })).rejects.toThrow('Causal signal AI request too large');

    expect(requestCount).toBe(0);
    expect(db.createdRows).toEqual([]);
  });

  it('filters 688, ST and recent five-day gain above 20 percent while refusing to pad stocks without evidence', async () => {
    const db = new RecommendationMockPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'global';
    const traceId = 'trace-risk-filters';

    addExposure(db, { traceId, asOf, clusterKey, symbol: '688001', stockName: '科创高分', keyword: '半导体', score: 99 });
    addExposure(db, { traceId, asOf, clusterKey, symbol: '600001', stockName: '*ST高分', keyword: '半导体', score: 98 });
    addExposure(db, { traceId, asOf, clusterKey, symbol: '600002', stockName: '短期过热', keyword: '机器人', score: 97, momentum5dPct: 0.201 });
    addExposure(db, { traceId, asOf, clusterKey, symbol: '600003', stockName: '无证据高分', keyword: '算力', score: 96, hasEvidence: false });
    addExposure(db, { traceId, asOf, clusterKey, symbol: '600004', stockName: '有效股份', keyword: '算力', score: 60, momentum5dPct: 0.14 });

    const result = await new TempStockRecommendationService().generatePhysicalRecommendationsWithDiagnostics(
      db,
      traceId,
      asOf,
      clusterKey,
      5,
      5,
    );

    expect(result.recommendations.map(item => item.symbol)).toEqual(['600004']);
    expect(db.recommendationSnapshotRows.map(item => item.symbol)).toEqual(['600004']);
    expect(result.diagnostics).toEqual(expect.objectContaining({
      featureSnapshotCount: 5,
      evidenceCandidateCount: 1,
      excludedByStockFilter: 2,
      excludedByRecentWeekGain: 1,
      selectedCount: 1,
      limit: 5,
    }));
    expect(result.diagnostics.shortfallReasons).toEqual(expect.arrayContaining([
      expect.stringContaining('候选只有 1 只'),
      expect.stringContaining('排除 2 只 688 开头或 ST 股票'),
      expect.stringContaining('最近 5 个交易日涨幅超过 20%'),
    ]));
  });

  it('caps each primary signal type at five and reports no-evidence shortfall instead of backfilling', async () => {
    const db = new RecommendationMockPrismaClient();
    const asOf = new Date('2026-05-24T12:00:00.000Z');
    const clusterKey = 'global';
    const traceId = 'trace-signal-cap';

    for (let index = 0; index < 7; index += 1) {
      addExposure(db, {
        traceId,
        asOf,
        clusterKey,
        symbol: `60010${index}`,
        stockName: `半导体股${index + 1}`,
        keyword: '半导体',
        score: 100 - index,
      });
    }

    for (let index = 0; index < 3; index += 1) {
      addExposure(db, {
        traceId,
        asOf,
        clusterKey,
        symbol: `60020${index}`,
        stockName: `无证据股${index + 1}`,
        keyword: '机器人',
        score: 80 - index,
        hasEvidence: false,
      });
    }

    const result = await new TempStockRecommendationService().generatePhysicalRecommendationsWithDiagnostics(
      db,
      traceId,
      asOf,
      clusterKey,
      10,
      5,
    );

    expect(result.recommendations.map(item => item.symbol)).toEqual([
      '600100',
      '600101',
      '600102',
      '600103',
      '600104',
    ]);
    expect(result.diagnostics.signalTypeCounts).toEqual({ '半导体': 5 });
    expect(result.diagnostics.skippedBySignalTypeCap).toBe(2);
    expect(result.diagnostics.selectedCount).toBe(5);
    expect(result.diagnostics.shortfallReasons).toEqual(expect.arrayContaining([
      expect.stringContaining('未用无证据股票硬凑'),
      expect.stringContaining('可贡献信号类型只有 1 个'),
    ]));
  });
});
