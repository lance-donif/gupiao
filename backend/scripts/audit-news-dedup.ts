import { pathToFileURL } from 'node:url';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadBackendEnv } from '../src/services/load-backend-env.js';
import { normalizeTitleForMatch } from '../src/services/news-ingest-pipeline.js';

loadBackendEnv();

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://gupiao:password@localhost:5432/gupiaodb';
const MISS_SAMPLE_LIMIT = 10;

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

interface IDedupAuditRow {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly url: string;
  readonly publishedAt: Date;
  readonly reprintGroupId: string | null;
  readonly reprintWeight: unknown;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new Error(`--date 非法：${date}，期望 YYYY-MM-DD`);
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL }),
  });

  try {
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);
    const rows = await prisma.normalizedNewsRecord.findMany({
      where: { publishedAt: { gte: dayStart, lt: dayEnd } },
      select: { id: true, title: true, source: true, url: true, publishedAt: true, reprintGroupId: true, reprintWeight: true },
      orderBy: { publishedAt: 'asc' },
    }) as readonly IDedupAuditRow[];

    const groups = new Map<string, IDedupAuditRow[]>();
    for (const row of rows) {
      const groupId = row.reprintGroupId ?? row.id;
      const list = groups.get(groupId) ?? [];
      list.push(row);
      groups.set(groupId, list);
    }
    const multiGroups = [...groups.values()].filter(list => list.length > 1);
    const reprinted = multiGroups.reduce((sum, list) => sum + list.length - 1, 0);
    console.log(`日期 ${date}：新闻 ${rows.length} 条，分组 ${groups.size} 个，多条转载组 ${multiGroups.length} 个，转载率 ${(rows.length === 0 ? 0 : (reprinted / rows.length) * 100).toFixed(1)}%。`);

    // 可疑漏网：同组标题前缀相同、却被分到不同组的对（抽样）。
    const prefixIndex = new Map<string, IDedupAuditRow[]>();
    for (const row of rows) {
      const prefix = normalizeTitleForMatch(row.title).slice(0, 8);
      if (prefix.length < 8) {
        continue;
      }
      const list = prefixIndex.get(prefix) ?? [];
      list.push(row);
      prefixIndex.set(prefix, list);
    }
    let samples = 0;
    for (const list of prefixIndex.values()) {
      if (samples >= MISS_SAMPLE_LIMIT) {
        break;
      }
      const groupIds = new Set(list.map(row => row.reprintGroupId ?? row.id));
      if (groupIds.size < 2) {
        continue;
      }
      console.log(`\n可疑漏网（同前缀不同组）：`);
      for (const row of list.slice(0, 4)) {
        console.log(`  [${row.source}] ${row.title}（组 ${row.reprintGroupId ?? row.id}）`);
      }
      samples += 1;
    }
    if (samples === 0) {
      console.log('可疑漏网：无。');
    }
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
