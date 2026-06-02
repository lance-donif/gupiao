import { AkToolsHttpNewsProvider } from '../src/services/tavily-news-provider.js';
import { createProviderRequestMetadata } from '../src/sources/index.js';
import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

// UTC 转北京时间 (UTC+8)
const toBeijingTime = (isoString: string): string => {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).replace(/\//g, '-');
};

async function main() {
  const provider = new AkToolsHttpNewsProvider({
    baseUrl: 'http://127.0.0.1:8010',
    maxResults: 10000,
  });

  const metadata = createProviderRequestMetadata();
  const result = await provider.executeAsync(
    { query: '', asOf: new Date(), timeWindow: { start: new Date(), end: new Date() } },
    metadata,
  );

  if (result.status === 'success') {
    const items = result.payload.items;
    const now = new Date();
    console.log('\n===== 今日新闻统计 =====');
    console.log('抓取时间 (北京时间):', toBeijingTime(now.toISOString()));
    console.log('总新闻数:', items.length);

    // 按来源统计
    const sources: Record<string, number> = {};
    for (const item of items) {
      const src = (item.providerMetadata?.source as string) || 'unknown';
      sources[src] = (sources[src] || 0) + 1;
    }
    console.log('\n来源分布:');
    for (const [src, count] of Object.entries(sources)) {
      console.log(`  ${src}: ${count} 条`);
    }

    // 时间范围 (北京时间)
    const dates = items.map((i) => i.publishedAt).sort();
    console.log('\n时间范围 (北京时间):');
    console.log('  最早:', toBeijingTime(dates[0]));
    console.log('  最新:', toBeijingTime(dates[dates.length - 1]));

    // 写入临时文件（只保留一个）
    const tmpDir = path.resolve(process.cwd(), 'tmp');
    await mkdir(tmpDir, { recursive: true });

    // 删除旧的 today-news-*.json 文件
    const oldFiles = (await readdir(tmpDir)).filter(f => f.startsWith('today-news-') && f.endsWith('.json'));
    for (const f of oldFiles) {
      await unlink(path.join(tmpDir, f));
    }

    const beijingNow = toBeijingTime(now.toISOString()).replace(/[ :]/g, '-');
    const filePath = path.join(tmpDir, `today-news-${beijingNow}.json`);
    await writeFile(
      filePath,
      JSON.stringify(
        {
          fetchedAtBeijing: toBeijingTime(now.toISOString()),
          totalCount: items.length,
          sourcesBreakdown: sources,
          timeRange: {
            earliest: toBeijingTime(dates[0]),
            latest: toBeijingTime(dates[dates.length - 1]),
          },
          news: items.map((i) => ({
            title: i.title,
            summary: i.summary,
            source: i.providerMetadata?.source,
            publishedAtBeijing: toBeijingTime(i.publishedAt),
          })),
        },
        null,
        2,
      ),
    );
    console.log('\n文件已保存:', filePath, `(删除了 ${oldFiles.length} 个旧文件)`);
  } else {
    console.log('失败:', result.failure.message);
  }
}

main().catch(console.error);
