import { describe, expect, it } from 'vitest';

import { syncAndVerifyStockExposureFacts } from '../../../scripts/run-daily-recommendation.js';

class MockExposurePrismaClient {
  public readonly stockExposureFact = {
    count: async () => 500,
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
  };
}

describe('run daily recommendation stock exposure sync', () => {
  it('syncs TickFlow exposure before verifying coverage', async () => {
    const syncCalls: unknown[] = [];
    const prisma = new MockExposurePrismaClient();

    const result = await syncAndVerifyStockExposureFacts({
      prisma,
      traceId: 'trace-main-2026-06-02-test',
      clusterKey: 'main',
      asOf: new Date('2026-06-02T15:59:59.999Z'),
      minExposureFacts: 500,
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
      promotedFactCount: 500,
    }));
    expect(result.exposureResult).toEqual(expect.objectContaining({
      factCount: 500,
      symbolCount: 1,
      keywordCount: 1,
      minExposureFacts: 500,
    }));
  });
});
