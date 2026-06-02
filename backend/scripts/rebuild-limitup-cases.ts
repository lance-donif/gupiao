import { HistoricalLimitUpCaseRebuilder } from '../src/services/limitup-evidence-initialization.js';
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
  const days = readNumberArg(args.days, 120);
  const traceId = args['trace-id'] ?? `limitup-rebuild-${clusterKey}-${asOf.toISOString().slice(0, 10)}`;
  const mode = args.mode === 'sealed-first' || args.mode === 'sealed' ? 'sealed' : 'touch';
  const prisma = createScriptPrismaClient();

  try {
    const result = await new HistoricalLimitUpCaseRebuilder().rebuild(prisma, {
      traceId,
      clusterKey,
      asOf,
      days,
      mode,
    });
    writeJson(result);
  }
  finally {
    await prisma.$disconnect();
  }
});
