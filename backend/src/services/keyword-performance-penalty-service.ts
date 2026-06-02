import { Prisma } from '@prisma/client';

export interface IKeywordPerformancePenaltyRefreshInput {
  readonly asOf: Date;
  readonly clusterKey: string;
  readonly lookbackDays?: number;
  readonly cooldownDays?: number;
  readonly lossThresholdPct?: number;
  readonly penaltyFactor?: number;
}

export interface IKeywordPerformancePenaltyRefreshResult {
  readonly scannedRecommendations: number;
  readonly losingRecommendations: number;
  readonly candidateKeywordCount: number;
  readonly createdPenaltyCount: number;
  readonly lossThresholdPct: number;
  readonly penaltyFactor: number;
  readonly cooldownDays: number;
}

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_COOLDOWN_DAYS = 7;
const DEFAULT_LOSS_THRESHOLD_PCT = -0.03;
const DEFAULT_PENALTY_FACTOR = 0.6;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const toNumberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const minAvailableYield = (row: Record<string, unknown>): number | null => {
  const values = [row.yield1Day, row.yield3Day, row.yield5Day]
    .map(toNumberOrNull)
    .filter((value): value is number => value !== null);
  return values.length === 0 ? null : Math.min(...values);
};

const normalizeKeyword = (value: unknown): string => {
  return String(value ?? '').trim();
};

const uniqueKeywordsFromEvidence = (row: Record<string, unknown>): readonly string[] => {
  return [...new Set([
    normalizeKeyword(row.keyword),
    normalizeKeyword(row.matchedExposureKeyword),
    normalizeKeyword(row.sourceKeyword),
  ].filter(keyword => keyword.length > 0))];
};

export class KeywordPerformancePenaltyService {
  public async refresh(
    prisma: any,
    input: IKeywordPerformancePenaltyRefreshInput,
  ): Promise<IKeywordPerformancePenaltyRefreshResult> {
    const lookbackDays = input.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    const cooldownDays = input.cooldownDays ?? DEFAULT_COOLDOWN_DAYS;
    const lossThresholdPct = input.lossThresholdPct ?? DEFAULT_LOSS_THRESHOLD_PCT;
    const penaltyFactor = input.penaltyFactor ?? DEFAULT_PENALTY_FACTOR;

    if (!prisma.recommendationSnapshot?.findMany || !prisma.evidenceContribution?.findMany || !prisma.keywordPerformancePenalty?.createMany) {
      return {
        scannedRecommendations: 0,
        losingRecommendations: 0,
        candidateKeywordCount: 0,
        createdPenaltyCount: 0,
        lossThresholdPct,
        penaltyFactor,
        cooldownDays,
      };
    }

    const windowStart = new Date(input.asOf.getTime() - lookbackDays * ONE_DAY_MS);
    const recommendations = await prisma.recommendationSnapshot.findMany({
      where: {
        clusterKey: input.clusterKey,
        isReconciled: true,
        asOf: {
          gte: windowStart,
          lt: input.asOf,
        },
      },
      select: {
        traceId: true,
        asOf: true,
        symbol: true,
        yield1Day: true,
        yield3Day: true,
        yield5Day: true,
      },
    }) as Array<Record<string, unknown>>;

    const losingRecommendations = recommendations
      .map(row => ({
        row,
        lossPct: minAvailableYield(row),
      }))
      .filter((item): item is { row: Record<string, unknown>; lossPct: number } => {
        return item.lossPct !== null && item.lossPct <= lossThresholdPct;
      });

    if (losingRecommendations.length === 0) {
      return {
        scannedRecommendations: recommendations.length,
        losingRecommendations: 0,
        candidateKeywordCount: 0,
        createdPenaltyCount: 0,
        lossThresholdPct,
        penaltyFactor,
        cooldownDays,
      };
    }

    const losingPairs = losingRecommendations.map(item => ({
      traceId: String(item.row.traceId),
      symbol: String(item.row.symbol),
      lossPct: item.lossPct,
      triggerAsOf: item.row.asOf instanceof Date ? item.row.asOf : new Date(String(item.row.asOf)),
    }));
    const lossByPair = new Map(losingPairs.map(pair => [`${pair.traceId}\u0000${pair.symbol}`, pair]));
    const evidenceRows = await prisma.evidenceContribution.findMany({
      where: {
        clusterKey: input.clusterKey,
        OR: losingPairs.map(pair => ({
          traceId: pair.traceId,
          symbol: pair.symbol,
        })),
      },
      select: {
        traceId: true,
        symbol: true,
        keyword: true,
        matchedExposureKeyword: true,
        sourceKeyword: true,
      },
    }) as Array<Record<string, unknown>>;

    const penaltyByKey = new Map<string, Record<string, unknown>>();
    const validTo = new Date(input.asOf.getTime() + cooldownDays * ONE_DAY_MS);
    for (const evidence of evidenceRows) {
      const traceId = String(evidence.traceId);
      const symbol = String(evidence.symbol);
      const pair = lossByPair.get(`${traceId}\u0000${symbol}`);
      if (!pair) {
        continue;
      }
      for (const keyword of uniqueKeywordsFromEvidence(evidence)) {
        const key = `${input.clusterKey}\u0000${traceId}\u0000${symbol}\u0000${keyword}`;
        penaltyByKey.set(key, {
          clusterKey: input.clusterKey,
          keyword,
          factor: new Prisma.Decimal(penaltyFactor),
          lossPct: new Prisma.Decimal(pair.lossPct),
          thresholdPct: new Prisma.Decimal(lossThresholdPct),
          triggerTraceId: traceId,
          triggerSymbol: symbol,
          triggerAsOf: pair.triggerAsOf,
          validFrom: input.asOf,
          validTo,
          reason: `推荐股票 ${symbol} 对账最差收益 ${(pair.lossPct * 100).toFixed(2)}%，低于阈值 ${(lossThresholdPct * 100).toFixed(2)}%，关键词降权 ${cooldownDays} 天`,
        });
      }
    }

    const rows = [...penaltyByKey.values()];
    if (rows.length > 0) {
      const result = await prisma.keywordPerformancePenalty.createMany({
        data: rows,
        skipDuplicates: true,
      });
      return {
        scannedRecommendations: recommendations.length,
        losingRecommendations: losingRecommendations.length,
        candidateKeywordCount: rows.length,
        createdPenaltyCount: Number(result.count ?? rows.length),
        lossThresholdPct,
        penaltyFactor,
        cooldownDays,
      };
    }

    return {
      scannedRecommendations: recommendations.length,
      losingRecommendations: losingRecommendations.length,
      candidateKeywordCount: 0,
      createdPenaltyCount: 0,
      lossThresholdPct,
      penaltyFactor,
      cooldownDays,
    };
  }
}
