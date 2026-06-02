import { describe, expect, it } from 'vitest';
import {
  AkToolsStockExposureService,
  normalizeAkToolsSymbol,
} from '../../../src/services/aktools-stock-exposure-service.js';

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

const createFetch = (responses: Readonly<Record<string, unknown>>): typeof fetch => {
  return (async (url: string): Promise<Response> => {
    const parsed = new URL(url);
    const key = `${parsed.pathname}${parsed.search}`;
    const body = responses[key] ?? responses[parsed.pathname];
    return new Response(JSON.stringify(body ?? []), { status: body === undefined ? 404 : 200 });
  }) as typeof fetch;
};

const syncService = async (responses: Readonly<Record<string, unknown>>, stockNameBySymbol = new Map([['600001', '测试科技']])) => {
  const db = new MockExposurePrismaClient();
  const service = new AkToolsStockExposureService({
    baseUrl: 'http://aktools.local',
    fetchImpl: createFetch(responses),
  });

  const result = await service.sync(db, {
    traceId: 'trace-ak-1',
    asOf: new Date('2026-05-24T08:30:00.000Z'),
    clusterKey: 'global',
    stockNameBySymbol,
    boardLimit: 1,
    symbolLimit: 1,
  });

  return { db, result };
};

describe('aktools stock exposure service', () => {
  it('normalizes A-share symbols from AKTools fields', () => {
    expect(normalizeAkToolsSymbol('600001')).toBe('600001');
    expect(normalizeAkToolsSymbol('SH600001')).toBe('600001');
    expect(normalizeAkToolsSymbol('600001.SH')).toBe('600001');
    expect(normalizeAkToolsSymbol('bad')).toBeNull();
  });

  it('generates industry exposure facts with board name and request url in evidence', async () => {
    const { db, result } = await syncService({
      '/api/public/stock_board_industry_name_em': [{ 板块名称: '半导体' }],
      '/api/public/stock_board_industry_cons_em?symbol=%E5%8D%8A%E5%AF%BC%E4%BD%93': [{ 代码: '600001', 名称: '测试科技' }],
      '/api/public/stock_board_concept_name_em': [],
      '/api/public/stock_individual_info_em?symbol=600001': [],
      '/api/public/stock_changes_em': [],
      '/api/public/stock_board_change_em': [],
    });

    expect(result.candidateCount).toBe(1);
    expect(db.factRows[0]).toEqual(expect.objectContaining({
      symbol: '600001',
      keyword: '半导体',
      exposureType: 'industry_exposure',
      source: 'akshare_industry_board_em',
      status: 'active',
    }));
    expect(db.factRows[0].evidenceJson).toEqual(expect.objectContaining({
      provider: 'aktools',
      sourceName: '半导体',
      requestUrl: 'http://aktools.local/api/public/stock_board_industry_cons_em?symbol=%E5%8D%8A%E5%AF%BC%E4%BD%93',
      rawFields: expect.objectContaining({ 代码: '600001' }),
    }));
    expect(db.factRows[0].evidenceJson.rawFields.代码).toBe('600001');
  });

  it('generates concept exposure facts', async () => {
    const { db } = await syncService({
      '/api/public/stock_board_industry_name_em': [],
      '/api/public/stock_board_concept_name_em': [{ 板块名称: '光刻胶' }],
      '/api/public/stock_board_concept_cons_em?symbol=%E5%85%89%E5%88%BB%E8%83%B6': [{ 代码: '600001', 名称: '测试科技' }],
      '/api/public/stock_individual_info_em?symbol=600001': [],
      '/api/public/stock_changes_em': [],
      '/api/public/stock_board_change_em': [],
    });

    expect(db.factRows[0]).toEqual(expect.objectContaining({
      symbol: '600001',
      keyword: '光刻胶',
      exposureType: 'concept_exposure',
      source: 'akshare_concept_board_em',
    }));
  });

  it('generates company profile exposure from individual info fields', async () => {
    const { db } = await syncService({
      '/api/public/stock_board_industry_name_em': [],
      '/api/public/stock_board_concept_name_em': [],
      '/api/public/stock_individual_info_em?symbol=600001': [
        { item: '股票代码', value: '600001' },
        { item: '行业', value: '半导体设备' },
        { item: '主营业务', value: '晶圆设备制造' },
      ],
      '/api/public/stock_changes_em': [],
      '/api/public/stock_board_change_em': [],
    });

    expect(db.factRows.map(row => row.exposureType)).toContain('company_profile_exposure');
    expect(db.factRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        symbol: '600001',
        keyword: '半导体设备',
        source: 'akshare_individual_info_em',
      }),
    ]));
  });

  it('generates movement evidence without disguising it as industry or concept exposure', async () => {
    const { db } = await syncService({
      '/api/public/stock_board_industry_name_em': [],
      '/api/public/stock_board_concept_name_em': [],
      '/api/public/stock_individual_info_em?symbol=600001': [],
      '/api/public/stock_changes_em': [{ 代码: '600001', 名称: '测试科技', 异动类型: '火箭发射' }],
      '/api/public/stock_board_change_em': [],
    });

    expect(db.factRows[0]).toEqual(expect.objectContaining({
      symbol: '600001',
      keyword: '火箭发射',
      exposureType: 'movement_evidence',
      source: 'akshare_stock_changes_em',
    }));
    expect(db.factRows[0].exposureType).not.toBe('industry_exposure');
    expect(db.factRows[0].exposureType).not.toBe('concept_exposure');
  });

  it('extracts board movement evidence from long AKShare field names', async () => {
    const { db } = await syncService({
      '/api/public/stock_board_industry_name_em': [],
      '/api/public/stock_board_concept_name_em': [],
      '/api/public/stock_individual_info_em?symbol=600001': [],
      '/api/public/stock_changes_em': [],
      '/api/public/stock_board_change_em': [{
        板块名称: '半导体',
        板块异动最频繁个股及所属类型股票代码: 'ignored',
        '板块异动最频繁个股及所属类型-股票代码': '600001',
        '板块异动最频繁个股及所属类型-股票名称': '测试科技',
        '板块异动最频繁个股及所属类型-买卖方向': '大笔买入',
      }],
    });

    expect(db.factRows[0]).toEqual(expect.objectContaining({
      symbol: '600001',
      keyword: '大笔买入',
      exposureType: 'movement_evidence',
      source: 'akshare_board_change_em',
    }));
  });

  it('writes rejected candidates when local stock names are missing', async () => {
    const { db, result } = await syncService({
      '/api/public/stock_board_industry_name_em': [{ 板块名称: '半导体' }],
      '/api/public/stock_board_industry_cons_em?symbol=%E5%8D%8A%E5%AF%BC%E4%BD%93': [{ 代码: '600001', 名称: '测试科技' }],
      '/api/public/stock_board_concept_name_em': [],
      '/api/public/stock_changes_em': [],
      '/api/public/stock_board_change_em': [],
    }, new Map());

    expect(result.rejectedCount).toBe(1);
    expect(db.candidateRows[0]).toEqual(expect.objectContaining({
      symbol: '600001',
      keyword: '半导体',
      status: 'rejected',
      failureReason: 'stock_not_found',
    }));
    expect(db.factRows).toHaveLength(0);
  });
});
