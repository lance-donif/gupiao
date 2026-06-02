import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

export const DEFAULT_DATABASE_URL = 'postgresql://gupiao:password@localhost:5432/gupiaodb';
export const DEFAULT_CLUSTER_KEY = 'global';

export const parseArgs = (argv: readonly string[] = process.argv): Record<string, string> => {
  const parsed: Record<string, string> = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    parsed[token.slice(2)] = argv[index + 1] && !argv[index + 1].startsWith('--')
      ? argv[++index]
      : 'true';
  }
  return parsed;
};

export const readDateArg = (value: string | undefined, fallback: Date): Date => {
  const parsed = new Date(value ?? fallback);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid date argument: ${value}`);
  }
  return parsed;
};

export const readTradeDateArg = (value: string | undefined): Date => {
  if (!value) {
    throw new Error('Missing trade date argument');
  }
  const parsed = /^\d{4}-\d{2}-\d{2}$/u.test(value)
    ? new Date(`${value}T00:00:00.000Z`)
    : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid trade date argument: ${value}`);
  }
  return parsed;
};

export const readNumberArg = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number argument: ${value}`);
  }
  return parsed;
};

export const createScriptPrismaClient = (): PrismaClient => {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    }),
  });
};

export const writeJson = (value: unknown): void => {
  console.log(JSON.stringify(value, null, 2));
};

export const runCli = async (fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
  }
  catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
};
