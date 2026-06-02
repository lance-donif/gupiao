import crypto from 'node:crypto';

export type DataRefreshLedgerStatus = 'success' | 'failed' | 'running';

export interface IDataRefreshLedgerKey {
  readonly dataKind: string;
  readonly source: string;
  readonly clusterKey: string;
  readonly bucketKey: string;
}

export interface IDataRefreshLedgerRecord<TSummary = unknown> extends IDataRefreshLedgerKey {
  readonly status: DataRefreshLedgerStatus | string;
  readonly fetchedAt: Date;
  readonly expiresAt: Date;
  readonly traceId: string | null;
  readonly summary: TSummary;
  readonly error: string | null;
}

export interface IRecordLedgerSuccessInput<TSummary> extends IDataRefreshLedgerKey {
  readonly fetchedAt: Date;
  readonly expiresAt: Date;
  readonly traceId?: string | null;
  readonly summary: TSummary;
}

export interface IRecordLedgerFailureInput<TSummary = Record<string, never>> extends IDataRefreshLedgerKey {
  readonly fetchedAt: Date;
  readonly expiresAt: Date;
  readonly traceId?: string | null;
  readonly summary?: TSummary;
  readonly error: string;
}

export interface ILedgerCacheInput<TSummary> extends IDataRefreshLedgerKey {
  readonly now: Date;
  readonly ttlMs: number;
  readonly traceId?: string | null;
  readonly loader: () => Promise<TSummary>;
}

const coerceDate = (value: unknown): Date => value instanceof Date ? value : new Date(String(value));

const coerceSummary = <TSummary>(value: unknown): TSummary => {
  if (typeof value === 'string') {
    return JSON.parse(value) as TSummary;
  }
  return value as TSummary;
};

const createLedgerId = (key: IDataRefreshLedgerKey): string => {
  const digest = crypto
    .createHash('sha1')
    .update(`${key.dataKind}:${key.source}:${key.clusterKey}:${key.bucketKey}`)
    .digest('hex');
  return `drl_${digest}`;
};

export const buildBeijingMinuteBucketKey = (time: Date, bucketMinutes: number): string => {
  if (!Number.isFinite(bucketMinutes) || bucketMinutes <= 0) {
    throw new Error(`Invalid bucketMinutes: ${bucketMinutes}`);
  }
  const bucketMs = bucketMinutes * 60 * 1000;
  const beijingOffsetMs = 8 * 60 * 60 * 1000;
  const beijingMs = time.getTime() + beijingOffsetMs;
  const bucketedBeijingMs = Math.floor(beijingMs / bucketMs) * bucketMs;
  const bucketStartUtc = new Date(bucketedBeijingMs - beijingOffsetMs);
  return `${bucketStartUtc.toISOString()}/${bucketMinutes}m@UTC+8`;
};

export class DataRefreshLedgerService {
  public async getValid<TSummary>(
    prisma: any,
    key: IDataRefreshLedgerKey,
    now: Date,
  ): Promise<IDataRefreshLedgerRecord<TSummary> | null> {
    const rows = await prisma.$queryRawUnsafe(
      [
        'SELECT "dataKind", "source", "clusterKey", "bucketKey", status, "fetchedAt", "expiresAt", "traceId", summary, error',
        'FROM "DataRefreshLedger"',
        'WHERE "dataKind" = $1 AND source = $2 AND "clusterKey" = $3 AND "bucketKey" = $4',
        '  AND status = $5 AND "expiresAt" > $6',
        'LIMIT 1',
      ].join(' '),
      key.dataKind,
      key.source,
      key.clusterKey,
      key.bucketKey,
      'success',
      now,
    ) as readonly Record<string, unknown>[];

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      dataKind: String(row.dataKind),
      source: String(row.source),
      clusterKey: String(row.clusterKey),
      bucketKey: String(row.bucketKey),
      status: String(row.status),
      fetchedAt: coerceDate(row.fetchedAt),
      expiresAt: coerceDate(row.expiresAt),
      traceId: row.traceId === null || row.traceId === undefined ? null : String(row.traceId),
      summary: coerceSummary<TSummary>(row.summary),
      error: row.error === null || row.error === undefined ? null : String(row.error),
    };
  }

  public async recordSuccess<TSummary>(
    prisma: any,
    input: IRecordLedgerSuccessInput<TSummary>,
  ): Promise<void> {
    await this.upsert(prisma, {
      ...input,
      status: 'success',
      summary: input.summary,
      error: null,
    });
  }

  public async recordFailure<TSummary>(
    prisma: any,
    input: IRecordLedgerFailureInput<TSummary>,
  ): Promise<void> {
    await this.upsert(prisma, {
      ...input,
      status: 'failed',
      summary: input.summary ?? {},
      error: input.error,
    });
  }

  public async withLedgerCache<TSummary>(
    prisma: any,
    input: ILedgerCacheInput<TSummary>,
  ): Promise<{ readonly summary: TSummary; readonly cacheHit: boolean }> {
    const cached = await this.getValid<TSummary>(prisma, input, input.now);
    if (cached) {
      return { summary: cached.summary, cacheHit: true };
    }

    try {
      const summary = await input.loader();
      await this.recordSuccess(prisma, {
        dataKind: input.dataKind,
        source: input.source,
        clusterKey: input.clusterKey,
        bucketKey: input.bucketKey,
        fetchedAt: input.now,
        expiresAt: new Date(input.now.getTime() + input.ttlMs),
        traceId: input.traceId ?? null,
        summary,
      });
      return { summary, cacheHit: false };
    }
    catch (error) {
      await this.recordFailure(prisma, {
        dataKind: input.dataKind,
        source: input.source,
        clusterKey: input.clusterKey,
        bucketKey: input.bucketKey,
        fetchedAt: input.now,
        expiresAt: input.now,
        traceId: input.traceId ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async upsert<TSummary>(
    prisma: any,
    input: IRecordLedgerSuccessInput<TSummary> & {
      readonly status: DataRefreshLedgerStatus;
      readonly error: string | null;
    },
  ): Promise<void> {
    await prisma.$executeRawUnsafe(
      [
        'INSERT INTO "DataRefreshLedger"',
        '("id", "dataKind", "source", "clusterKey", "bucketKey", status, "fetchedAt", "expiresAt", "traceId", summary, error, "updatedAt")',
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, CURRENT_TIMESTAMP)',
        'ON CONFLICT ("dataKind", "source", "clusterKey", "bucketKey") DO UPDATE SET',
        'status = EXCLUDED.status,',
        '"fetchedAt" = EXCLUDED."fetchedAt",',
        '"expiresAt" = EXCLUDED."expiresAt",',
        '"traceId" = EXCLUDED."traceId",',
        'summary = EXCLUDED.summary,',
        'error = EXCLUDED.error,',
        '"updatedAt" = CURRENT_TIMESTAMP',
      ].join(' '),
      createLedgerId(input),
      input.dataKind,
      input.source,
      input.clusterKey,
      input.bucketKey,
      input.status,
      input.fetchedAt,
      input.expiresAt,
      input.traceId ?? null,
      JSON.stringify(input.summary),
      input.error,
    );
  }
}
