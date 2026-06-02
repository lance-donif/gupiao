import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildStockSyncSummary,
  createYahooValidationPayload,
  determineSymbolsToSync,
  extractStockUniverseFromAkToolsResponse,
  hasStockPoolFile,
  parseStockUniverseRecords,
  saveStockSyncFile,
  type IAkToolsStockUniverseRecord,
} from '../../../scripts/sync-stocks.js';

async function mkTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `sync-stocks-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('sync-stocks script helpers', () => {
  it('prefers full universe when no limit is provided', () => {
    const symbols = determineSymbolsToSync(['600000', '000001', '300750'], undefined);

    expect(symbols).toEqual(['600000', '000001', '300750']);
  });

  it('trims stock universe only when a positive limit is provided', () => {
    const symbols = determineSymbolsToSync(['600000', '000001', '300750'], 2);

    expect(symbols).toEqual(['600000', '000001']);
  });

  it('extracts normalized A-share symbols from aktools payload without touching database state', () => {
    const records: readonly IAkToolsStockUniverseRecord[] = [
      { code: '600000', name: '浦发银行' },
      { '代码': '000001', '名称': '平安银行' },
      { symbol: '300750', stock_name: '宁德时代' },
      { code: '830000', name: '无效北交所以外样本' },
      { code: 'abc', name: 'bad' },
      { code: '600000', name: '重复样本' },
    ];

    expect(parseStockUniverseRecords(records)).toEqual(['000001', '300750', '600000']);
  });

  it('supports aktools wrapper payloads with data field', () => {
    const payload = {
      ok: true,
      data: [
        { code: '601398', name: '工商银行' },
        { code: '601939', name: '建设银行' },
      ],
    };

    expect(extractStockUniverseFromAkToolsResponse(payload)).toEqual(['601398', '601939']);
  });

  it('builds validation summary from yahoo result items only', () => {
    const payload = createYahooValidationPayload({
      syncedAtBeijing: '2026-03-17 20:00:00',
      totalSymbols: 3,
      requestedSymbols: ['600000', '000001', '300750'],
      successItems: [
        {
          symbol: '600000',
          price: 10.5,
          currency: 'CNY',
          marketTime: '2026-03-17 15:00:00',
          capturedAt: '2026-03-17 15:00:01',
          providerMetadata: { yahooSymbol: '600000.SS', source: 'yahoo-finance' },
        },
        {
          symbol: '300750',
          price: 250,
          currency: 'CNY',
          marketTime: '2026-03-17 15:00:00',
          capturedAt: '2026-03-17 15:00:01',
          providerMetadata: { yahooSymbol: '300750.SZ', source: 'yahoo-finance' },
        },
      ],
    });

    expect(buildStockSyncSummary(payload)).toMatchObject({
      totalSymbols: 3,
      successCount: 2,
      failedCount: 1,
      failedSymbols: ['000001'],
    });
  });
});

describe('hasStockPoolFile', () => {
  it('returns false when tmp dir is empty', async () => {
    const tmpDir = await mkTempDir();
    try {
      expect(await hasStockPoolFile(tmpDir)).toBe(false);
    }
    finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns true when a stock-sync-*.json file exists', async () => {
    const tmpDir = await mkTempDir();
    try {
      await writeFile(path.join(tmpDir, 'stock-sync-2026-01-01T00-00-00.json'), '{}');
      expect(await hasStockPoolFile(tmpDir)).toBe(true);
    }
    finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns false when only unrelated files exist', async () => {
    const tmpDir = await mkTempDir();
    try {
      await writeFile(path.join(tmpDir, 'newsnow-2026-01-01T00-00-00.json'), '{}');
      expect(await hasStockPoolFile(tmpDir)).toBe(false);
    }
    finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('saveStockSyncFile', () => {
  it('writes a new stock-sync-*.json and removes old ones', async () => {
    const tmpDir = await mkTempDir();
    try {
      await writeFile(path.join(tmpDir, 'stock-sync-2025-01-01T00-00-00.json'), '{"old":true}');
      const filePath = await saveStockSyncFile({ symbols: ['600000'] }, tmpDir);
      const files = (await readdir(tmpDir)).filter(f => f.startsWith('stock-sync-') && f.endsWith('.json'));
      // 只剩新文件
      expect(files).toHaveLength(1);
      expect(filePath).toContain('stock-sync-');
    }
    finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not delete non-stock-sync files in the same tmp dir', async () => {
    const tmpDir = await mkTempDir();
    try {
      await writeFile(path.join(tmpDir, 'newsnow-2026-01-01T00-00-00.json'), '{}');
      await saveStockSyncFile({}, tmpDir);
      const files = await readdir(tmpDir);
      expect(files).toContain('newsnow-2026-01-01T00-00-00.json');
    }
    finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
