import crypto from 'node:crypto';

export interface IHistoricalLimitUpCaseRecord {
  readonly traceId: string;
  readonly clusterKey: string;
  readonly symbol: string;
  readonly stockName: string;
  readonly tradeDate: Date;
  readonly touchLimit: boolean;
  readonly sealedLimit: boolean;
  readonly prevClose: unknown;
  readonly high: unknown;
  readonly close: unknown;
  readonly boardType: string;
  readonly limitThresholdPct: unknown;
  readonly diagnosticsJson: unknown;
}

export interface ICoverageGapCaseRecord {
  readonly traceId: string;
  readonly clusterKey: string;
  readonly asOf: Date;
  readonly symbol: string;
  readonly stockName: string;
  readonly tradeDate: Date;
  readonly historicalCaseId?: string | null;
  readonly gapStage: string;
  readonly missReason: string;
  readonly selectedRank?: number | null;
  readonly scoreAtAsOf?: unknown;
  readonly diagnosticsJson: unknown;
  readonly status?: string;
}

export interface IKeywordAliasRecord {
  readonly traceId?: string | null;
  readonly clusterKey: string;
  readonly sourceKeyword: string;
  readonly canonicalKeyword: string;
  readonly relationType: string;
  readonly confidence: unknown;
  readonly source: string;
  readonly sourceId: string;
  readonly evidenceText: string;
  readonly validFrom: Date;
  readonly validTo?: Date | null;
  readonly status?: string;
  readonly failureReason?: string | null;
}

export interface IFactSnapshotRecord {
  readonly traceId: string;
  readonly clusterKey: string;
  readonly asOf: Date;
  readonly factHash: string;
  readonly activeExposureCount: number;
  readonly activeAliasCount: number;
  readonly sourceSummaryJson: unknown;
}

const hasDelegate = (prisma: any, delegate: string, method: string): boolean => {
  return typeof prisma?.[delegate]?.[method] === 'function';
};

const hasRaw = (prisma: any, method: '$queryRawUnsafe' | '$executeRawUnsafe'): boolean => {
  return typeof prisma?.[method] === 'function';
};

const stableId = (prefix: string, parts: readonly unknown[]): string => {
  const digest = crypto
    .createHash('sha1')
    .update(parts.map(part => String(part)).join('|'))
    .digest('hex')
    .slice(0, 24);
  return `${prefix}_${digest}`;
};

const serializeDate = (value: Date): string => value.toISOString();

const serializeDecimal = (value: unknown): string => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : '0';
};

const normalizeRows = <T>(rows: readonly T[]): readonly T[] => rows;

const startOfUtcDate = (value: Date): Date => {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
};

const nextUtcDate = (value: Date): Date => {
  const next = startOfUtcDate(value);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
};

export class CoverageInitializationRepository {
  public constructor(private readonly prisma: any) {}

  public async writeHistoricalLimitUpCases(rows: readonly IHistoricalLimitUpCaseRecord[]): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }

    if (hasRaw(this.prisma, '$executeRawUnsafe')) {
      await this.prisma.$executeRawUnsafe(
        [
          'INSERT INTO "HistoricalLimitUpCase" (',
          '  id, "traceId", "clusterKey", symbol, "stockName", "tradeDate", "touchLimit", "sealedLimit",',
          '  "prevClose", high, close, "boardType", "limitThresholdPct", "diagnosticsJson"',
          ')',
          'SELECT',
          '  row.id, row."traceId", row."clusterKey", row.symbol, row."stockName", row."tradeDate"::timestamp(3),',
          '  row."touchLimit", row."sealedLimit", row."prevClose"::decimal(18,4), row.high::decimal(18,4),',
          '  row.close::decimal(18,4), row."boardType", row."limitThresholdPct"::decimal(5,4), row."diagnosticsJson"',
          'FROM jsonb_to_recordset($1::jsonb) AS row(',
          '  id text, "traceId" text, "clusterKey" text, symbol text, "stockName" text, "tradeDate" text,',
          '  "touchLimit" boolean, "sealedLimit" boolean, "prevClose" text, high text, close text,',
          '  "boardType" text, "limitThresholdPct" text, "diagnosticsJson" jsonb',
          ')',
          'ON CONFLICT ("traceId", symbol, "tradeDate") DO NOTHING',
        ].join(' '),
        JSON.stringify(rows.map(row => ({
          id: stableId('hluc', [row.traceId, row.symbol, serializeDate(row.tradeDate)]),
          traceId: row.traceId,
          clusterKey: row.clusterKey,
          symbol: row.symbol,
          stockName: row.stockName,
          tradeDate: serializeDate(row.tradeDate),
          touchLimit: row.touchLimit,
          sealedLimit: row.sealedLimit,
          prevClose: serializeDecimal(row.prevClose),
          high: serializeDecimal(row.high),
          close: serializeDecimal(row.close),
          boardType: row.boardType,
          limitThresholdPct: serializeDecimal(row.limitThresholdPct),
          diagnosticsJson: row.diagnosticsJson,
        }))),
      );
      return rows.length;
    }

    if (!hasDelegate(this.prisma, 'historicalLimitUpCase', 'createMany')) {
      return 0;
    }

    const result = await this.prisma.historicalLimitUpCase.createMany({
      data: rows.map(row => ({
        ...row,
      })),
      skipDuplicates: true,
    });

    return Number(result?.count ?? rows.length);
  }

  public async listHistoricalLimitUpCasesByTradeDate(
    clusterKey: string,
    tradeDate: Date,
    sealedOnly = false,
  ): Promise<readonly Record<string, unknown>[]> {
    const dayStart = startOfUtcDate(tradeDate);
    const dayEnd = nextUtcDate(tradeDate);
    if (hasRaw(this.prisma, '$queryRawUnsafe')) {
      return normalizeRows(await this.prisma.$queryRawUnsafe(
        [
          'SELECT * FROM "HistoricalLimitUpCase"',
          'WHERE "clusterKey" = $1 AND "tradeDate" >= $2 AND "tradeDate" < $3',
          sealedOnly ? 'AND "sealedLimit" = true' : '',
          'ORDER BY symbol ASC',
        ].join(' '),
        clusterKey,
        dayStart,
        dayEnd,
      ));
    }

    if (!hasDelegate(this.prisma, 'historicalLimitUpCase', 'findMany')) {
      return [];
    }

    const where: Record<string, unknown> = {
      clusterKey,
      tradeDate: {
        gte: dayStart,
        lt: dayEnd,
      },
    };
    if (sealedOnly) {
      where.sealedLimit = true;
    }

    return normalizeRows(await this.prisma.historicalLimitUpCase.findMany({
      where,
    }));
  }

  public async writeCoverageGapCases(rows: readonly ICoverageGapCaseRecord[]): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }

    if (hasRaw(this.prisma, '$executeRawUnsafe')) {
      await this.prisma.$executeRawUnsafe(
        [
          'INSERT INTO "CoverageGapCase" (',
          '  id, "traceId", "clusterKey", "asOf", symbol, "stockName", "tradeDate", "historicalCaseId",',
          '  "gapStage", "missReason", "selectedRank", "scoreAtAsOf", "diagnosticsJson", status',
          ')',
          'SELECT',
          '  row.id, row."traceId", row."clusterKey", row."asOf"::timestamp(3), row.symbol, row."stockName",',
          '  row."tradeDate"::timestamp(3), row."historicalCaseId", row."gapStage", row."missReason",',
          '  row."selectedRank", row."scoreAtAsOf"::decimal(10,4), row."diagnosticsJson", row.status',
          'FROM jsonb_to_recordset($1::jsonb) AS row(',
          '  id text, "traceId" text, "clusterKey" text, "asOf" text, symbol text, "stockName" text,',
          '  "tradeDate" text, "historicalCaseId" text, "gapStage" text, "missReason" text,',
          '  "selectedRank" integer, "scoreAtAsOf" text, "diagnosticsJson" jsonb, status text',
          ')',
          'ON CONFLICT ("traceId", symbol, "tradeDate", "gapStage", "missReason") DO NOTHING',
        ].join(' '),
        JSON.stringify(rows.map(row => ({
          id: stableId('cgc', [row.traceId, row.symbol, serializeDate(row.tradeDate), row.gapStage, row.missReason]),
          traceId: row.traceId,
          clusterKey: row.clusterKey,
          asOf: serializeDate(row.asOf),
          symbol: row.symbol,
          stockName: row.stockName,
          tradeDate: serializeDate(row.tradeDate),
          historicalCaseId: row.historicalCaseId ?? null,
          gapStage: row.gapStage,
          missReason: row.missReason,
          selectedRank: row.selectedRank ?? null,
          scoreAtAsOf: row.scoreAtAsOf === null || row.scoreAtAsOf === undefined ? null : serializeDecimal(row.scoreAtAsOf),
          diagnosticsJson: row.diagnosticsJson,
          status: row.status ?? 'open',
        }))),
      );
      return rows.length;
    }

    if (!hasDelegate(this.prisma, 'coverageGapCase', 'createMany')) {
      return 0;
    }

    const result = await this.prisma.coverageGapCase.createMany({
      data: rows.map(row => ({
        ...row,
        status: row.status ?? 'open',
      })),
      skipDuplicates: true,
    });

    return Number(result?.count ?? rows.length);
  }

  public async listCoverageGapCasesByTrace(traceId: string): Promise<readonly Record<string, unknown>[]> {
    if (hasRaw(this.prisma, '$queryRawUnsafe')) {
      return normalizeRows(await this.prisma.$queryRawUnsafe(
        'SELECT * FROM "CoverageGapCase" WHERE "traceId" = $1 ORDER BY "tradeDate" ASC, symbol ASC',
        traceId,
      ));
    }

    if (!hasDelegate(this.prisma, 'coverageGapCase', 'findMany')) {
      return [];
    }

    return normalizeRows(await this.prisma.coverageGapCase.findMany({
      where: { traceId },
    }));
  }

  public async writeKeywordAliases(rows: readonly IKeywordAliasRecord[]): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }

    if (hasRaw(this.prisma, '$executeRawUnsafe')) {
      await this.prisma.$executeRawUnsafe(
        [
          'INSERT INTO "KeywordAlias" (',
          '  id, "traceId", "clusterKey", "sourceKeyword", "canonicalKeyword", "relationType", confidence,',
          '  source, "sourceId", "evidenceText", "validFrom", "validTo", status, "failureReason"',
          ')',
          'SELECT',
          '  row.id, row."traceId", row."clusterKey", row."sourceKeyword", row."canonicalKeyword", row."relationType",',
          '  row.confidence::decimal(5,4), row.source, row."sourceId", row."evidenceText",',
          '  row."validFrom"::timestamp(3), row."validTo"::timestamp(3), row.status, row."failureReason"',
          'FROM jsonb_to_recordset($1::jsonb) AS row(',
          '  id text, "traceId" text, "clusterKey" text, "sourceKeyword" text, "canonicalKeyword" text,',
          '  "relationType" text, confidence text, source text, "sourceId" text, "evidenceText" text,',
          '  "validFrom" text, "validTo" text, status text, "failureReason" text',
          ')',
          'ON CONFLICT ("clusterKey", "sourceKeyword", "canonicalKeyword", "relationType", source, "sourceId") DO UPDATE SET',
          '  confidence = GREATEST("KeywordAlias".confidence, EXCLUDED.confidence),',
          '  "evidenceText" = EXCLUDED."evidenceText",',
          '  "validFrom" = LEAST("KeywordAlias"."validFrom", EXCLUDED."validFrom"),',
          '  "validTo" = EXCLUDED."validTo",',
          '  status = EXCLUDED.status,',
          '  "failureReason" = EXCLUDED."failureReason",',
          '  "updatedAt" = CURRENT_TIMESTAMP',
        ].join(' '),
        JSON.stringify(rows.map(row => ({
          id: stableId('ka', [row.clusterKey, row.sourceKeyword, row.canonicalKeyword, row.relationType, row.source, row.sourceId]),
          traceId: row.traceId ?? null,
          clusterKey: row.clusterKey,
          sourceKeyword: row.sourceKeyword,
          canonicalKeyword: row.canonicalKeyword,
          relationType: row.relationType,
          confidence: serializeDecimal(row.confidence),
          source: row.source,
          sourceId: row.sourceId,
          evidenceText: row.evidenceText,
          validFrom: serializeDate(row.validFrom),
          validTo: row.validTo ? serializeDate(row.validTo) : null,
          status: row.status ?? 'candidate',
          failureReason: row.failureReason ?? null,
        }))),
      );
      return rows.length;
    }

    if (!hasDelegate(this.prisma, 'keywordAlias', 'createMany')) {
      return 0;
    }

    const result = await this.prisma.keywordAlias.createMany({
      data: rows.map(row => ({
        ...row,
        status: row.status ?? 'candidate',
      })),
      skipDuplicates: true,
    });

    return Number(result?.count ?? rows.length);
  }

  public async listActiveKeywordAliases(clusterKey: string, asOf: Date): Promise<readonly Record<string, unknown>[]> {
    if (hasRaw(this.prisma, '$queryRawUnsafe')) {
      return normalizeRows(await this.prisma.$queryRawUnsafe(
        [
          'SELECT * FROM "KeywordAlias"',
          'WHERE "clusterKey" = $1 AND status = $2 AND "validFrom" <= $3',
          '  AND ("validTo" IS NULL OR "validTo" >= $3)',
          'ORDER BY confidence DESC, "sourceKeyword" ASC',
        ].join(' '),
        clusterKey,
        'active',
        asOf,
      ));
    }

    if (!hasDelegate(this.prisma, 'keywordAlias', 'findMany')) {
      return [];
    }

    return normalizeRows(await this.prisma.keywordAlias.findMany({
      where: {
        clusterKey,
        status: 'active',
        validFrom: { lte: asOf },
        OR: [
          { validTo: null },
          { validTo: { gte: asOf } },
        ],
      },
    }));
  }

  public async upsertFactSnapshot(row: IFactSnapshotRecord): Promise<void> {
    if (hasDelegate(this.prisma, 'factSnapshot', 'upsert')) {
      await this.prisma.factSnapshot.upsert({
        where: { traceId: row.traceId },
        create: row,
        update: {
          clusterKey: row.clusterKey,
          asOf: row.asOf,
          factHash: row.factHash,
          activeExposureCount: row.activeExposureCount,
          activeAliasCount: row.activeAliasCount,
          sourceSummaryJson: row.sourceSummaryJson,
        },
      });
      return;
    }

    if (hasRaw(this.prisma, '$executeRawUnsafe')) {
      await this.prisma.$executeRawUnsafe(
        [
          'INSERT INTO "FactSnapshot" (',
          '  id, "traceId", "clusterKey", "asOf", "factHash", "activeExposureCount", "activeAliasCount", "sourceSummaryJson"',
          ') VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)',
          'ON CONFLICT ("traceId") DO UPDATE SET',
          '  "clusterKey" = EXCLUDED."clusterKey",',
          '  "asOf" = EXCLUDED."asOf",',
          '  "factHash" = EXCLUDED."factHash",',
          '  "activeExposureCount" = EXCLUDED."activeExposureCount",',
          '  "activeAliasCount" = EXCLUDED."activeAliasCount",',
          '  "sourceSummaryJson" = EXCLUDED."sourceSummaryJson"',
        ].join(' '),
        stableId('fs', [row.traceId]),
        row.traceId,
        row.clusterKey,
        row.asOf,
        row.factHash,
        row.activeExposureCount,
        row.activeAliasCount,
        JSON.stringify(row.sourceSummaryJson),
      );
      return;
    }

    if (hasDelegate(this.prisma, 'factSnapshot', 'createMany')) {
      await this.prisma.factSnapshot.createMany({
        data: [row],
        skipDuplicates: true,
      });
    }
  }

  public async findFactSnapshot(traceId: string): Promise<Record<string, unknown> | null> {
    if (hasRaw(this.prisma, '$queryRawUnsafe')) {
      const rows = await this.prisma.$queryRawUnsafe(
        'SELECT * FROM "FactSnapshot" WHERE "traceId" = $1 LIMIT 1',
        traceId,
      ) as readonly Record<string, unknown>[];
      return rows[0] ?? null;
    }

    if (!hasDelegate(this.prisma, 'factSnapshot', 'findUnique')) {
      return null;
    }

    return await this.prisma.factSnapshot.findUnique({
      where: { traceId },
    });
  }

  public async listActiveExposureFacts(clusterKey: string, asOf: Date): Promise<readonly Record<string, unknown>[]> {
    if (!hasDelegate(this.prisma, 'stockExposureFact', 'findMany')) {
      return [];
    }

    return normalizeRows(await this.prisma.stockExposureFact.findMany({
      where: {
        clusterKey,
        status: 'active',
        validFrom: { lte: asOf },
        OR: [
          { validTo: null },
          { validTo: { gte: asOf } },
        ],
      },
    }));
  }

  public async listStockFeaturesByTrace(traceId: string): Promise<readonly Record<string, unknown>[]> {
    if (!hasDelegate(this.prisma, 'stockFeatureSnapshot', 'findMany')) {
      return [];
    }

    return normalizeRows(await this.prisma.stockFeatureSnapshot.findMany({
      where: { traceId },
    }));
  }

  public async listEvidenceContributionsByTrace(traceId: string): Promise<readonly Record<string, unknown>[]> {
    if (!hasDelegate(this.prisma, 'evidenceContribution', 'findMany')) {
      return [];
    }

    return normalizeRows(await this.prisma.evidenceContribution.findMany({
      where: { traceId },
    }));
  }

  public async listRecommendationSnapshotsByTrace(traceId: string): Promise<readonly Record<string, unknown>[]> {
    if (!hasDelegate(this.prisma, 'recommendationSnapshot', 'findMany')) {
      return [];
    }

    return normalizeRows(await this.prisma.recommendationSnapshot.findMany({
      where: { traceId },
      orderBy: { rank: 'asc' },
    }));
  }

  public async listStocksByCluster(clusterKey: string): Promise<readonly Record<string, unknown>[]> {
    if (!hasDelegate(this.prisma, 'stock', 'findMany')) {
      return [];
    }

    return normalizeRows(await this.prisma.stock.findMany({
      where: { clusterKey },
    }));
  }

  public async listCandleRows(input: {
    readonly stockIds: readonly string[];
    readonly asOf: Date;
  }): Promise<readonly Record<string, unknown>[]> {
    if (!hasDelegate(this.prisma, 'candle', 'findMany')) {
      return [];
    }

    return normalizeRows(await this.prisma.candle.findMany({
      where: {
        stockId: { in: [...input.stockIds] },
        tradingDay: { lte: input.asOf },
      },
      orderBy: [
        { stockId: 'asc' },
        { tradingDay: 'asc' },
      ],
    }));
  }

  public async listNewsByWindow(input: {
    readonly clusterKey: string;
    readonly windowStart: Date;
    readonly windowEnd: Date;
  }): Promise<readonly Record<string, unknown>[]> {
    if (!hasDelegate(this.prisma, 'normalizedNewsRecord', 'findMany')) {
      return [];
    }

    return normalizeRows(await this.prisma.normalizedNewsRecord.findMany({
      where: {
        clusterKey: input.clusterKey,
        publishedAt: {
          gte: input.windowStart,
          lte: input.windowEnd,
        },
      },
      orderBy: [
        { publishedAt: 'asc' },
        { id: 'asc' },
      ],
    }));
  }
}
