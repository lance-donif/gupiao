import { RuleBasedAliasCandidateGenerator } from '../src/services/limitup-evidence-initialization.js';
import {
  createScriptPrismaClient,
  DEFAULT_CLUSTER_KEY,
  parseArgs,
  readDateArg,
  readNumberArg,
  runCli,
  writeJson,
} from './limitup-cli-utils.js';

runCli(async () => {
  const args = parseArgs();
  const clusterKey = args.cluster ?? DEFAULT_CLUSTER_KEY;
  const asOf = readDateArg(args['as-of'], new Date());
  const sourceTraceId = args.sourceTrace ?? args['source-trace'] ?? args.trace ?? args.traceId ?? args['trace-id'];
  if (!sourceTraceId) {
    throw new Error('Missing --source-trace');
  }
  const traceId = args['candidate-trace'] ?? `rule-alias-candidates-${clusterKey}-${asOf.toISOString().slice(0, 10)}`;
  const prisma = createScriptPrismaClient();

  try {
    const result = await new RuleBasedAliasCandidateGenerator().generate(prisma, {
      traceId,
      sourceTraceId,
      clusterKey,
      asOf,
      minConfidence: readNumberArg(args['min-confidence'], 0.7),
      max: readNumberArg(args.max, 5000),
      dryRun: args['dry-run'] === 'true',
    });
    writeJson(result);
  }
  finally {
    await prisma.$disconnect();
  }
});
