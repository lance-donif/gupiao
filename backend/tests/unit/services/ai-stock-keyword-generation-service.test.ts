import { describe, expect, it } from 'vitest';
import { AiStockKeywordGenerationService } from '../../../src/services/ai-stock-keyword-generation-service.js';

class MockAiStockKeywordPrismaClient {
  public stockRows: any[] = [];
  public exposureRows: any[] = [];

  public readonly stock = {
    findMany: async (args?: any) => {
      let rows = this.stockRows;
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.symbol?.in) {
        rows = rows.filter(row => args.where.symbol.in.includes(row.symbol));
      }
      return rows.slice(args?.skip ?? 0, args?.take ? (args.skip ?? 0) + args.take : undefined);
    },
  };

  public readonly stockExposureFact = {
    createMany: async (args: { data: any[]; skipDuplicates?: boolean }) => {
      const existingKeys = new Set(this.exposureRows.map(row => [
        row.clusterKey,
        row.symbol,
        row.keyword,
        row.exposureType,
        row.source,
        row.sourceId,
      ].join('\u0000')));
      const inserted = [];
      for (const row of args.data) {
        const key = [
          row.clusterKey,
          row.symbol,
          row.keyword,
          row.exposureType,
          row.source,
          row.sourceId,
        ].join('\u0000');
        if (!args.data || (!args.skipDuplicates && existingKeys.has(key))) {
          continue;
        }
        if (!existingKeys.has(key)) {
          inserted.push(row);
          existingKeys.add(key);
        }
      }
      this.exposureRows.push(...inserted);
      return { count: inserted.length };
    },
  };
}

describe('ai stock keyword generation service', () => {
  it('validates AI rows, limits five keywords per stock, and writes exposure facts', async () => {
    const prisma = new MockAiStockKeywordPrismaClient();
    prisma.stockRows = [
      { id: 's1', clusterKey: 'global', symbol: '600100', name: '同方股份', industry: '计算机' },
    ];

    const service = new AiStockKeywordGenerationService({
      model: 'test-model',
      requestKeywords: async () => ({
        stocks: [
          {
            symbol: '600100',
            keywords: [
              { keyword: '计算机设备', exposureType: 'industry_exposure', confidence: 0.92, reason: '行业' },
              { keyword: '智慧城市', exposureType: 'business_exposure', confidence: 0.9, reason: '业务' },
              { keyword: '服务器', exposureType: 'product_exposure', confidence: 0.88, reason: '产品' },
              { keyword: '数据中心', exposureType: 'concept_exposure', confidence: 0.86, reason: '概念' },
              { keyword: '信创', exposureType: 'concept_exposure', confidence: 0.84, reason: '概念' },
              { keyword: '重复多余', exposureType: 'risk_exposure', confidence: 0.8, reason: '应被截断' },
            ],
          },
        ],
      }),
    });

    const result = await service.generate(prisma, {
      clusterKey: 'global',
      asOf: new Date('2026-05-29T00:00:00.000Z'),
      limit: 1,
      dryRun: false,
    });

    expect(result).toEqual(expect.objectContaining({
      stockCount: 1,
      generatedKeywordCount: 5,
      insertedCount: 5,
      dryRun: false,
    }));
    expect(prisma.exposureRows).toHaveLength(5);
    expect(prisma.exposureRows[0]).toEqual(expect.objectContaining({
      symbol: '600100',
      source: 'ai_generated_stock_knowledge',
      sourceName: 'AI 生成股票知识关键词',
      status: 'active',
    }));
    expect(prisma.exposureRows[0].evidenceJson).toEqual(expect.objectContaining({
      generatedBy: 'ai',
      isNewsEvidence: false,
      modelVersion: 'test-model',
    }));
  });

  it('does not write rows in dry-run mode', async () => {
    const prisma = new MockAiStockKeywordPrismaClient();
    prisma.stockRows = [
      { id: 's1', clusterKey: 'global', symbol: '600100', name: '同方股份', industry: '计算机' },
    ];

    const service = new AiStockKeywordGenerationService({
      model: 'test-model',
      requestKeywords: async () => ({
        stocks: [
          {
            symbol: '600100',
            keywords: [
              { keyword: '计算机设备', exposureType: 'industry_exposure', confidence: 0.92, reason: '行业' },
            ],
          },
        ],
      }),
    });

    const result = await service.generate(prisma, {
      clusterKey: 'global',
      asOf: new Date('2026-05-29T00:00:00.000Z'),
      limit: 1,
      dryRun: true,
    });

    expect(result.insertedCount).toBe(0);
    expect(result.generatedKeywordCount).toBe(1);
    expect(prisma.exposureRows).toHaveLength(0);
  });

  it('throws on invalid AI keyword output', async () => {
    const prisma = new MockAiStockKeywordPrismaClient();
    prisma.stockRows = [
      { id: 's1', clusterKey: 'global', symbol: '600100', name: '同方股份', industry: '计算机' },
    ];

    const service = new AiStockKeywordGenerationService({
      model: 'test-model',
      requestKeywords: async () => ({
        stocks: [
          {
            symbol: '600100',
            keywords: [
              { keyword: '', exposureType: 'industry_exposure', confidence: 0.92, reason: '空关键词' },
            ],
          },
        ],
      }),
    });

    await expect(service.generate(prisma, {
      clusterKey: 'global',
      asOf: new Date('2026-05-29T00:00:00.000Z'),
      limit: 1,
      dryRun: true,
    })).rejects.toThrow('AI stock keyword output has no valid keywords');
  });
});
