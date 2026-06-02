import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  determineHistoryTargets,
  hasLocalStockPoolFile,
  parseBaostockRows,
  parseLocalStockPool,
  parseYahooChartPayload,
  resolveThreeYearWindow,
  toYahooSymbol,
} from '../../../src/services/stock-history-sync-source.js';

async function mkTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `sync-history-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('stock-history-sync-source', () => {
  it('builds a Beijing three-year window from the requested as-of date', () => {
    expect(resolveThreeYearWindow(new Date('2026-05-24T12:00:00+08:00'))).toEqual({
      startDate: '2023-05-24',
      endDate: '2026-05-24',
    });
  });

  it('loads the local Yahoo-validated stock pool as stock-scoped targets', () => {
    const targets = parseLocalStockPool(JSON.stringify({
      requestedSymbols: ['600000', '000001', '300750', 'abc'],
      data: [
        { symbol: '600000', providerMetadata: { yahooSymbol: '600000.SS' } },
        { symbol: '000001', providerMetadata: { yahooSymbol: '000001.SZ' } },
      ],
    }));

    expect(targets).toEqual([
      { symbol: '000001', sourceSymbol: '000001.SZ', exchange: 'sz', name: '000001.SZ', industry: '未分类' },
      { symbol: '300750', sourceSymbol: '300750.SZ', exchange: 'sz', name: '股票-300750', industry: '未分类' },
      { symbol: '600000', sourceSymbol: '600000.SS', exchange: 'sh', name: '600000.SS', industry: '未分类' },
    ]);
  });

  it('converts A-share symbols to Yahoo symbols', () => {
    expect(toYahooSymbol('600000')).toBe('600000.SS');
    expect(toYahooSymbol('000001')).toBe('000001.SZ');
    expect(toYahooSymbol('300750')).toBe('300750.SZ');
    expect(toYahooSymbol('920000')).toBe('920000.BJ');
  });

  it('filters the universe by symbol first, then applies an optional limit', () => {
    const targets = [
      { symbol: '000001', sourceSymbol: '000001.SZ', exchange: 'sz', name: '平安银行', industry: '银行' },
      { symbol: '300750', sourceSymbol: '300750.SZ', exchange: 'sz', name: '宁德时代', industry: '电池' },
      { symbol: '600000', sourceSymbol: '600000.SS', exchange: 'sh', name: '浦发银行', industry: '银行' },
    ];

    expect(determineHistoryTargets(targets, 1, ['600000', '000001'])).toEqual([
      targets[0],
    ]);
    expect(determineHistoryTargets(targets, 0, ['600000', '000001'])).toEqual([
      targets[0],
      targets[2],
    ]);
  });

  it('parses Yahoo chart response into daily candles within the three-year window', () => {
    const candles = parseYahooChartPayload({
      quotes: [
        { date: new Date('2023-05-23T01:30:00.000Z'), open: 1, high: 1.1, low: 0.9, close: 1, volume: 100 },
        { date: new Date('2023-05-24T01:30:00.000Z'), open: 7.43, high: 7.44, low: 7.29, close: 7.29, volume: 45145900 },
        { date: new Date('2026-05-22T01:30:00.000Z'), open: 8.88, high: 9.03, low: 8.75, close: 8.96, volume: 99003358 },
        { date: new Date('2026-05-25T01:30:00.000Z'), open: 9, high: 9.1, low: 8.9, close: 9, volume: 100 },
        { date: new Date('2026-05-20T01:30:00.000Z'), open: 0, high: 9, low: 8, close: 8.5, volume: 100 },
      ],
    }, { startDate: '2023-05-24', endDate: '2026-05-24' });

    expect(candles).toEqual([
      { tradingDay: '2023-05-24', open: 7.43, high: 7.44, low: 7.29, close: 7.29, volume: 45145900n },
      { tradingDay: '2026-05-22', open: 8.88, high: 9.03, low: 8.75, close: 8.96, volume: 99003358n },
    ]);
  });

  it('parses Baostock rows into the same candle shape', () => {
    const candles = parseBaostockRows([
      { date: '2023-05-24', open: '7.430', close: '7.290', high: '7.440', low: '7.290', volume: '45145900' },
      { date: '2026-05-22', open: '8.880', close: '8.960', high: '9.030', low: '8.750', volume: '99003358' },
    ], { startDate: '2023-05-24', endDate: '2026-05-24' });

    expect(candles).toEqual([
      { tradingDay: '2023-05-24', open: 7.43, high: 7.44, low: 7.29, close: 7.29, volume: 45145900n },
      { tradingDay: '2026-05-22', open: 8.88, high: 9.03, low: 8.75, close: 8.96, volume: 99003358n },
    ]);
  });
});

describe('hasLocalStockPoolFile', () => {
  it('returns false when no stock-sync-*.json files exist', async () => {
    const tmpDir = await mkTempDir();
    try {
      expect(await hasLocalStockPoolFile(tmpDir)).toBe(false);
    }
    finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns true when a stock-sync-*.json file is present', async () => {
    const tmpDir = await mkTempDir();
    try {
      await writeFile(path.join(tmpDir, 'stock-sync-2026-01-01T00-00-00.json'), '{}');
      expect(await hasLocalStockPoolFile(tmpDir)).toBe(true);
    }
    finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns false when only non-stock-sync files are present', async () => {
    const tmpDir = await mkTempDir();
    try {
      await writeFile(path.join(tmpDir, 'candle-data.json'), '{}');
      expect(await hasLocalStockPoolFile(tmpDir)).toBe(false);
    }
    finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
