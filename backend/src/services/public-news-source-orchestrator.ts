import type { INewsSourceArticle } from '../sources/contracts.js';
import crypto from 'node:crypto';
import * as cheerio from 'cheerio';

export type PublicNewsSourceMode = 'baseline' | 'expanded';

export interface IPublicNewsSourceAdapterFetchInput {
  readonly asOf: Date;
  readonly capturedAt: Date;
  readonly timeoutMs: number;
  readonly limit: number;
}

export interface IPublicNewsSourceAdapterResult {
  readonly articles: readonly INewsSourceArticle[];
  readonly summary: Readonly<Record<string, unknown>>;
}

export interface IPublicNewsSourceAdapter {
  readonly name: string;
  fetch: (input: IPublicNewsSourceAdapterFetchInput) => Promise<IPublicNewsSourceAdapterResult>;
}

export interface IPublicNewsSourceStatus {
  readonly status: 'success' | 'failed' | 'disabled';
  readonly articleCount: number;
  readonly elapsedMs: number;
  readonly error?: string;
  readonly summary?: Readonly<Record<string, unknown>>;
}

export interface IPublicNewsSourceSummary {
  readonly mode: PublicNewsSourceMode;
  readonly totalArticles: number;
  readonly sources: Readonly<Record<string, IPublicNewsSourceStatus>>;
}

export interface IPublicNewsSourceFetchInput {
  readonly asOf: Date;
  readonly capturedAt?: Date;
  readonly mode?: PublicNewsSourceMode;
}

export interface IPublicNewsSourceFetchResult {
  readonly articles: readonly INewsSourceArticle[];
  readonly summary: IPublicNewsSourceSummary;
}

export interface IPublicNewsSourceOrchestratorOptions {
  readonly adapters: readonly IPublicNewsSourceAdapter[];
  readonly timeoutMs: number;
  readonly perSourceLimit: number;
}

export interface IParseRssXmlInput {
  readonly xml: string;
  readonly sourceName: string;
  readonly feedUrl: string;
  readonly capturedAt: Date;
}

export interface IParseSinaFinanceRollHtmlInput {
  readonly html: string;
  readonly pageUrl: string;
  readonly capturedAt: Date;
}

export interface IRssFeedSpec {
  readonly name: string;
  readonly url: string;
}

export interface IRssNewsSourceAdapterOptions {
  readonly name: string;
  readonly feeds: readonly IRssFeedSpec[];
  readonly fetchImpl?: typeof fetch;
}

export interface ISinaFinanceRollAdapterOptions {
  readonly pageUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_PUBLIC_NEWS_TIMEOUT_MS = 12_000;
const DEFAULT_PUBLIC_NEWS_SOURCE_LIMIT = 300;

export const DEFAULT_SINA_RSS_FEEDS: readonly IRssFeedSpec[] = [
  { name: 'sina-finance-all', url: 'https://rss.sina.com.cn/news/allnews/finance.xml' },
  { name: 'sina-finance-hot', url: 'https://rss.sina.com.cn/roll/finance/hot_roll.xml' },
  { name: 'sina-stock-hot', url: 'https://rss.sina.com.cn/roll/stock/hot_roll.xml' },
  { name: 'sina-future', url: 'https://rss.sina.com.cn/finance/future.xml' },
] as const;

const DEFAULT_SINA_FINANCE_ROLL_URL = 'https://finance.sina.com.cn/roll/';

export const DEFAULT_GOOGLE_NEWS_KEYWORDS: readonly string[] = [
  'A股 产业链',
  'A股 大宗商品',
  'A股 半导体',
  'A股 新能源',
  '上市公司 订单',
  '上市公司 涨价',
  '机器人 订单 A股',
  '储能 装机 A股',
  '光伏 需求 A股',
  '工业金属 价格 上涨',
] as const;

const normalizeWhitespace = (value: string): string => value.trim().replace(/\s+/gu, ' ');

const toNonEmptyString = (value: string | undefined): string | null => {
  const normalized = normalizeWhitespace(value ?? '');
  return normalized.length > 0 ? normalized : null;
};

const stripHtml = (value: string): string => normalizeWhitespace(cheerio.load(value).text() || value);

const parsePublishedAt = (raw: string | null, capturedAt: Date): Date => {
  if (!raw) {
    return capturedAt;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? capturedAt : parsed;
};

const createRecordId = (
  sourceName: string,
  feedUrl: string,
  title: string,
  url: string,
  publishedAt: Date,
): string => {
  const digest = crypto
    .createHash('sha1')
    .update([sourceName, feedUrl, title, url, publishedAt.toISOString()].join('\n'))
    .digest('hex')
    .slice(0, 24);
  return `${sourceName}:${digest}`;
};

const ensureUrl = (sourceName: string, recordId: string, rawUrl: string | null): string => {
  if (rawUrl) {
    return rawUrl;
  }
  return `public-news://${sourceName}/${recordId}`;
};

const fetchTextWithSignal = async (
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal,
): Promise<string> => {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.text();
};

const isSinaFinanceArticleUrl = (rawUrl: string): boolean => {
  try {
    const url = new URL(rawUrl);
    if (url.hostname === 'cj.sina.cn') {
      return true;
    }
    if (url.hostname.endsWith('.sina.com.cn') && /\/(?:roll|stock|chanjing|finance|money|futures|fund)\//u.test(url.pathname)) {
      return true;
    }
    return false;
  }
  catch {
    return false;
  }
};

export const createGoogleNewsRssUrls = (keywords: readonly string[]): readonly string[] => {
  return keywords.map((keyword) => {
    const params = new URLSearchParams({
      q: keyword,
      hl: 'zh-CN',
      gl: 'CN',
      ceid: 'CN:zh-Hans',
    });
    return `https://news.google.com/rss/search?${params.toString()}`;
  });
};

export const parseRssXml = (input: IParseRssXmlInput): readonly INewsSourceArticle[] => {
  const $ = cheerio.load(input.xml, { xmlMode: true });
  const articles: INewsSourceArticle[] = [];
  const requestId = `${input.sourceName}-${input.capturedAt.toISOString()}`;

  $('item').each((_index, element) => {
    const node = $(element);
    const title = toNonEmptyString(node.find('title').first().text());
    const summaryRaw = toNonEmptyString(node.find('description').first().text())
      ?? toNonEmptyString(node.find('content\\:encoded').first().text())
      ?? title;
    const summary = summaryRaw ? stripHtml(summaryRaw) : null;
    const link = toNonEmptyString(node.find('link').first().text())
      ?? toNonEmptyString(node.find('guid').first().text());
    const publishedAt = parsePublishedAt(
      toNonEmptyString(node.find('pubDate').first().text())
      ?? toNonEmptyString(node.find('dc\\:date').first().text()),
      input.capturedAt,
    );

    if (!title || !summary) {
      return;
    }

    const recordId = createRecordId(input.sourceName, input.feedUrl, title, link ?? '', publishedAt);
    articles.push({
      title,
      summary,
      url: ensureUrl(input.sourceName, recordId, link),
      publishedAt,
      capturedAt: input.capturedAt,
      metadata: {
        provider: input.sourceName,
        requestId,
        providerIdentity: input.sourceName,
        source: input.sourceName,
        feedUrl: input.feedUrl,
        recordId,
        contentQuality: summary.length > title.length + 4 ? 'summary' : 'title_only',
      },
    });
  });

  $('entry').each((_index, element) => {
    const node = $(element);
    const title = toNonEmptyString(node.find('title').first().text());
    const summaryRaw = toNonEmptyString(node.find('summary').first().text())
      ?? toNonEmptyString(node.find('content').first().text())
      ?? title;
    const summary = summaryRaw ? stripHtml(summaryRaw) : null;
    const link = toNonEmptyString(node.find('link[rel="alternate"]').first().attr('href'))
      ?? toNonEmptyString(node.find('link').first().attr('href'));
    const publishedAt = parsePublishedAt(
      toNonEmptyString(node.find('published').first().text())
      ?? toNonEmptyString(node.find('updated').first().text()),
      input.capturedAt,
    );

    if (!title || !summary) {
      return;
    }

    const recordId = createRecordId(input.sourceName, input.feedUrl, title, link ?? '', publishedAt);
    articles.push({
      title,
      summary,
      url: ensureUrl(input.sourceName, recordId, link),
      publishedAt,
      capturedAt: input.capturedAt,
      metadata: {
        provider: input.sourceName,
        requestId,
        providerIdentity: input.sourceName,
        source: input.sourceName,
        feedUrl: input.feedUrl,
        recordId,
        contentQuality: summary.length > title.length + 4 ? 'summary' : 'title_only',
      },
    });
  });

  return articles;
};

export const parseSinaFinanceRollHtml = (input: IParseSinaFinanceRollHtmlInput): readonly INewsSourceArticle[] => {
  const $ = cheerio.load(input.html);
  const articles: INewsSourceArticle[] = [];
  const seen = new Set<string>();
  const requestId = `sina-finance-roll-${input.capturedAt.toISOString()}`;

  $('a[href]').each((_index, element) => {
    const node = $(element);
    const title = toNonEmptyString(node.text());
    const rawHref = toNonEmptyString(node.attr('href'));
    if (!title || title.length < 12 || !rawHref) {
      return;
    }

    const url = new URL(rawHref, input.pageUrl).toString();
    if (!isSinaFinanceArticleUrl(url) || seen.has(url)) {
      return;
    }
    seen.add(url);

    const recordId = createRecordId('sina-finance-roll', input.pageUrl, title, url, input.capturedAt);
    articles.push({
      title,
      summary: title,
      url,
      publishedAt: input.capturedAt,
      capturedAt: input.capturedAt,
      metadata: {
        provider: 'sina-finance-roll',
        requestId,
        providerIdentity: 'sina-finance-roll',
        source: 'sina-finance-roll',
        pageUrl: input.pageUrl,
        recordId,
        contentQuality: 'title_only',
        publishedAtSource: 'capturedAt',
      },
    });
  });

  return articles;
};

export class RssNewsSourceAdapter implements IPublicNewsSourceAdapter {
  public readonly name: string;

  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly options: IRssNewsSourceAdapterOptions) {
    this.name = options.name;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async fetch(input: IPublicNewsSourceAdapterFetchInput): Promise<IPublicNewsSourceAdapterResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    const feedResults = await Promise.all(this.options.feeds.map(async (feed) => {
      try {
        const xml = await fetchTextWithSignal(this.fetchImpl, feed.url, controller.signal);
        return {
          articles: parseRssXml({
            xml,
            sourceName: this.name,
            feedUrl: feed.url,
            capturedAt: input.capturedAt,
          }),
          failure: null,
        };
      }
      catch (error) {
        return {
          articles: [],
          failure: `${feed.name}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }));
    clearTimeout(timer);

    const articles = feedResults.flatMap(result => result.articles);
    const failures = feedResults
      .map(result => result.failure)
      .filter((failure): failure is string => failure !== null);

    return {
      articles: articles
        .filter(article => article.publishedAt <= input.asOf)
        .slice(0, input.limit),
      summary: {
        feedCount: this.options.feeds.length,
        failedFeeds: failures,
      },
    };
  }
}

export class GoogleNewsRssSourceAdapter extends RssNewsSourceAdapter {
  public constructor(options: {
    readonly keywords?: readonly string[];
    readonly fetchImpl?: typeof fetch;
  } = {}) {
    super({
      name: 'google-news-rss',
      fetchImpl: options.fetchImpl,
      feeds: createGoogleNewsRssUrls(options.keywords ?? DEFAULT_GOOGLE_NEWS_KEYWORDS)
        .map((url, index) => ({
          name: `google-news-${index + 1}`,
          url,
        })),
    });
  }
}

export class SinaFinanceRollSourceAdapter implements IPublicNewsSourceAdapter {
  public readonly name = 'sina-finance-roll';

  private readonly pageUrl: string;

  private readonly fetchImpl: typeof fetch;

  public constructor(options: ISinaFinanceRollAdapterOptions = {}) {
    this.pageUrl = options.pageUrl ?? DEFAULT_SINA_FINANCE_ROLL_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async fetch(input: IPublicNewsSourceAdapterFetchInput): Promise<IPublicNewsSourceAdapterResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const html = await fetchTextWithSignal(this.fetchImpl, this.pageUrl, controller.signal);
      const articles = parseSinaFinanceRollHtml({
        html,
        pageUrl: this.pageUrl,
        capturedAt: input.capturedAt,
      });
      return {
        articles: articles
          .filter(article => article.publishedAt <= input.asOf)
          .slice(0, input.limit),
        summary: {
          pageUrl: this.pageUrl,
        },
      };
    }
    finally {
      clearTimeout(timer);
    }
  }
}

export class PublicNewsSourceOrchestrator {
  public constructor(private readonly options: IPublicNewsSourceOrchestratorOptions) {}

  public async fetch(input: IPublicNewsSourceFetchInput): Promise<IPublicNewsSourceFetchResult> {
    const mode = input.mode ?? 'expanded';
    const capturedAt = input.capturedAt ?? new Date();
    const sourceStatuses: Record<string, IPublicNewsSourceStatus> = {};

    if (mode === 'baseline') {
      for (const adapter of this.options.adapters) {
        sourceStatuses[adapter.name] = {
          status: 'disabled',
          articleCount: 0,
          elapsedMs: 0,
        };
      }
      return {
        articles: [],
        summary: {
          mode,
          totalArticles: 0,
          sources: sourceStatuses,
        },
      };
    }

    const articles: INewsSourceArticle[] = [];
    for (const adapter of this.options.adapters) {
      const startedAt = Date.now();
      try {
        const result = await adapter.fetch({
          asOf: input.asOf,
          capturedAt,
          timeoutMs: this.options.timeoutMs,
          limit: this.options.perSourceLimit,
        });
        const visibleArticles = result.articles
          .filter(article => article.publishedAt <= input.asOf)
          .slice(0, this.options.perSourceLimit);
        articles.push(...visibleArticles);
        sourceStatuses[adapter.name] = {
          status: 'success',
          articleCount: visibleArticles.length,
          elapsedMs: Date.now() - startedAt,
          summary: result.summary,
        };
      }
      catch (error) {
        sourceStatuses[adapter.name] = {
          status: 'failed',
          articleCount: 0,
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const dedupedArticles = this.deduplicate(articles);
    return {
      articles: dedupedArticles,
      summary: {
        mode,
        totalArticles: dedupedArticles.length,
        sources: sourceStatuses,
      },
    };
  }

  private deduplicate(articles: readonly INewsSourceArticle[]): readonly INewsSourceArticle[] {
    const seen = new Set<string>();
    const deduped: INewsSourceArticle[] = [];
    for (const article of articles) {
      const key = article.url || `${article.title}:${article.publishedAt.toISOString()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(article);
    }
    return deduped;
  }
}

export const createDefaultPublicNewsSourceOrchestrator = (options: {
  readonly timeoutMs?: number;
  readonly perSourceLimit?: number;
  readonly fetchImpl?: typeof fetch;
} = {}): PublicNewsSourceOrchestrator => {
  return new PublicNewsSourceOrchestrator({
    timeoutMs: options.timeoutMs ?? DEFAULT_PUBLIC_NEWS_TIMEOUT_MS,
    perSourceLimit: options.perSourceLimit ?? DEFAULT_PUBLIC_NEWS_SOURCE_LIMIT,
    adapters: [
      new SinaFinanceRollSourceAdapter({
        fetchImpl: options.fetchImpl,
      }),
      new RssNewsSourceAdapter({
        name: 'sina-rss',
        feeds: DEFAULT_SINA_RSS_FEEDS,
        fetchImpl: options.fetchImpl,
      }),
      new GoogleNewsRssSourceAdapter({
        fetchImpl: options.fetchImpl,
      }),
    ],
  });
};
