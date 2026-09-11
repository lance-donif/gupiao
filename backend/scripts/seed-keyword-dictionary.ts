import { pathToFileURL } from 'node:url';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadBackendEnv } from '../src/services/load-backend-env.js';
import { SEED_KEYWORD_DICTIONARY_ENTRIES } from '../src/services/keyword-dictionary-seed.js';

loadBackendEnv();

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://gupiao:password@localhost:5432/gupiaodb';

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL }),
  });

  try {
    const delegate = (prisma as unknown as Record<string, any>).keywordDictionary;
    if (!delegate?.createMany) {
      throw new Error('prisma.keywordDictionary 不可用：请先执行 migrate 20260911000000_add_keyword_dictionary');
    }
    const result = await delegate.createMany({
      data: SEED_KEYWORD_DICTIONARY_ENTRIES.map(entry => ({
        term: entry.term,
        category: entry.category,
        canonicalTerm: entry.canonicalTerm ?? null,
        source: entry.source,
      })),
      skipDuplicates: true,
    });
    console.log(`词典 seed 完成：共 ${SEED_KEYWORD_DICTIONARY_ENTRIES.length} 条，新增 ${result.count} 条（已存在按 [term, category] 跳过）。`);
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
