import { describe, expect, it } from 'vitest';
import {
  __privateTickFlowStockExposure,
  isSupportedTickFlowSwUniverse,
  normalizeTickFlowSymbol,
  resolveTickFlowTaxonomyLevel,
  TickFlowStockExposureService,
} from '../../../src/services/tickflow-stock-exposure-service.js';

class MockExposurePrismaClient {
  public candidateRows: any[] = [];
  public factRows: any[] = [];

  public readonly stockExposureCandidate = {
    createMany: async (args: { data: any[] }) => {
      this.candidateRows.push(...args.data);
      return { count: args.data.length };
    },
  };

  public readonly stockExposureFact = {
    createMany: async (args: { data: any[] }) => {
      this.factRows.push(...args.data);
      return { count: args.data.length };
    },
  };
}

describe('tickflow stock exposure service', () => {
  it('only accepts CN equity SW1/SW2/SW3 universes', () => {
    expect(isSupportedTickFlowSwUniverse({
      id: 'CN_Equity_SW3_750301',
      name: 'SW3炼油化工',
      region: 'CN',
      category: 'equity',
    })).toBe(true);
    expect(isSupportedTickFlowSwUniverse({
      id: 'CN_Equity_A',
      name: '全部A股',
      region: 'CN',
      category: 'equity',
    })).toBe(false);
    expect(isSupportedTickFlowSwUniverse({
      id: 'US_Equity_SW3_750301',
      name: 'SW3炼油化工',
      region: 'US',
      category: 'equity',
    })).toBe(false);
  });

  it('normalizes tickflow A-share symbols and taxonomy levels', () => {
    expect(normalizeTickFlowSymbol('600028.SH')).toBe('600028');
    expect(normalizeTickFlowSymbol('000001.SZ')).toBe('000001');
    expect(normalizeTickFlowSymbol('920001.BJ')).toBe('920001');
    expect(normalizeTickFlowSymbol('AAPL.US')).toBeNull();
    expect(resolveTickFlowTaxonomyLevel('CN_Equity_SW1_220501')).toBe('SW1');
    expect(resolveTickFlowTaxonomyLevel('CN_Equity_SW3_750301')).toBe('SW3');
  });

  it('applies lower confidence to broad SW1 exposure than narrow SW3 exposure', () => {
    const broad = __privateTickFlowStockExposure.calculateIndustryExposureConfidence('SW1', 200);
    const narrow = __privateTickFlowStockExposure.calculateIndustryExposureConfidence('SW3', 9);
    expect(broad).toBeLessThan(narrow);
    expect(broad).toBeGreaterThanOrEqual(0.45);
  });

  it('writes candidates and promoted facts with evidence and rejects missing local stocks', async () => {
    const responses: Record<string, unknown> = {
      '/v1/universes': {
        data: [
          {
            id: 'CN_Equity_SW3_750301',
            name: 'SW3炼油化工',
            description: '申万3级行业: 炼油化工',
            region: 'CN',
            category: 'equity',
            symbol_count: 2,
          },
          {
            id: 'CN_Equity_A',
            name: '全部A股',
            region: 'CN',
            category: 'equity',
            symbol_count: 5000,
          },
        ],
      },
      '/v1/universes/CN_Equity_SW3_750301': {
        data: {
          id: 'CN_Equity_SW3_750301',
          name: 'SW3炼油化工',
          description: '申万3级行业: 炼油化工',
          region: 'CN',
          category: 'equity',
          symbol_count: 2,
          symbols: ['600028.SH', '601857.SH'],
        },
      },
    };
    const fetchImpl = async (url: string): Promise<Response> => {
      const path = new URL(url).pathname;
      const body = responses[path];
      return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
    };
    const mockDb = new MockExposurePrismaClient();
    const service = new TickFlowStockExposureService({
      apiKey: 'test-key',
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await service.sync(mockDb, {
      traceId: 'trace-1',
      asOf: new Date('2026-05-24T15:59:59.999Z'),
      clusterKey: 'global',
      stockNameBySymbol: new Map([['600028', '中国石化']]),
    });

    expect(result.universeCount).toBe(2);
    expect(result.acceptedUniverseCount).toBe(1);
    expect(result.candidateCount).toBe(1);
    expect(result.promotedFactCount).toBe(1);
    expect(result.rejectedCount).toBe(1);
    expect(mockDb.factRows[0]).toEqual(expect.objectContaining({
      symbol: '600028',
      stockName: '中国石化',
      keyword: '炼油化工',
      exposureType: 'industry_exposure',
      taxonomyLevel: 'SW3',
      source: 'tickflow_sw_universe',
      sourceId: 'CN_Equity_SW3_750301',
      status: 'active',
    }));
    expect(mockDb.factRows[0].evidenceJson).toEqual(expect.objectContaining({
      provider: 'tickflow',
      rawSymbol: '600028.SH',
      normalizedSymbol: '600028',
      memberCount: 2,
    }));
    expect(result.rejectedSample[0]).toEqual(expect.objectContaining({
      symbol: '601857',
      failureReason: 'stock_not_found',
    }));
  });
});
