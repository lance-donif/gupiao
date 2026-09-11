import { pathToFileURL } from 'node:url';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadBackendEnv } from '../src/services/load-backend-env.js';

loadBackendEnv();

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://gupiao:password@localhost:5432/gupiaodb';
const CATEGORIES = ['stopword', 'high_signal', 'canonical', 'buzz_positive', 'buzz_negative', 'blocking'] as const;

const parseArgs = (): Record<string, string> => {
  const parsed: Record<string, string> = {};
  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index] as string;
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = process.argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      parsed[key] = next;
      index += 1;
    }
    else {
      parsed[key] = 'true';
    }
  }
  return parsed;
};

const usage = (): void => {
  console.log([
    '用法：',
    '  bun run scripts/keyword-dict.ts list [--category high_signal] [--status active]',
    '  bun run scripts/keyword-dict.ts add --term 新能源 --category high_signal [--canonical 新能源]',
    '  bun run scripts/keyword-dict.ts disable --term <词> --category <类>',
    `合法 category：${CATEGORIES.join(', ')}`,
  ].join('\n'));
};

async function main(): Promise<void> {
  const [command] = process.argv.slice(2).filter(token => !token.startsWith('--'));
  const args = parseArgs();
  if (command !== 'list' && command !== 'add' && command !== 'disable') {
    usage();
    process.exitCode = 1;
    return;
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL }),
  });

  try {
    const delegate = (prisma as unknown as Record<string, any>).keywordDictionary;
    if (!delegate) {
      throw new Error('prisma.keywordDictionary 不可用：请先执行 migrate 20260911000000_add_keyword_dictionary');
    }
    if (command === 'list') {
      const rows = await delegate.findMany({
        where: {
          ...(args.category ? { category: args.category } : {}),
          ...(args.status ? { status: args.status } : {}),
        },
        orderBy: [{ category: 'asc' }, { term: 'asc' }],
        take: 500,
      });
      for (const row of rows) {
        console.log(`${row.category}\t${row.status}\t${row.term}${row.canonicalTerm ? `\t=> ${row.canonicalTerm}` : ''}`);
      }
      console.log(`共 ${rows.length} 条（最多展示 500）。`);
      return;
    }
    const term = (args.term ?? '').trim();
    const category = (args.category ?? '').trim();
    if (!term || !(CATEGORIES as readonly string[]).includes(category)) {
      usage();
      process.exitCode = 1;
      return;
    }
    if (command === 'add') {
      await delegate.upsert({
        where: { term_category: { term, category } },
        create: { term, category, canonicalTerm: args.canonical?.trim() || null, source: 'manual' },
        update: { canonicalTerm: args.canonical?.trim() || null, status: 'active', source: 'manual' },
      });
      console.log(`已生效：${category} / ${term}`);
      return;
    }
    const result = await delegate.updateMany({
      where: { term, category },
      data: { status: 'disabled' },
    });
    console.log(result.count > 0 ? `已禁用：${category} / ${term}` : `未找到：${category} / ${term}`);
  }
  finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
