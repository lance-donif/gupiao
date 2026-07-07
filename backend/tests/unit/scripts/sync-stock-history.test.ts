import { describe, expect, it } from 'vitest';

import {
  buildYahooChartDateRange,
  convertToYahooSymbol,
  fetchRowsWithFallback,
  filterRowsToMissingTradingDays,
  mapYahooChartQuotesToRows,
  parseYYYYMMDD,
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
