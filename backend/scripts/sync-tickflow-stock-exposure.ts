import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { loadBackendEnv } from '../src/services/load-backend-env.js';
import { createTickFlowStockExposureServiceFromEnv } from '../src/services/tickflow-stock-exposure-service.js';

loadBackendEnv();

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://gupiao:password@localhost:5432/gupiaodb';
const DEFAULT_CLUSTER_KEY = 'global';

const parseArgs = (): Record<string, string> => {
  const parsed: Record<string, string> = {};
  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    parsed[token.slice(2)] = process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
      ? process.argv[++index]
      : 'true';
  }
  return parsed;
};

const getAsOf = (raw: string | undefined): Date => {
  const asOf = new Date(raw ?? '2026-05-24T15:59:59.999Z');
  if (Number.isNaN(asOf.getTime())) {
    throw new Error(`Invalid --as-of: ${raw}`);
  }
  return asOf;
};

const createStockNameMap = async (prisma: PrismaClient, clusterKey: string): Promise<Map<string, string>> => {
  const stocks = await prisma.stock.findMany({
    where: { clusterKey },
    select: {
      symbol: true,
      name: true,
    },
  });

  const result = new Map<string, string>();
  for (const stock of stocks) {
    if (/^\d{6}$/u.test(stock.symbol) && stock.name.trim().length > 0) {
      result.set(stock.symbol, stock.name);
    }
  }
  return result;
};

async function main(): Promise<void> {
  const args = parseArgs();
  const clusterKey = args.cluster ?? DEFAULT_CLUSTER_KEY;
  const asOf = getAsOf(args['as-of']);
  const traceId = args['trace-id'] ?? `tickflow-exposure-${clusterKey}-${asOf.toISOString().slice(0, 10)}`;
  const universeLimit = args.limit ? Number(args.limit) : undefined;

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL }),
  });

  try {
    const stockNameBySymbol = await createStockNameMap(prisma, clusterKey);
    const result = await createTickFlowStockExposureServiceFromEnv().sync(prisma, {
      traceId,
      asOf,
      clusterKey,
      stockNameBySymbol,
      universeLimit,
    });

    console.log(JSON.stringify({
      traceId,
      asOf: asOf.toISOString(),
      clusterKey,
      ...result,
    }, null, 2));
  }
  finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
