import { describe, expect, it } from 'vitest';
import {
  buildBeijingMinuteBucketKey,
  DataRefreshLedgerService,
} from '../../../src/services/data-refresh-ledger-service.js';

class MockLedgerPrismaClient {
  public readonly rows = new Map<string, any>();
  public queryCount = 0;
  public executeCount = 0;

  public async $queryRawUnsafe(_sql: string, dataKind: string, source: string, clusterKey: string, bucketKey: string, status: string, now: Date): Promise<any[]> {
    this.queryCount += 1;
    const row = this.rows.get(`${dataKind}:${source}:${clusterKey}:${bucketKey}`);
    if (!row || row.status !== status || row.expiresAt <= now) {
      return [];
    }
    return [row];
  }

  public async $executeRawUnsafe(
    _sql: string,
    _id: string,
    dataKind: string,
    source: string,
    clusterKey: string,
    bucketKey: string,
    status: string,
    fetchedAt: Date,
    expiresAt: Date,
    traceId: string | null,
    summaryJson: string,
    error: string | null,
  ): Promise<number> {
    this.executeCount += 1;
    this.rows.set(`${dataKind}:${source}:${clusterKey}:${bucketKey}`, {
      dataKind,
      source,
      clusterKey,
      bucketKey,
      status,
      fetchedAt,
      expiresAt,
      traceId,
      summary: JSON.parse(summaryJson),
      error,
    });
    return 1;
  }
}

describe('data refresh ledger service', () => {
  it('builds 15 minute Beijing buckets from UTC instants', () => {
    expect(buildBeijingMinuteBucketKey(new Date('2026-05-24T08:37:18.000Z'), 15))
      .toBe('2026-05-24T08:30:00.000Z/15m@UTC+8');
  });

  it('returns valid cached summaries without calling loader again', async () => {
    const prisma = new MockLedgerPrismaClient();
    const service = new DataRefreshLedgerService();
    const now = new Date('2026-05-24T08:30:00.000Z');
    const key = {
      dataKind: 'news_fetch',
      source: 'aktools',
      clusterKey: 'global',
      bucketKey: buildBeijingMinuteBucketKey(now, 15),
    };

    await service.recordSuccess(prisma, {
      ...key,
      fetchedAt: now,
      expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
      traceId: 'trace-a',
      summary: { articles: [{ title: 'cached' }] },
    });

    let loaderCalls = 0;
    const result = await service.withLedgerCache(prisma, {
      ...key,
      now: new Date(now.getTime() + 60 * 1000),
      ttlMs: 15 * 60 * 1000,
      traceId: 'trace-b',
      loader: async () => {
        loaderCalls += 1;
        return { articles: [{ title: 'fresh' }] };
      },
    });

    expect(result.cacheHit).toBe(true);
    expect(result.summary).toEqual({ articles: [{ title: 'cached' }] });
    expect(loaderCalls).toBe(0);
  });

  it('records failure and rethrows when the loader fails', async () => {
    const prisma = new MockLedgerPrismaClient();
    const service = new DataRefreshLedgerService();
    const now = new Date('2026-05-24T08:30:00.000Z');
    const key = {
      dataKind: 'news_fetch',
      source: 'newsnow',
      clusterKey: 'global',
      bucketKey: buildBeijingMinuteBucketKey(now, 15),
    };

    await expect(service.withLedgerCache(prisma, {
      ...key,
      now,
      ttlMs: 15 * 60 * 1000,
      traceId: 'trace-fail',
      loader: async () => {
        throw new Error('network unavailable');
      },
    })).rejects.toThrow('network unavailable');

    const stored = prisma.rows.get(`${key.dataKind}:${key.source}:${key.clusterKey}:${key.bucketKey}`);
    expect(stored).toEqual(expect.objectContaining({
      status: 'failed',
      error: 'network unavailable',
      traceId: 'trace-fail',
    }));
  });
});
