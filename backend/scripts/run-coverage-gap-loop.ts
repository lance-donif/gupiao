import {
  CoverageGapLoopService,
  createExposureCandidateExtractorFromEnv,
} from '../src/services/limitup-evidence-initialization.js';
import { loadBackendEnv } from '../src/services/load-backend-env.js';
import {
  createScriptPrismaClient,
  DEFAULT_CLUSTER_KEY,
  parseArgs,
  readDateArg,
  readTradeDateArg,
  runCli,
  writeJson,
} from './limitup-cli-utils.js';

loadBackendEnv();

runCli(async () => {
  const args = parseArgs();
  const clusterKey = args.cluster ?? DEFAULT_CLUSTER_KEY;
  const tradeDate = readTradeDateArg(args['trade-date']);
  const asOf = readDateArg(args['as-of'], tradeDate);
  const traceId = args.trace ?? args.traceId ?? args['trace-id'] ?? `daily-${clusterKey}-${tradeDate.toISOString().slice(0, 10)}`;
  const dryRun = args['dry-run'] === 'true';
  const prisma = createScriptPrismaClient();

  try {
    const result = await new CoverageGapLoopService().run(prisma, {
      traceId,
      clusterKey,
      asOf,
      tradeDate,
      dryRun,
      extractor: dryRun ? undefined : createExposureCandidateExtractorFromEnv(),
      concurrency: readNumberArg(args.concurrency, 1),
      maxNewsPerCase: readNumberArg(args['max-news-per-case'], 120),
    });
    writeJson(result);
  }
  finally {
    await prisma.$disconnect();
  }
});
