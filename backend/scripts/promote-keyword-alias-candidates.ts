import { KeywordAliasPromotionService } from '../src/services/limitup-evidence-initialization.js';
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
  const validFrom = readDateArg(args['valid-from'], new Date());
  const prisma = createScriptPrismaClient();

  try {
    const result = await new KeywordAliasPromotionService().promote(prisma, {
      clusterKey,
      status: args.status ?? 'candidate',
      validFrom,
      max: readNumberArg(args.max, 5000),
      dryRun: args['dry-run'] === 'true',
    });
    writeJson(result);
  }
  finally {
    await prisma.$disconnect();
  }
});
