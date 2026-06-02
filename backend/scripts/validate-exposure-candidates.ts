import {
  ExposureCandidateValidationService,
  FactSnapshotService,
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
  const traceId = args.trace ?? args.traceId ?? args['trace-id'] ?? `validate-exposure-candidates-${clusterKey}-${asOf.toISOString().slice(0, 10)}`;
  const prisma = createScriptPrismaClient();

  try {
    const validation = await new ExposureCandidateValidationService().validate(prisma, {
      clusterKey,
      status: args.status ?? 'pending_review',
      max: readNumberArg(args.max, 5000),
      dryRun: args['dry-run'] === 'true',
    });
    const snapshot = args['dry-run'] === 'true'
      ? null
      : await new FactSnapshotService().ensure(prisma, {
          traceId,
          clusterKey,
          asOf,
        });
    writeJson({ validation, snapshot });
  }
  finally {
    await prisma.$disconnect();
  }
});
