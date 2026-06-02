import { CoverageLoopReportService } from '../src/services/limitup-evidence-initialization.js';
import {
  createScriptPrismaClient,
  DEFAULT_CLUSTER_KEY,
  parseArgs,
  readTradeDateArg,
  runCli,
  writeJson,
} from './limitup-cli-utils.js';

runCli(async () => {
  const args = parseArgs();
  const clusterKey = args.cluster ?? DEFAULT_CLUSTER_KEY;
  const from = readTradeDateArg(args.from);
  const to = readTradeDateArg(args.to);
  const prisma = createScriptPrismaClient();

  try {
    const result = await new CoverageLoopReportService().report(prisma, {
      clusterKey,
      from,
      to,
    });
    writeJson(result);
  }
  finally {
    await prisma.$disconnect();
  }
});
