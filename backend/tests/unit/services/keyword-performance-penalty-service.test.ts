import { describe, expect, it } from 'vitest';
import { KeywordPerformancePenaltyService } from '../../../src/services/keyword-performance-penalty-service.js';

class MockPenaltyPrismaClient {
  public recommendationRows: any[] = [];
  public evidenceRows: any[] = [];
  public penaltyRows: any[] = [];

  public readonly recommendationSnapshot = {
    findMany: async (args?: any) => {
      let rows = this.recommendationRows;
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.isReconciled !== undefined) {
        rows = rows.filter(row => row.isReconciled === args.where.isReconciled);
      }
      if (args?.where?.asOf?.gte) {
        rows = rows.filter(row => row.asOf >= args.where.asOf.gte);
      }
      if (args?.where?.asOf?.lt) {
        rows = rows.filter(row => row.asOf < args.where.asOf.lt);
      }
      return rows;
    },
  };

  public readonly evidenceContribution = {
    findMany: async (args?: any) => {
      let rows = this.evidenceRows;
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (Array.isArray(args?.where?.OR)) {
        rows = rows.filter((row) => {
          return args.where.OR.some((condition: any) => {
            return row.traceId === condition.traceId && row.symbol === condition.symbol;
          });
        });
      }
      return rows;
    },
  };

  public readonly keywordPerformancePenalty = {
    createMany: async (args: { data: any[] }) => {
      this.penaltyRows.push(...args.data);
      return { count: args.data.length };
    },
  };
}

describe('keyword performance penalty service', () => {
  it('creates seven-day keyword penalties from reconciled losing recommendations', async () => {
    const prisma = new MockPenaltyPrismaClient();
    const asOf = new Date('2026-05-29T09:00:00.000Z');
    const clusterKey = 'global';
    prisma.recommendationRows = [
      {
        traceId: 'trace-loss',
        asOf: new Date('2026-05-25T09:00:00.000Z'),
        clusterKey,
        symbol: '600100',
        isReconciled: true,
        yield1Day: '-0.0410',
        yield3Day: '-0.0100',
        yield5Day: '0.0200',
      },
      {
        traceId: 'trace-flat',
        asOf: new Date('2026-05-26T09:00:00.000Z'),
        clusterKey,
        symbol: '600101',
        isReconciled: true,
        yield1Day: '-0.0100',
        yield3Day: '0.0100',
        yield5Day: '0.0200',
      },
      {
        traceId: 'trace-unreconciled',
        asOf: new Date('2026-05-27T09:00:00.000Z'),
        clusterKey,
        symbol: '600102',
        isReconciled: false,
        yield1Day: '-0.0800',
      },
    ];
    prisma.evidenceRows = [
      {
        traceId: 'trace-loss',
        symbol: '600100',
        clusterKey,
        keyword: '乳品',
        matchedExposureKeyword: '乳品',
        sourceKeyword: '原奶',
      },
      {
        traceId: 'trace-flat',
        symbol: '600101',
        clusterKey,
        keyword: '机器人',
      },
    ];

    const result = await new KeywordPerformancePenaltyService().refresh(prisma, {
      asOf,
      clusterKey,
    });

    expect(result).toEqual(expect.objectContaining({
      scannedRecommendations: 2,
      losingRecommendations: 1,
      createdPenaltyCount: 2,
    }));
    expect(prisma.penaltyRows.map(row => row.keyword).sort()).toEqual(['乳品', '原奶']);
    expect(prisma.penaltyRows[0]).toEqual(expect.objectContaining({
      clusterKey,
      triggerTraceId: 'trace-loss',
      triggerSymbol: '600100',
    }));
    expect(Number(prisma.penaltyRows[0].factor)).toBe(0.6);
    expect(Number(prisma.penaltyRows[0].lossPct)).toBeCloseTo(-0.041, 6);
    expect(prisma.penaltyRows[0].validFrom.toISOString()).toBe(asOf.toISOString());
    expect(prisma.penaltyRows[0].validTo.toISOString()).toBe('2026-06-05T09:00:00.000Z');
  });
});
