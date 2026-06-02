import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NewsCleaner } from '../src/services/news-cleaner.js';

interface IRawNewsItem {
  title: string;
  source: string;
  publishedAt: string;
}

interface IRawNewsFile {
  fetchedAt: string;
  totalCount: number;
  sourcesBreakdown: Record<string, number>;
  news: IRawNewsItem[];
}

async function main() {
  // 读取最新的临时文件
  const tmpDir = path.resolve(process.cwd(), 'tmp');
  const files = ['today-news-2026-03-17T10-27-28.json', 'news-count-2026-03-17T10-21-02-609Z.json'];

  let rawNews: IRawNewsFile | null = null;
  let filePath = '';

  for (const f of files) {
    try {
      const p = path.join(tmpDir, f);
      const content = await readFile(p, 'utf-8');
      rawNews = JSON.parse(content) as IRawNewsFile;
      filePath = p;
      break;
    } catch {
      continue;
    }
  }

  if (!rawNews) {
    console.log('未找到临时新闻文件');
    return;
  }

  console.log('\n===== 新闻清洗测试 =====');
  console.log('原始文件:', filePath);
  console.log('原始新闻数:', rawNews.news.length);

  // 转换为清洗器格式
  const items = rawNews.news.map((n, idx) => ({
    id: `news-${idx}`,
    title: n.title,
    summary: n.title, // 用标题作为摘要
    url: '',
    publishedAt: n.publishedAt,
    capturedAt: rawNews!.fetchedAt,
    providerMetadata: { source: n.source },
  }));

  // 执行清洗
  const cleaner = new NewsCleaner({ similarityThreshold: 0.85 });
  const result = cleaner.clean(items);

  console.log('\n===== 清洗结果 =====');
  console.log('原始数量:', result.diagnostics.rawCount);
  console.log('精确去重后:', result.diagnostics.exactDedupCount);
  console.log('语义去重后:', result.diagnostics.semanticDedupCount);
  console.log('去除重复:', result.diagnostics.duplicateCount);
  console.log('保留比例:', ((result.diagnostics.semanticDedupCount / result.diagnostics.rawCount) * 100).toFixed(1) + '%');

  // 按来源统计清洗后分布
  const sources: Record<string, number> = {};
  for (const item of result.items) {
    const src = (item.providerMetadata?.source as string) || 'unknown';
    sources[src] = (sources[src] || 0) + 1;
  }
  console.log('\n清洗后来源分布:');
  for (const [src, count] of Object.entries(sources).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${src}: ${count} 条`);
  }

  // 保存清洗结果
  const outputPath = path.join(tmpDir, `cleaned-news-${new Date().toISOString().replaceAll(':', '-').split('.')[0]}.json`);
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        cleanedAt: new Date().toISOString(),
        diagnostics: result.diagnostics,
        sourcesBreakdown: sources,
        news: result.items.map((i) => ({
          title: i.title,
          source: i.providerMetadata?.source,
          publishedAt: i.publishedAt,
        })),
      },
      null,
      2,
    ),
  );
  console.log('\n清洗后文件:', outputPath);
}

main().catch(console.error);
