/**
 * 新闻联调验证脚本
 * 
 * 直接测试 AKTools 4 个入口的新闻数量，不依赖数据库
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const AKTOOLS_BASE_URL = 'http://127.0.0.1:8010';

const ENDPOINTS = [
  { endpoint: 'stock_info_global_em', source: 'akshare_global_em' },
  { endpoint: 'stock_info_global_cls', source: 'akshare_global_cls' },
  { endpoint: 'stock_info_global_ths', source: 'akshare_global_ths' },
  { endpoint: 'news_economic_baidu', source: 'akshare_baidu' },
] as const;

interface NewsRecord {
  title: string | null;
  source: string;
  endpoint: string;
  publishedAt: string | null;
}

const toNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const extractTitle = (record: Record<string, unknown>, endpoint: string): string | null => {
  if (endpoint === 'news_economic_baidu') {
    const region = toNonEmptyString(record['地区']);
    const event = toNonEmptyString(record['事件']);
    if (!event) return null;
    return region ? `${region}: ${event}` : event;
  }
  return toNonEmptyString(record['标题']);
};

const extractPublishedAt = (record: Record<string, unknown>, endpoint: string): string | null => {
  if (endpoint === 'stock_info_global_em') {
    return toNonEmptyString(record['发布时间']);
  }
  if (endpoint === 'stock_info_global_cls') {
    return `${toNonEmptyString(record['发布日期']) ?? ''} ${toNonEmptyString(record['发布时间']) ?? ''}`.trim() || null;
  }
  if (endpoint === 'stock_info_global_ths') {
    return toNonEmptyString(record['发布时间']);
  }
  // news_economic_baidu
  return `${toNonEmptyString(record['日期']) ?? ''} ${toNonEmptyString(record['时间']) ?? ''}`.trim() || null;
};

async function fetchEndpoint(endpoint: string): Promise<NewsRecord[]> {
  const url = `${AKTOOLS_BASE_URL}/api/public/${endpoint}`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`  ❌ ${endpoint}: HTTP ${response.status}`);
      return [];
    }
    
    const payload = await response.json();
    if (!Array.isArray(payload)) {
      console.error(`  ❌ ${endpoint}: 非数组响应`);
      return [];
    }
    
    const records = payload
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((record) => ({
        title: extractTitle(record, endpoint),
        source: ENDPOINTS.find(e => e.endpoint === endpoint)!.source,
        endpoint,
        publishedAt: extractPublishedAt(record, endpoint),
      }))
      .filter((r) => r.title !== null);
    
    console.log(`  ✅ ${endpoint}: ${records.length} 条`);
    return records;
  } catch (error) {
    console.error(`  ❌ ${endpoint}: ${error instanceof Error ? error.message : 'unknown error'}`);
    return [];
  }
}

async function main() {
  console.log('=== 新闻联调验证 ===\n');
  console.log(`AKTools Base URL: ${AKTOOLS_BASE_URL}`);
  console.log(`时间: ${new Date().toISOString()}\n`);
  
  console.log('📊 各入口新闻数量：');
  
  const allNews: NewsRecord[] = [];
  const breakdown: Record<string, number> = {};
  
  for (const { endpoint, source } of ENDPOINTS) {
    const records = await fetchEndpoint(endpoint);
    allNews.push(...records);
    breakdown[source] = records.length;
  }
  
  console.log('\n📈 汇总统计：');
  console.log(`  总新闻数量: ${allNews.length} 条`);
  console.log('\n  来源分布：');
  for (const [source, count] of Object.entries(breakdown)) {
    console.log(`    - ${source}: ${count} 条`);
  }
  
  // 写入临时文件
  const tmpDir = path.resolve(process.cwd(), 'backend/tmp');
  await mkdir(tmpDir, { recursive: true });
  
  const runId = `news-count-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`;
  const filePath = path.join(tmpDir, `${runId}.json`);
  
  const artifact = {
    fetchedAt: new Date().toISOString(),
    aktoolsBaseUrl: AKTOOLS_BASE_URL,
    summary: {
      totalNewsCount: allNews.length,
      sourcesBreakdown: breakdown,
    },
    news: allNews,
  };
  
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(`\n📁 临时文件: ${filePath}`);
  
  // 结论
  console.log('\n🎯 验证结果：');
  if (allNews.length >= 400) {
    console.log(`  ✅ 达到预期 (≥400条)，实际获取 ${allNews.length} 条`);
  } else {
    console.log(`  ⚠️  未达到预期 (期望400-600条)，实际获取 ${allNews.length} 条`);
  }
}

main().catch(console.error);
