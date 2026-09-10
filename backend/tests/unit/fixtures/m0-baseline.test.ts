import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUSINESS_CONFIG,
  RECIPE_VERSION,
  businessConfigHash,
  canonicalize,
  causalPromptVersion,
  sha256Hex,
} from '../../../src/version.js';
import { MemoryPrisma, candleFixture, newsFixture } from './pipeline-fixtures.js';

describe('M0 version constants and business config fingerprint', () => {
  it('produces stable hashes that ignore key insertion order', async () => {
    const a = { recipeVersion: RECIPE_VERSION, scoring: { evidenceMax: 45, graphMax: 20 } };
    const b = { scoring: { graphMax: 20, evidenceMax: 45 }, recipeVersion: RECIPE_VERSION };
    expect(await sha256Hex(a)).toBe(await sha256Hex(b));
    expect(await businessConfigHash(DEFAULT_BUSINESS_CONFIG)).toHaveLength(16);
  });

  it('changes the fingerprint when a business parameter changes', async () => {
    const tweaked = { ...DEFAULT_BUSINESS_CONFIG, scoring: { ...DEFAULT_BUSINESS_CONFIG.scoring, evidenceMax: 50 } };
    expect(await businessConfigHash(tweaked)).not.toBe(await businessConfigHash(DEFAULT_BUSINESS_CONFIG));
  });

  it('canonicalizes dates to UTC ISO and bigints to strings', () => {
    expect(canonicalize({ at: new Date('2026-05-24T08:00:00.000Z'), n: BigInt(42) }))
      .toEqual({ at: '2026-05-24T08:00:00.000Z', n: '42' });
  });

  it('keeps the prompt version tied to the model fingerprint', () => {
    expect(causalPromptVersion('fp-a')).not.toBe(causalPromptVersion('fp-b'));
    expect(causalPromptVersion('fp-a')).toContain('causal-signal-extraction-v2');
  });
});

describe('M0 shared fixtures', () => {
  it('replays a failed transaction and leaves no artifacts behind', async () => {
    const prisma = new MemoryPrisma();
    await prisma.graphSnapshot.create({ data: { traceId: 'trace-1', clusterKey: 'global' } });
    await expect(prisma.$transaction(async tx => {
      await tx.graphSnapshot.create({ data: { traceId: 'trace-2', clusterKey: 'global' } });
      throw new Error('injected failure');
    })).rejects.toThrow('injected failure');
    expect(await prisma.graphSnapshot.count()).toBe(1);
    expect(prisma.transactionFailures).toBe(1);
  });

  it('filters DataRefreshLedger rows by bucket, status and visibility window', async () => {
    const prisma = new MemoryPrisma();
    const asOf = new Date('2026-05-24T08:00:00.000Z');
    await prisma.dataRefreshLedger.createMany({ data: [
      { dataKind: 'causal_signal_extraction', source: 'llm:model-a:p1', clusterKey: 'global', bucketKey: 'b1', status: 'success',
        fetchedAt: new Date('2026-05-23T00:00:00.000Z'), expiresAt: new Date('2099-01-01T00:00:00.000Z') },
      { dataKind: 'causal_signal_extraction', source: 'llm:model-a:p1', clusterKey: 'global', bucketKey: 'b2', status: 'success',
        fetchedAt: new Date('2026-05-23T00:00:00.000Z'), expiresAt: new Date('2026-05-24T00:00:00.000Z') },
    ] });
    const rows = await prisma.$queryRawUnsafe('SELECT * FROM "DataRefreshLedger"',
      'causal_signal_extraction', 'llm:model-a:p1', 'global', ['b1', 'b2'], 'success', asOf);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { bucketKey: string }).bucketKey).toBe('b1');
  });

  it('builds deterministic news and candle snapshots', () => {
    expect(newsFixture(3)).toEqual(newsFixture(3));
    expect(newsFixture(2, { lengthFactor: 4 })[0].content.length)
      .toBeGreaterThan(newsFixture(2, { lengthFactor: 1 })[0].content.length);
    const candles = candleFixture('600000', 5);
    expect(candles).toHaveLength(5);
    expect(candles[0].symbol).toBe('600000');
    expect(candles[4].tradingDay.getTime()).toBeGreaterThan(candles[0].tradingDay.getTime());
  });

  it('preserves Date instances through create and read', async () => {
    const prisma = new MemoryPrisma();
    const publishedAt = new Date('2026-05-24T08:00:00.000Z');
    await prisma.newsItem.create({ data: { id: 'n-1', symbol: '600000', publishedAt } });
    const [row] = await prisma.newsItem.findMany();
    expect(row.publishedAt).toBeInstanceOf(Date);
    expect(row.publishedAt.getTime()).toBe(publishedAt.getTime());
  });

  it('supports OR / AND / NOT and date range filters', async () => {
    const prisma = new MemoryPrisma();
    await prisma.newsItem.createMany({ data: [
      { id: 'n-1', symbol: '600000', publishedAt: new Date('2026-05-20T08:00:00.000Z') },
      { id: 'n-2', symbol: '600519', publishedAt: new Date('2026-05-24T08:00:00.000Z') },
      { id: 'n-3', symbol: '000001', publishedAt: new Date('2026-05-26T08:00:00.000Z') },
    ] });

    const orRows = await prisma.newsItem.findMany({
      where: { OR: [{ symbol: '600000' }, { symbol: '000001' }] },
    });
    expect(orRows.map((row: { id: string }) => row.id).sort()).toEqual(['n-1', 'n-3']);

    const andRows = await prisma.newsItem.findMany({
      where: { AND: [{ symbol: { in: ['600000', '600519'] } }, { publishedAt: { gte: new Date('2026-05-24T00:00:00.000Z') } }] },
    });
    expect(andRows.map((row: { id: string }) => row.id)).toEqual(['n-2']);

    const notRows = await prisma.newsItem.findMany({ where: { NOT: { symbol: '600519' } } });
    expect(notRows).toHaveLength(2);

    const ordered = await prisma.newsItem.findMany({ where: {}, orderBy: { publishedAt: 'desc' }, take: 1 });
    expect(ordered[0].id).toBe('n-3');
  });
});
