import { existsSync } from 'node:fs';
import { writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ponytail: Bun v1.3.14（macOS）对 GTS Root R4 链的验证偶发失败，
// 若未显式配置 CA 文件，则回退到系统证书包。
function ensureSystemCaBundle(): void {
  if (process.env.NODE_EXTRA_CA_CERTS) return;
  const candidates = [
    '/etc/ssl/cert.pem',
    '/etc/ssl/certs/ca-certificates.crt',
    '/System/Library/OpenSSL/certs/cert.pem',
  ];
  for (const caPath of candidates) {
    if (existsSync(caPath)) {
      process.env.NODE_EXTRA_CA_CERTS = caPath;
      return;
    }
  }
}
ensureSystemCaBundle();

export interface INewsNowFetchedItem {
  readonly title: string;
  readonly summary: string;
  readonly url: string;
  readonly sourceDomain: string;
  readonly category: string;
  readonly content: string;
}

export interface IFetchNewsNowToFileResult {
  readonly filePath: string;
  readonly fetchedAt: string;
  readonly totalCount: number;
  readonly withContentCount: number;
  readonly categoryBreakdown: Record<string, number>;
  readonly sourcesBreakdown: Record<string, number>;
  readonly news: readonly INewsNowFetchedItem[];
}

const NEWSNOW_BASE_URL = 'https://newsnow.busiyi.world';
const NEWSNOW_ORIGIN = NEWSNOW_BASE_URL;
const NEWSNOW_API_URL = `${NEWSNOW_BASE_URL}/api/s/entire`;

const REQUIRED_NETWORK_DOMAINS = [
  'newsnow.busiyi.world',
] as const;

// ponytail: 源码把 source 列表直接打进 bundle，所以按当前线上版本硬编码。
// 如果 NewsNow 新增/删除源，更新这个数组即可。
const NEWSNOW_SOURCE_IDS = [
  'v2ex',
  'v2ex-share',
  'zhihu',
  'weibo',
  'zaobao',
  'coolapk',
  'mktnews',
  'mktnews-flash',
  'wallstreetcn',
  'wallstreetcn-quick',
  'wallstreetcn-news',
  'wallstreetcn-hot',
  '36kr',
  '36kr-quick',
  '36kr-renqi',
  'douyin',
  'hupu',
  'aihot',
  'tieba',
  'toutiao',
  'ithome',
  'thepaper',
  'sputniknewscn',
  'cankaoxiaoxi',
  'pcbeta',
  'pcbeta-windows11',
  'cls',
  'cls-telegraph',
  'cls-depth',
  'cls-hot',
  'xueqiu',
  'xueqiu-hotstock',
  'gelonghui',
  'fastbull',
  'fastbull-express',
  'fastbull-news',
  'solidot',
  'hackernews',
  'producthunt',
  'github',
  'github-trending-today',
  'bilibili',
  'bilibili-hot-search',
  'kaopu',
  'jin10',
  'baidu',
  'nowcoder',
  'sspai',
  'juejin',
  'ifeng',
  'chongbuluo',
  'chongbuluo-latest',
  'chongbuluo-hot',
  'douban',
  'steam',
  'tencent',
  'tencent-hot',
  'freebuf',
  'qqvideo',
  'qqvideo-tv-hotsearch',
  'iqiyi',
  'iqiyi-hot-ranklist',
] as const;

const parsePositiveIntegerEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

const NEWSNOW_REQUEST_TIMEOUT_MS = parsePositiveIntegerEnv('NEWSNOW_REQUEST_TIMEOUT_MS', 60_000);
const NEWSNOW_MAX_SOURCES = parsePositiveIntegerEnv('NEWSNOW_MAX_SOURCES', 0);

// 排除的视频/娱乐类域名
const EXCLUDED_DOMAINS = [
  'v.qq.com',         // 腾讯视频
  'www.iqiyi.com',    // 爱奇艺
  'iqiyi.com',
  'www.bilibili.com', // 哔哩哔哩
  'bilibili.com',
  'm.bilibili.com',
  'www.youku.com',    // 优酷
  'youku.com',
  'v.youku.com',
  'film.qq.com',
  'www.zhihu.com',    // 知乎（反爬限制）
  'zhihu.com',
];

// 检测 content 是否有效（非重复、非登录页面）
function isValidContent(content: string): boolean {
  if (!content || content.length < 50) return false;

  // 检测登录/错误页面特征
  const invalidPatterns = [
    '扫描二维码登录',
    '短信验证登录',
    '请稍后重试',
    '系统繁忙',
    '您当前请求存在异常',
    '登录/注册',
    '账号密码登录',
    '!function(){var e=document',
    'window.dataLayer',
    'gtag(',
  ];

  for (const pattern of invalidPatterns) {
    if (content.includes(pattern)) {
      return false;
    }
  }

  return true;
}

const delay = (ms: number): Promise<void> => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

const getHeaders = (): Record<string, string> => ({
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Origin': NEWSNOW_ORIGIN,
  'Referer': `${NEWSNOW_ORIGIN}/`,
});

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NEWSNOW_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      headers: { ...getHeaders(), ...(init.headers ?? {}) },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`NewsNow API 返回 ${response.status}: ${await response.text()}`);
    }

    return response;
  } finally {
    clearTimeout(timeout);
  }
}

interface INewsNowApiItem {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly extra?: unknown;
}

interface INewsNowApiSource {
  readonly status: string;
  readonly id: string;
  readonly items: readonly INewsNowApiItem[];
  readonly updatedTime: number;
}

function extractSummary(extra: unknown): string {
  if (!extra || typeof extra !== 'object') return '';
  const record = extra as Record<string, unknown>;
  if (typeof record.hover === 'string') return record.hover;
  if (typeof record.info === 'string') return record.info;
  return '';
}

async function fetchNewsNowSources(
  maxAttempts = 3,
): Promise<readonly INewsNowApiSource[]> {
  const sourceIds = NEWSNOW_MAX_SOURCES > 0
    ? NEWSNOW_SOURCE_IDS.slice(0, NEWSNOW_MAX_SOURCES)
    : NEWSNOW_SOURCE_IDS;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(NEWSNOW_API_URL, {
        method: 'POST',
        body: JSON.stringify({ sources: sourceIds }),
      });
      const data = (await response.json()) as unknown;
      if (!Array.isArray(data)) {
        throw new Error('NewsNow API 返回非数组数据');
      }
      return data as INewsNowApiSource[];
    }
    catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`  第 ${attempt}/${maxAttempts} 次请求失败：${message}`);
      if (attempt < maxAttempts) {
        await delay(1000 * attempt);
      }
    }
  }

  throw new Error([
    `NewsNow 抓取失败，已重试 ${maxAttempts} 次。`,
    `最后错误：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    `当前超时配置：request=${NEWSNOW_REQUEST_TIMEOUT_MS}ms。`,
    `请确认网络/代理允许访问：${REQUIRED_NETWORK_DOMAINS.join(', ')}`,
  ].join(' '));
}

export async function fetchNewsNowToFile(outputDirectory = path.resolve(process.cwd(), 'tmp')): Promise<IFetchNewsNowToFileResult> {
  console.log('正在用 fetch 抓取 NewsNow（多源聚合）...');

  const sources = await fetchNewsNowSources();
  console.log(`NewsNow 返回源数: ${sources.length}`);

  // 解析为统一结构
  const allNews: INewsNowFetchedItem[] = [];

  for (const source of sources) {
    const category = source.id;

    for (const item of source.items) {
      if (!item.title || item.title.length < 5) {
        continue;
      }

      let fullUrl = item.url;
      if (!fullUrl.startsWith('http')) {
        fullUrl = `${NEWSNOW_BASE_URL}${fullUrl}`;
      }

      if (!fullUrl.startsWith('http')) {
        continue;
      }

      if (/^https?:\/\/(www\.)?zhihu\.com\/?$/u.test(fullUrl)) {
        continue;
      }

      if (fullUrl === 'https://weibo.com/' || fullUrl === 'https://www.coolapk.com/') {
        continue;
      }

      let sourceDomain: string;
      try {
        sourceDomain = new URL(fullUrl).hostname;
      }
      catch {
        continue;
      }

      if (EXCLUDED_DOMAINS.includes(sourceDomain)) {
        continue;
      }

      const title = item.title.replace(/^\d+\s*/u, '');
      if (!title || title.length < 5) {
        continue;
      }

      const summary = extractSummary(item.extra).trim();

      allNews.push({
        title,
        summary,
        url: fullUrl,
        sourceDomain,
        category,
        content: isValidContent(summary) ? summary : '',
      });
    }
  }

  // 去重（按 URL）
  const seen = new Set<string>();
  const uniqueNews = allNews.filter((n) => {
    if (seen.has(n.url)) return false;
    seen.add(n.url);
    return true;
  });

  console.log(`\n去重前: ${allNews.length} 条, 去重后: ${uniqueNews.length} 条`);

  // 排除视频/娱乐类域名
  const beforeFilter = uniqueNews.length;
  const filteredNews = uniqueNews.filter(n => !EXCLUDED_DOMAINS.includes(n.sourceDomain));
  console.log(`排除视频网站后: ${filteredNews.length} 条 (过滤了 ${beforeFilter - filteredNews.length} 条)`);

  // 统计
  console.log('\n===== NewsNow 新闻统计 =====');
  console.log('总新闻数:', filteredNews.length);

  // 按分类统计
  const categoryStats: Record<string, number> = {};
  const sourcesBreakdown: Record<string, number> = {};
  let withContent = 0;

  for (const n of filteredNews) {
    categoryStats[n.category] = (categoryStats[n.category] || 0) + 1;
    sourcesBreakdown[n.sourceDomain] = (sourcesBreakdown[n.sourceDomain] || 0) + 1;
    if (n.content && n.content.length > 20) withContent++;
  }

  console.log('\n分类分布:');
  for (const [cat, count] of Object.entries(categoryStats)) {
    console.log(`  ${cat}: ${count} 条`);
  }

  const sorted = Object.entries(sourcesBreakdown).sort((a, b) => b[1] - a[1]);
  console.log('\n来源分布:');
  for (const [domain, count] of sorted) {
    console.log(`  ${domain}: ${count} 条`);
  }

  console.log(`\n有有效内容的: ${withContent}/${filteredNews.length}`);

  // 保存（只保留一个文件）
  await mkdir(outputDirectory, { recursive: true });

  // 删除旧的 newsnow-*.json 文件
  const oldFiles = (await readdir(outputDirectory)).filter(f => f.startsWith('newsnow-') && f.endsWith('.json'));
  for (const f of oldFiles) {
    await unlink(path.join(outputDirectory, f));
  }

  const fetchedAt = new Date().toISOString();
  const fileName = `newsnow-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
  const filePath = path.join(outputDirectory, fileName);
  const payload: IFetchNewsNowToFileResult = {
    filePath,
    fetchedAt,
    totalCount: filteredNews.length,
    withContentCount: withContent,
    categoryBreakdown: categoryStats,
    sourcesBreakdown,
    news: filteredNews,
  };

  await writeFile(
    filePath,
    JSON.stringify(
      {
        fetchedAt: payload.fetchedAt,
        totalCount: payload.totalCount,
        withContentCount: payload.withContentCount,
        categoryBreakdown: payload.categoryBreakdown,
        sourcesBreakdown: payload.sourcesBreakdown,
        excludedDomains: EXCLUDED_DOMAINS,
        news: payload.news,
      },
      null,
      2,
    ),
  );
  console.log(`\n已保存到 ${filePath} (删除了 ${oldFiles.length} 个旧文件)`);

  // 显示示例
  console.log('\n前 3 条新闻:');
  for (const n of filteredNews.slice(0, 3)) {
    console.log(`\n【${n.category}】【${n.sourceDomain}】${n.title}`);
    if (n.content) {
      console.log(`  内容: ${n.content.slice(0, 150)}...`);
    } else {
      console.log(`  内容: [无效/登录限制]`);
    }
  }

  if (filteredNews.length === 0) {
    throw new Error('NewsNow 抓取成功但没有得到可用新闻，停止后续流程');
  }

  return payload;
}

async function main(): Promise<void> {
  await fetchNewsNowToFile();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
