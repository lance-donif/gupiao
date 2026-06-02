import {
  AiStockKeywordGenerationService,
  createAiStockKeywordRequesterFromEnv,
} from '../src/services/ai-stock-keyword-generation-service.js';
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

const parseSymbolFilter = (raw: string | undefined): readonly string[] => {
  if (!raw) {
    return [];
  }
  return raw.split(',').map(item => item.trim()).filter(item => /^\d{6}$/u.test(item));
};

runCli(async () => {
  const args = parseArgs();
  const clusterKey = args.cluster ?? DEFAULT_CLUSTER_KEY;
  const asOf = readDateArg(args['as-of'], new Date());
  const prisma = createScriptPrismaClient();
  const service = new AiStockKeywordGenerationService(createAiStockKeywordRequesterFromEnv());

  try {
    const result = await service.generate(prisma, {
      clusterKey,
      asOf,
      limit: readNumberArg(args.limit, 0),
      skip: readNumberArg(args.skip, 0),
      batchSize: readNumberArg(args['batch-size'], 20),
      symbolFilter: parseSymbolFilter(args.symbols),
      dryRun: args['dry-run'] === 'true',
      onProgress: args.progress === 'true'
        ? message => console.error(message)
        : undefined,
    });
    writeJson(result);
  }
  finally {
    await prisma.$disconnect();
  }
});
