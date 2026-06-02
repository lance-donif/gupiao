import { BacktestEngine } from '../src/services/backtest-engine.js';
import {
  createScriptPrismaClient,
  DEFAULT_CLUSTER_KEY,
  parseArgs,
  readDateArg,
  readNumberArg,
  readTradeDateArg,
  runCli,
  writeJson,
} from './limitup-cli-utils.js';

const ROLLBACK_SIGNAL = 'temporary-alias-visibility-rollback';

const startOfUtcDate = (value: Date): Date => {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
};

const nextUtcDate = (value: Date): Date => {
  const next = startOfUtcDate(value);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
};

const copyCausalSignals = async (
  prisma: any,
  input: {
    readonly sourceTraceId: string;
    readonly targetTraceId: string;
    readonly asOf: Date;
  },
): Promise<number> => {
  const rows = await prisma.causalSignalCandidate.findMany({
    where: { traceId: input.sourceTraceId },
  });
  if (rows.length === 0) {
    return 0;
  }
  await prisma.causalSignalCandidate.createMany({
    data: rows.map((row: any) => ({
      traceId: input.targetTraceId,
      asOf: input.asOf,
      clusterKey: row.clusterKey,
      newsId: row.newsId,
      event: row.event,
      businessVariable: row.businessVariable,
      assetOrThemeKeyword: row.assetOrThemeKeyword,
      direction: row.direction,
      confidence: row.confidence,
      evidenceText: row.evidenceText,
      evidenceOffsetStart: row.evidenceOffsetStart,
      evidenceOffsetEnd: row.evidenceOffsetEnd,
      extractorType: row.extractorType,
      modelVersion: row.modelVersion,
      promptVersion: row.promptVersion,
      status: row.status,
      failureReason: row.failureReason,
    })),
    skipDuplicates: true,
  });
  return rows.length;
};

const copyGraphSnapshot = async (
  prisma: any,
  input: {
    readonly sourceTraceId: string;
    readonly targetTraceId: string;
    readonly asOf: Date;
  },
): Promise<boolean> => {
  const source = await prisma.graphSnapshot.findUnique({
    where: { traceId: input.sourceTraceId },
  });
  if (!source) {
    return false;
  }
  await prisma.graphSnapshot.upsert({
    where: { traceId: input.targetTraceId },
    create: {
      traceId: input.targetTraceId,
      asOf: input.asOf,
      clusterKey: source.clusterKey,
      nodesJson: source.nodesJson,
      edgesJson: source.edgesJson,
    },
    update: {
      asOf: input.asOf,
      clusterKey: source.clusterKey,
      nodesJson: source.nodesJson,
      edgesJson: source.edgesJson,
    },
  });
  return true;
};

const averageNullable = (values: readonly unknown[]): number | null => {
  const numbers = values.map(Number).filter(Number.isFinite);
  if (numbers.length === 0) {
    return null;
  }
  return Number((numbers.reduce((sum, value) => sum + value, 0) / numbers.length).toFixed(6));
};

runCli(async () => {
  const args = parseArgs();
  const sourceTraceId = args.sourceTrace ?? args['source-trace'] ?? args.trace ?? args.traceId ?? args['trace-id'];
  if (!sourceTraceId) {
    throw new Error('Missing --source-trace');
  }

  const clusterKey = args.cluster ?? DEFAULT_CLUSTER_KEY;
  const asOf = readDateArg(args['as-of'], new Date());
  const targetDate = args['target-date'] ? readTradeDateArg(args['target-date']) : nextUtcDate(asOf);
  const targetTraceId = args['target-trace'] ?? `temporary-alias-replay-${clusterKey}-${asOf.toISOString().slice(0, 10)}`;
  const aliasSource = args['alias-source'] ?? 'rule_based_news_signal';
  const prisma = createScriptPrismaClient();
  let summary: Record<string, unknown> | null = null;

  try {
    await prisma.$transaction(async (tx: any) => {
      const visibleAliases = await tx.keywordAlias.findMany({
        where: {
          clusterKey,
          source: aliasSource,
          status: 'active',
        },
        select: { id: true },
      });
      const aliasIds = visibleAliases.map((row: { id: string }) => row.id);
      if (aliasIds.length > 0) {
        await tx.keywordAlias.updateMany({
          where: { id: { in: aliasIds } },
          data: { validFrom: asOf },
        });
      }

      const copiedSignalCount = await copyCausalSignals(tx, {
        sourceTraceId,
        targetTraceId,
        asOf,
      });
      const copiedGraph = await copyGraphSnapshot(tx, {
        sourceTraceId,
        targetTraceId,
        asOf,
      });
      const result = await new BacktestEngine().runBacktest(tx, {
        traceId: targetTraceId,
        asOf,
        clusterKey,
        recommendationLimit: readNumberArg(args.limit, 30),
        maxPerIndustry: readNumberArg(args['max-per-industry'], 5),
        scoringProfile: 'short_news',
      });

      const [recommendations, limitUpCases, aliasContributionMethods] = await Promise.all([
        tx.recommendationSnapshot.findMany({
          where: { traceId: targetTraceId },
          orderBy: { rank: 'asc' },
          select: {
            rank: true,
            symbol: true,
            stockName: true,
            industry: true,
            finalScore: true,
            yield1Day: true,
            yield3Day: true,
            yield5Day: true,
          },
        }),
        tx.historicalLimitUpCase.findMany({
          where: {
            clusterKey,
            tradeDate: {
              gte: startOfUtcDate(targetDate),
              lt: nextUtcDate(targetDate),
            },
            sealedLimit: true,
          },
          select: { symbol: true, stockName: true },
        }),
        tx.evidenceContribution.groupBy({
          by: ['matchMethod', 'matchedExposureKeyword'],
          where: {
            traceId: targetTraceId,
            matchMethod: 'rule_news_alias',
          },
          _count: true,
          _sum: { finalContribScore: true },
        }),
      ]);

      const limitUpSymbols = new Set(limitUpCases.map((row: { symbol: string }) => row.symbol));
      const limitUpHits = recommendations.filter((row: { symbol: string }) => limitUpSymbols.has(row.symbol));

      summary = {
        sourceTraceId,
        targetTraceId,
        clusterKey,
        asOf: asOf.toISOString(),
        targetDate: targetDate.toISOString(),
        copiedSignalCount,
        copiedGraph,
        temporarilyVisibleAliasCount: aliasIds.length,
        recommendationsCreated: result.recommendationsCreated,
        reconciledCount: result.reconciledCount,
        recommendationCount: recommendations.length,
        limitUpCaseCount: limitUpCases.length,
        limitUpHitCount: limitUpHits.length,
        averageYield1Day: averageNullable(recommendations.map((row: { yield1Day: unknown }) => row.yield1Day)),
        averageYield3Day: averageNullable(recommendations.map((row: { yield3Day: unknown }) => row.yield3Day)),
        averageYield5Day: averageNullable(recommendations.map((row: { yield5Day: unknown }) => row.yield5Day)),
        aliasContributionMethods,
        limitUpHits,
        topRecommendations: recommendations.slice(0, 30),
      };

      throw new Error(ROLLBACK_SIGNAL);
    });
  }
  catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK_SIGNAL) {
      throw error;
    }
  }
  finally {
    await prisma.$disconnect();
  }

  writeJson({
    rolledBack: true,
    rollbackReason: 'temporary alias visibility is only for retrospective what-if replay',
    ...summary,
  });
});
