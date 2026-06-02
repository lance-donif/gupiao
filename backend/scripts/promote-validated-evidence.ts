import { EvidencePromotionService } from '../src/services/limitup-evidence-initialization.js';
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
  const validFrom = readDateArg(args['valid-from'], new Date());
  const prisma = createScriptPrismaClient();

  try {
    const result = await new EvidencePromotionService().promote(prisma, {
      clusterKey,
      status: args.status ?? 'validated',
      max: readNumberArg(args.max, 5000),
      validFrom,
      dryRun: args['dry-run'] === 'true',
    });
    writeJson(result);
  }
  finally {
    await prisma.$disconnect();
  }
});
