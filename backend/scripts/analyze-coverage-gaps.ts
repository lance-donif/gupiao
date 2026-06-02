import { CoverageGapAnalyzer } from '../src/services/limitup-evidence-initialization.js';
import {
  createScriptPrismaClient,
  DEFAULT_CLUSTER_KEY,
  parseArgs,
  readDateArg,
  readTradeDateArg,
  runCli,
  writeJson,
} from './limitup-cli-utils.js';

runCli(async () => {
  const args = parseArgs();
  const traceId = args.trace ?? args.traceId ?? args['trace-id'];
  if (!traceId) {
    throw new Error('Missing --trace');
  }
  const clusterKey = args.cluster ?? DEFAULT_CLUSTER_KEY;
  const targetDate = readTradeDateArg(args['target-date']);
  const asOf = readDateArg(args['as-of'], targetDate);
  const prisma = createScriptPrismaClient();

  try {
    const result = await new CoverageGapAnalyzer().analyze(prisma, {
      traceId,
      clusterKey,
      asOf,
      targetDate,
      mode: args.mode === 'touch' ? 'touch' : 'sealed',
    });
    writeJson({
      ...result,
      targetDate: result.targetDate.toISOString(),
    });
  }
  finally {
    await prisma.$disconnect();
  }
});
