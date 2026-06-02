import { BacktestEngine } from '../src/services/backtest-engine.js';
import {
  createScriptPrismaClient,
  DEFAULT_CLUSTER_KEY,
  parseArgs,
  readDateArg,
  readNumberArg,
  runCli,
  writeJson,
} from './limitup-cli-utils.js';

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
  await prisma.graphSnapshot.create({
    data: {
      traceId: input.targetTraceId,
      asOf: input.asOf,
      clusterKey: source.clusterKey,
      nodesJson: source.nodesJson,
      edgesJson: source.edgesJson,
    },
  });
  return true;
};

runCli(async () => {
  const args = parseArgs();
  const sourceTraceId = args.sourceTrace ?? args['source-trace'] ?? args.trace ?? args.traceId ?? args['trace-id'];
  if (!sourceTraceId) {
    throw new Error('Missing --source-trace');
  }
  const clusterKey = args.cluster ?? DEFAULT_CLUSTER_KEY;
  const asOf = readDateArg(args['as-of'], new Date());
  const targetTraceId = args['target-trace'] ?? `current-facts-replay-${clusterKey}-${asOf.toISOString().slice(0, 10)}`;
  const prisma = createScriptPrismaClient();

  try {
    const copiedSignalCount = await copyCausalSignals(prisma, {
      sourceTraceId,
      targetTraceId,
      asOf,
    });
    const copiedGraph = await copyGraphSnapshot(prisma, {
      sourceTraceId,
      targetTraceId,
      asOf,
    });
    const result = await new BacktestEngine().runBacktest(prisma, {
      traceId: targetTraceId,
      asOf,
      clusterKey,
      recommendationLimit: readNumberArg(args.limit, 30),
      maxPerIndustry: readNumberArg(args['max-per-industry'], 5),
      scoringProfile: 'short_news',
    });
    writeJson({
      sourceTraceId,
      targetTraceId,
      copiedSignalCount,
      copiedGraph,
      ...result,
      asOf: result.asOf.toISOString(),
    });
  }
  finally {
    await prisma.$disconnect();
  }
});
