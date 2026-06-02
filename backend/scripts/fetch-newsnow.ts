import { chromium, type Browser } from 'playwright';
import { writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type BrowserElement = {
  href?: string;
  scrollTop?: number;
  scrollHeight?: number;
  textContent?: string | null;
  getAttribute?: (name: string) => string | null;
  querySelector?: (selector: string) => BrowserElement | null;
};

declare const document: {
  querySelector: (selector: string) => BrowserElement | null;
  querySelectorAll: (selector: string) => BrowserElement[];
};

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

const NEWSNOW_CATEGORIES = [
  { name: 'home', url: 'https://newsnow.busiyi.world' },
];

const REQUIRED_NETWORK_DOMAINS = [
  'newsnow.busiyi.world',
] as const;

const OPTIONAL_BLOCKED_DOMAINS = [
  'www.google-analytics.com',
  'google-analytics.com',
  'www.googletagmanager.com',
  'googletagmanager.com',
  'stats.g.doubleclick.net',
  'doubleclick.net',
] as const;

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media']);

const parsePositiveIntegerEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

const NEWSNOW_NAVIGATION_TIMEOUT_MS = parsePositiveIntegerEnv('NEWSNOW_NAVIGATION_TIMEOUT_MS', 60_000);
const NEWSNOW_LINK_WAIT_TIMEOUT_MS = parsePositiveIntegerEnv('NEWSNOW_LINK_WAIT_TIMEOUT_MS', 20_000);
const NEWSNOW_MAX_DISCOVERED_CATEGORIES = parsePositiveIntegerEnv('NEWSNOW_MAX_DISCOVERED_CATEGORIES', 8);

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

const isOptionalDomain = (url: string): boolean => {
  try {
    const hostname = new URL(url).hostname;
    return OPTIONAL_BLOCKED_DOMAINS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  }
  catch {
    return false;
  }
};

// 滚动内部容器
async function scrollNewsNowContainer(page: import('playwright').Page): Promise<number> {
  let lastCount = 0;
  let noChangeCount = 0;
  let totalScrolled = 0;

  for (let i = 0; i < 50; i++) {
    const result = await page.evaluate(() => {
      const container = document.querySelector('.overflow-auto.px-4');
      if (!container) return { scrolled: false, scrollTop: 0, scrollHeight: 0 };

      const scrollContainer = container;
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      return {
        scrolled: true,
        scrollTop: scrollContainer.scrollTop,
        scrollHeight: scrollContainer.scrollHeight,
      };
    });

    await page.waitForTimeout(400);

    const currentCount = await page.evaluate(() => {
      const links = document.querySelectorAll('main a[href]');
      let externalCount = 0;
      links.forEach((link: BrowserElement) => {
        const href = link.href ?? '';
        if (href.startsWith('http') && !href.includes('newsnow.busiyi.world')) {
          externalCount++;
        }
      });
      return externalCount;
    });

    totalScrolled = result.scrollTop ?? 0;

    if (currentCount === lastCount) {
      noChangeCount++;
      if (noChangeCount >= 8) break;
    } else {
      noChangeCount = 0;
    }
    lastCount = currentCount;
  }

  return totalScrolled;
}

// 从单个分类抓取新闻
async function fetchCategory(browser: Browser, category: { name: string; url: string }): Promise<Array<{ title: string; summary: string; url: string; sourceDomain: string; category: string }>> {
  console.log(`\n正在抓取分类: ${category.name}...`);

  const page = await browser.newPage();
  try {
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (isOptionalDomain(request.url()) || BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
        await route.abort();
        return;
      }
      await route.continue();
    });
    page.setDefaultNavigationTimeout(NEWSNOW_NAVIGATION_TIMEOUT_MS);
    page.setDefaultTimeout(NEWSNOW_LINK_WAIT_TIMEOUT_MS);
    await page.goto(category.url, { waitUntil: 'domcontentloaded', timeout: NEWSNOW_NAVIGATION_TIMEOUT_MS });
    await page.waitForFunction(() => {
      return [...document.querySelectorAll('main a[href]')].some((link) => {
        const href = link.href ?? '';
        return href.startsWith('http') && !href.includes('newsnow.busiyi.world');
      });
    }, null, { timeout: NEWSNOW_LINK_WAIT_TIMEOUT_MS });
    await page.waitForTimeout(1500);

    // 滚动加载
    await scrollNewsNowContainer(page);

    // 提取新闻
    const news = await page.evaluate((catName) => {
      const results: Array<{ title: string; summary: string; url: string; sourceDomain: string; category: string }> = [];
      const seen = new Set<string>();

      document.querySelectorAll('main a[href]').forEach((link: BrowserElement) => {
        const href = link.href ?? '';
        const fullUrl = href.startsWith('http') ? href : `https://newsnow.busiyi.world${href}`;

        if (!fullUrl.startsWith('http') || fullUrl.includes('newsnow.busiyi.world')) {
          return;
        }

        if (link.querySelector?.('.w-8.h-8.rounded-full')) {
          return;
        }

        const fullText = link.textContent?.trim() ?? '';

        if (fullText.length < 8) {
          return;
        }

        if (/^https?:\/\/(www\.)?zhihu\.com\/?$/u.test(fullUrl)) {
          return;
        }

        if (fullUrl === 'https://weibo.com/' || fullUrl === 'https://www.coolapk.com/') {
          return;
        }

        // 必须有标题元素
        const titleEl = link.querySelector?.('.text-base');
        const title = titleEl?.textContent?.trim() || fullText.replace(/^\d+\s*/u, '');
        if (!title || title.length < 5) return;

        if (seen.has(fullUrl)) return;
        seen.add(fullUrl);

        const summary = link.getAttribute?.('title')?.trim() || '';

        results.push({
          title,
          summary,
          url: fullUrl,
          sourceDomain: new URL(fullUrl).hostname,
          category: catName,
        });
      });

      return results;
    }, category.name);

    console.log(`  ${category.name}: ${news.length} 条`);
    return news;
  } finally {
    await page.close();
  }
}

async function discoverNewsNowCategories(browser: Browser): Promise<readonly { name: string; url: string }[]> {
  const page = await browser.newPage();
  try {
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (isOptionalDomain(request.url()) || BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
        await route.abort();
        return;
      }
      await route.continue();
    });
    page.setDefaultNavigationTimeout(NEWSNOW_NAVIGATION_TIMEOUT_MS);
    page.setDefaultTimeout(NEWSNOW_LINK_WAIT_TIMEOUT_MS);
    await page.goto(NEWSNOW_CATEGORIES[0].url, { waitUntil: 'domcontentloaded', timeout: NEWSNOW_NAVIGATION_TIMEOUT_MS });
    await page.waitForTimeout(1000);

    const discovered = await page.evaluate((originUrl) => {
      const origin = new URL(originUrl).origin;
      const candidates: Array<{ name: string; url: string }> = [];
      document.querySelectorAll('a[href]').forEach((link: BrowserElement) => {
        const href = link.href ?? '';
        if (!href) {
          return;
        }
        const url = new URL(href, origin);
        if (url.origin !== origin || url.pathname === '/' || url.hash) {
          return;
        }
        const rawName = link.textContent?.trim() || url.pathname.replace(/^\/+/u, '');
        const name = rawName
          .replace(/\s+/gu, '-')
          .replace(/[^\u4E00-\u9FA5a-zA-Z0-9_-]/gu, '')
          .slice(0, 32);
        if (!name) {
          return;
        }
        candidates.push({ name, url: url.toString() });
      });
      return candidates;
    }, NEWSNOW_CATEGORIES[0].url);

    const seen = new Set(NEWSNOW_CATEGORIES.map(category => category.url));
    const categories = [...NEWSNOW_CATEGORIES];
    for (const category of discovered) {
      if (seen.has(category.url)) {
        continue;
      }
      seen.add(category.url);
      categories.push(category);
      if (categories.length >= NEWSNOW_MAX_DISCOVERED_CATEGORIES) {
        break;
      }
    }
    return categories;
  }
  catch (error) {
    console.warn(`NewsNow 分类自动发现失败，回退 home：${error instanceof Error ? error.message : String(error)}`);
    return NEWSNOW_CATEGORIES;
  }
  finally {
    await page.close();
  }
}

async function fetchCategoryWithRetry(
  browser: Browser,
  category: { name: string; url: string },
  maxAttempts = 3,
): Promise<Array<{ title: string; summary: string; url: string; sourceDomain: string; category: string }>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchCategory(browser, category);
    }
    catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`  ${category.name}: 第 ${attempt}/${maxAttempts} 次抓取失败：${message}`);
      if (attempt < maxAttempts) {
        await delay(1000 * attempt);
      }
    }
  }

  throw new Error([
    `NewsNow 分类 ${category.name} 抓取失败，已重试 ${maxAttempts} 次。`,
    `最后错误：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    `当前超时配置：navigation=${NEWSNOW_NAVIGATION_TIMEOUT_MS}ms links=${NEWSNOW_LINK_WAIT_TIMEOUT_MS}ms。`,
    `请确认网络/代理允许访问：${REQUIRED_NETWORK_DOMAINS.join(', ')}`,
  ].join(' '));
}

export async function fetchNewsNowToFile(outputDirectory = path.resolve(process.cwd(), 'tmp')): Promise<IFetchNewsNowToFileResult> {
  console.log('正在用 Playwright 抓取 NewsNow（多分类）...');

  const browser = await chromium.launch({ headless: true });

  try {
    const categories = await discoverNewsNowCategories(browser);
    console.log(`NewsNow 分类数: ${categories.length} (${categories.map(category => category.name).join(', ')})`);

    // 抓取所有分类
    const allNews: Array<{ title: string; summary: string; url: string; sourceDomain: string; category: string }> = [];

    for (let index = 0; index < categories.length; index += 1) {
      const category = categories[index];
      if (index === 0) {
        const news = await fetchCategoryWithRetry(browser, category);
        allNews.push(...news);
        continue;
      }
      try {
        const news = await fetchCategoryWithRetry(browser, category, 2);
        allNews.push(...news);
      }
      catch (error) {
        console.warn(`  ${category.name}: 增强分类跳过：${error instanceof Error ? error.message : String(error)}`);
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

    // 清理无效 content（登录/错误页面置空）
    const cleanedNews = filteredNews.map(n => ({
      ...n,
      content: isValidContent(n.summary) ? n.summary : '',
    }));

    // 统计
    console.log('\n===== NewsNow 新闻统计 =====');
    console.log('总新闻数:', cleanedNews.length);

    // 按分类统计
    const categoryStats: Record<string, number> = {};
    const sources: Record<string, number> = {};
    let withContent = 0;

    for (const n of cleanedNews) {
      categoryStats[n.category] = (categoryStats[n.category] || 0) + 1;
      sources[n.sourceDomain] = (sources[n.sourceDomain] || 0) + 1;
      if (n.content && n.content.length > 20) withContent++;
    }

    console.log('\n分类分布:');
    for (const [cat, count] of Object.entries(categoryStats)) {
      console.log(`  ${cat}: ${count} 条`);
    }

    const sorted = Object.entries(sources).sort((a, b) => b[1] - a[1]);
    console.log('\n来源分布:');
    for (const [domain, count] of sorted) {
      console.log(`  ${domain}: ${count} 条`);
    }

    console.log(`\n有有效内容的: ${withContent}/${cleanedNews.length}`);

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
      totalCount: cleanedNews.length,
      withContentCount: withContent,
      categoryBreakdown: categoryStats,
      sourcesBreakdown: sources,
      news: cleanedNews,
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
    for (const n of cleanedNews.slice(0, 3)) {
      console.log(`\n【${n.category}】【${n.sourceDomain}】${n.title}`);
      if (n.content) {
        console.log(`  内容: ${n.content.slice(0, 150)}...`);
      } else {
        console.log(`  内容: [无效/登录限制]`);
      }
    }

    if (cleanedNews.length === 0) {
      throw new Error('NewsNow 抓取成功但没有得到可用新闻，停止后续流程');
    }

    return payload;
  } finally {
    await browser.close();
  }
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
