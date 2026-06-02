import {
  createExposureCandidateExtractorFromEnv,
  HistoricalExposureCandidateGenerator,
} from '../src/services/limitup-evidence-initialization.js';
import { loadBackendEnv } from '../src/services/load-backend-env.js';
import {
  createScriptPrismaClient,
  DEFAULT_CLUSTER_KEY,
  parseArgs,
  readDateArg,
  readNumberArg,
  runCli,
  writeJson,
} from './limitup-cli-utils.js';

loadBackendEnv();

runCli(async () => {
  const args = parseArgs();
  const clusterKey = args.cluster ?? DEFAULT_CLUSTER_KEY;
  const asOf = readDateArg(args['as-of'], new Date());
  const traceId = args.trace ?? args.traceId ?? args['trace-id'] ?? `historical-exposure-candidates-${clusterKey}-${asOf.toISOString().slice(0, 10)}`;
  const dryRun = args['dry-run'] === 'true';
  const prisma = createScriptPrismaClient();
  const extractor = dryRun
    ? {
        modelVersion: 'dry-run',
        promptVersion: 'dry-run',
        extract: async () => [],
      }
    : createExposureCandidateExtractorFromEnv();

  try {
    const result = await new HistoricalExposureCandidateGenerator(extractor).generate(prisma, {
      traceId,
      clusterKey,
      asOf,
      days: readNumberArg(args.days, 120),
      limitCases: readNumberArg(args['limit-cases'], 8072),
      concurrency: readNumberArg(args.concurrency, 1),
      maxNewsPerCase: readNumberArg(args['max-news-per-case'], 120),
      onProgress: args.progress === 'true'
        ? progress => console.error(JSON.stringify({ progress }))
        : undefined,
      source: args.source ?? 'sealed-limitup',
      dryRun,
    });
    writeJson(result);
  }
  finally {
    await prisma.$disconnect();
  }
});
