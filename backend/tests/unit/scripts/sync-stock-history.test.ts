import { describe, expect, it } from 'vitest';

import {
  buildYahooChartDateRange,
  convertToYahooSymbol,
  extractHistTradingDays,
  addDaysToYYYYMMDD,
  fetchRowsWithFallback,
  filterRowsToMissingTradingDays,
  mapSpotPayloadToCandleRows,
  mapYahooChartQuotesToRows,
  parseYYYYMMDD,
  selectStocksNeedingSync,
  type IStockHistoryStock,
} from '../../../scripts/sync-stock-history.js';

const stock: IStockHistoryStock = {
  id: 'stock-1',
  symbol: '000002',
};

describe('sync-stock-history Yahoo helpers', () => {
  it('maps supported A-share symbols to Yahoo symbols', () => {
    expect(convertToYahooSymbol('000002')).toBe('000002.SZ');
    expect(convertToYahooSymbol('300750')).toBe('300750.SZ');
    expect(convertToYahooSymbol('600489')).toBe('600489.SS');
    expect(convertToYahooSymbol('688001')).toBe('688001.SS');
    expect(convertToYahooSymbol('920193')).toBeNull();
  });

  it('uses an exclusive Yahoo period2 one day after the requested end date', () => {
    expect(buildYahooChartDateRange('20260629', '20260707')).toEqual({
      period1: '2026-06-29',
      period2: '2026-07-08',
    });
  });

  it('maps valid Yahoo quotes and rejects invalid OHLC rows', () => {
    const rows = mapYahooChartQuotesToRows(stock, [
      {
        date: new Date('2026-07-07T00:00:00.000Z'),
        open: 10,
        high: 11,
        low: 9,
        close: 10.5,
        volume: 1000,
      },
      {
        date: new Date('2026-07-08T00:00:00.000Z'),
        open: 10,
        high: 9,
        low: 8,
        close: 8.5,
        volume: 1000,
      },
      {
        date: new Date('2026-07-09T00:00:00.000Z'),
        open: null,
        high: 11,
        low: 9,
        close: 10,
        volume: 1000,
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stockId: 'stock-1',
      open: 10,
      high: 11,
      low: 9,
      close: 10.5,
      volume: 1000n,
    });
    expect(rows[0]?.tradingDay.toISOString()).toBe('2026-07-07T00:00:00.000Z');
  });

  it('filters rows whose stock/day already exists', () => {
    const rows = [
      {
        stockId: 'stock-1',
        tradingDay: parseYYYYMMDD('20260707'),
        open: 10,
        high: 11,
        low: 9,
        close: 10,
        volume: 100n,
      },
      {
        stockId: 'stock-1',
        tradingDay: parseYYYYMMDD('20260708'),
        open: 10,
        high: 11,
        low: 9,
        close: 10,
        volume: 100n,
      },
    ];

    expect(filterRowsToMissingTradingDays(rows, new Set(['20260707']))).toEqual([rows[1]]);
  });
});

describe('fetchRowsWithFallback', () => {
  it('falls back to Yahoo when AKTools fails', async () => {
    const calls: string[] = [];
    const result = await fetchRowsWithFallback({
      stock,
      startDate: '20260707',
      endDate: '20260707',
      enableYahooFallback: true,
      maxRetries: 0,
      aktoolsFetcher: async () => {
        calls.push('aktools');
        throw new Error('HTTP 502');
      },
      yahooFetcher: async () => {
        calls.push('yahoo');
        return [
          {
            stockId: 'stock-1',
            tradingDay: parseYYYYMMDD('20260707'),
            open: 10,
            high: 11,
            low: 9,
            close: 10.5,
            volume: 1000n,
          },
        ];
      },
    });

    expect(calls).toEqual(['aktools', 'yahoo']);
    expect(result.provider).toBe('yahoo');
    expect(result.rows).toHaveLength(1);
    expect(result.aktoolsError).toContain('HTTP 502');
  });

  it('falls back to Yahoo when AKTools returns an empty array', async () => {
    const result = await fetchRowsWithFallback({
      stock,
      startDate: '20260707',
      endDate: '20260707',
      enableYahooFallback: true,
      maxRetries: 0,
      aktoolsFetcher: async () => [],
      yahooFetcher: async () => [
        {
          stockId: 'stock-1',
          tradingDay: parseYYYYMMDD('20260707'),
          open: 10,
          high: 11,
          low: 9,
          close: 10.5,
          volume: 1000n,
        },
      ],
    });

    expect(result.provider).toBe('yahoo');
    expect(result.aktoolsError).toBe('empty_result');
  });
});

describe('selectStocksNeedingSync', () => {
  const stocks: IStockHistoryStock[] = [
    { id: 'stock-1', symbol: '000002' },
    { id: 'stock-2', symbol: '600489' },
  ];

  it('skips stocks that already hold the single requested day', () => {
    const existing = new Map<string, Set<string>>([
      ['stock-1', new Set(['20260707'])],
      ['stock-2', new Set(['20260706'])],
    ]);
    expect(selectStocksNeedingSync(stocks, existing, '20260707', '20260707'))
      .toEqual([{ id: 'stock-2', symbol: '600489' }]);
  });

  it('returns an empty list when every stock is up to date', () => {
    const existing = new Map<string, Set<string>>([
      ['stock-1', new Set(['20260707'])],
      ['stock-2', new Set(['20260707'])],
    ]);
    expect(selectStocksNeedingSync(stocks, existing, '20260707', '20260707')).toEqual([]);
  });

  it('keeps full fetch for multi-day ranges', () => {
    const existing = new Map<string, Set<string>>([
      ['stock-1', new Set(['20260706', '20260707'])],
      ['stock-2', new Set(['20260707'])],
    ]);
    expect(selectStocksNeedingSync(stocks, existing, '20260706', '20260707')).toEqual(stocks);
  });
});

describe('spot fast-path helpers', () => {
  it('adds/subtracts days across month boundaries', () => {
    expect(addDaysToYYYYMMDD('20260701', -1)).toBe('20260630');
    expect(addDaysToYYYYMMDD('20260707', 1)).toBe('20260708');
  });

  it('extracts in-range trading days from hist candles', () => {
    const days = extractHistTradingDays([
      { 日期: '2026-07-06', 开盘: 1, 最高: 2, 最低: 1, 收盘: 2, 成交量: 10 },
      { 日期: '2026-07-07', 开盘: 1, 最高: 2, 最低: 1, 收盘: 2, 成交量: 10 },
      { 日期: '2026-07-07', 开盘: 1, 最高: 2, 最低: 1, 收盘: 2, 成交量: 10 },
      { 日期: '2026-07-09', 开盘: 1, 最高: 2, 最低: 1, 收盘: 2, 成交量: 10 },
    ], '20260706', '20260707');
    expect(days).toEqual(['20260706', '20260707']);
  });

  it('maps spot rows and drops suspended/unknown symbols', () => {
    const stocksBySymbol = new Map([
      ['000002', { id: 'stock-1', symbol: '000002' }],
      ['600489', { id: 'stock-2', symbol: '600489' }],
    ]);
    const rows = mapSpotPayloadToCandleRows(stocksBySymbol, [
      { '代码': '000002', '今开': 10, '最高': 11, '最低': 9, '最新价': 10.5, '成交量': 1000 },
      { '代码': '600489', '今开': '-', '最高': '-', '最低': '-', '最新价': 5, '成交量': 0 },
      { '代码': '999999', '今开': 1, '最高': 2, '最低': 1, '最新价': 2, '成交量': 100 },
    ], parseYYYYMMDD('20260707'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stockId: 'stock-1',
      open: 10,
      high: 11,
      low: 9,
      close: 10.5,
      volume: 1000n,
    });
    expect(rows[0]?.tradingDay.toISOString()).toBe('2026-07-07T00:00:00.000Z');
  });
});
