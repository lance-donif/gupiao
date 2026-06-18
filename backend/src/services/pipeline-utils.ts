import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { AkToolsHttpNewsProvider } from './tavily-news-provider.js';
import { createProviderRequestMetadata } from '../sources/index.js';
import { DataRefreshLedgerService, buildBeijingMinuteBucketKey } from './data-refresh-ledger-service.js';
import { fetchNewsNowToFile } from '../../scripts/fetch-newsnow.js';
import type { INormalizedNewsCandidate } from './news-ingest-pipeline.js';
import type { INewsSourceArticle } from '../sources/contracts.js';
import type { PublicNewsSourceMode } from './public-news-source-orchestrator.js';
import { createDefaultPublicNewsSourceOrchestrator } from './public-news-source-orchestrator.js';
import { dateKey } from '../lib/date-utils.js';

const DEFAULT_AKTOOLS_BASE_URL = process.env.AKTOOLS_BASE_URL ?? 'http://127.0.0.1:8010';
const NEWS_FETCH_CACHE_BUCKET_MINUTES = 15;
const NEWS_FETCH_CACHE_TTL_MS = NEWS_FETCH_CACHE_BUCKET_MINUTES * 60 * 1000;
const SCORING_EXPOSURE_SOURCES = [
  'tickflow_sw_universe',
  'akshare_industry_board_em',
  'akshare_concept_board_em',
  'akshare_individual_info_em',
  'manual_verified',
  'test_exposure',
];
const SCORING_EXPOSURE_TYPES = [
  'industry_exposure',
  'concept_exposure',
  'business_exposure',
  'company_profile_exposure',
];

export interface INewsNowItem {
  readonly title?: string;
  readonly summary?: string;
  readonly content?: string;
  readonly url?: string;
  readonly sourceDomain?: string;
  readonly category?: string;
}

export interface INewsNowPayload {
  readonly fetchedAt?: string;
  readonly news?: readonly INewsNowItem[];
}

export interface IDailyArticle {
  readonly title: string;
  readonly summary: string;
  readonly url: string;
  readonly publishedAt: Date;
  readonly capturedAt: Date;
  readonly metadata: Record<string, unknown>;
}

export interface INewsInput {
  readonly articles: readonly IDailyArticle[];
  readonly sourceMode: 'live' | 'replay';
  readonly sourceSummary: Record<string, unknown>;
}

export interface IStockExposureVerificationResult {
  readonly factCount: number;
  readonly symbolCount: number;
  readonly keywordCount: number;
  readonly minExposureFacts: number;
  readonly sample: readonly Record<string, unknown>[];
}

export interface IAktoolsNewsFetchSummary {
  readonly articles: readonly {
    readonly title: string;
    readonly summary: string;
    readonly url: string;
    readonly publishedAt: string;
    readonly metadata: Record<string, unknown>;
  }[];
  readonly breakdown: Record<string, number>;
  readonly totalArticles: number;
}

export interface INewsNowFetchSummary {
  readonly articles: readonly {
    readonly title: string;
    readonly summary: string;
    readonly url: string;
    readonly publishedAt: string;
    readonly metadata: Record<string, unknown>;
  }[];
  readonly newsFile: string;
  readonly totalArticles: number;
  readonly withContentCount: number;
  readonly breakdown: Record<string, number>;
}

export interface IPublicNewsFetchSummary {
  readonly articles: readonly {
    readonly title: string;
    readonly summary: string;
    readonly url: string;
    readonly publishedAt: string;
    readonly metadata: Record<string, unknown>;
  }[];
  readonly totalArticles: number;
  readonly sourceSummary: Record<string, unknown>;
}

export type StopAfterStage = 'none' | 'dedup';

export class PipelineStopError extends Error {
  public constructor(
    public readonly failedStep: string,
    message: string,
  ) {
    super(message);
    this.name = 'PipelineStopError';
  }
}

export const getBeijingDateKey = (date: Date): string => {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
};

export const createTraceId = (asOf: Date, clusterKey: string): string => {
  const suffix = crypto.randomBytes(4).toString('hex');
  return `daily-${clusterKey}-${dateKey(asOf)}-${suffix}`;
};

const createStableNewsRecordId = (
  source: string,
  title: string,
  summary: string,
  url: string,
  publishedAt: Date,
): string => {
  const digest = crypto
    .createHash('sha1')
    .update([
      source,
      publishedAt.toISOString(),
      url,
      title,
      summary,
    ].join('\n'))
    .digest('hex')
    .slice(0, 20);
  return `${source}:${digest}`;
};

export const getStopAfter = (raw: string | undefined): StopAfterStage => {
  if (raw === undefined || raw === 'none') {
    return 'none';
  }
  if (raw === 'dedup') {
    return raw;
  }
  throw new Error(`Invalid --stop-after: ${raw}. Supported values: dedup`);
};

export const getPositiveIntegerOption = (
  args: Readonly<Record<string, string>>,
  cliName: string,
  envName: string,
): number => {
  const raw = args[cliName] ?? process.env[envName];
  if (!raw || !/^\d+$/u.test(raw.trim())) {
    throw new Error(`Missing or invalid --${cliName}/${envName}: expected a positive integer`);
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Missing or invalid --${cliName}/${envName}: expected a positive integer`);
  }

  return parsed;
};

export const getOptionalPositiveInteger = (
  args: Readonly<Record<string, string>>,
  cliName: string,
  envName: string,
  fallback: number,
): number => {
  const raw = args[cliName] ?? process.env[envName];
  if (!raw) {
    return fallback;
  }
  if (!/^\d+$/u.test(raw.trim())) {
    throw new Error(`Invalid --${cliName}/${envName}: expected a positive integer`);
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${cliName}/${envName}: expected a positive integer`);
  }
  return parsed;
};

export const getNewsSourceMode = (
  args: Readonly<Record<string, string>>,
): PublicNewsSourceMode => {
  const raw = args['news-source-mode'] ?? process.env.NEWS_SOURCE_MODE ?? 'expanded';
  if (raw === 'baseline' || raw === 'expanded') {
    return raw;
  }
  throw new Error(`Invalid --news-source-mode/NEWS_SOURCE_MODE: ${raw}. Supported values: baseline, expanded`);
};

const loadNewsNowArticles = async (filePath: string, asOf: Date): Promise<readonly IDailyArticle[]> => {
  const payload = JSON.parse(await readFile(filePath, 'utf8')) as INewsNowPayload;
  const fetchedAt = payload.fetchedAt ? new Date(payload.fetchedAt) : asOf;
  const publishedAt = Number.isNaN(fetchedAt.getTime()) || fetchedAt > asOf ? asOf : fetchedAt;

  return (payload.news ?? []).flatMap((item, index): IDailyArticle[] => {
    const title = item.title?.trim() ?? '';
    const summary = (item.content?.trim() || item.summary?.trim() || title);
    const url = item.url?.trim() || `newsnow://local/${index + 1}`;
    if (!title || !summary) {
      return [];
    }
    return [{
      title,
      summary,
      url,
      publishedAt,
      capturedAt: asOf,
      metadata: {
        provider: 'newsnow',
        source: item.sourceDomain ?? 'newsnow',
        category: item.category ?? 'unknown',
        contentQuality: item.content?.trim() ? 'content' : 'title_only',
        publishedAtSource: 'fetchedAt',
        recordId: `newsnow:${crypto.createHash('sha1').update(`${url}:${title}`).digest('hex')}`,
        sourceFile: filePath,
      },
    }];
  });
};

const fetchAkToolsArticles = async (asOf: Date): Promise<{
  readonly articles: readonly IDailyArticle[];
  readonly breakdown: Record<string, number>;
}> => {
  const provider = new AkToolsHttpNewsProvider({
    baseUrl: DEFAULT_AKTOOLS_BASE_URL,
    maxResults: 10000,
  });
  const result = await provider.executeAsync(
    { query: '', asOf, timeWindow: { start: asOf, end: asOf } },
    createProviderRequestMetadata(),
  );

  if (result.status !== 'success') {
    throw new Error(result.failure.message);
  }

  const breakdown: Record<string, number> = {};
  const articles = result.payload.items.map((item) => {
    const source = String(item.providerMetadata?.source ?? 'aktools');
    breakdown[source] = (breakdown[source] ?? 0) + 1;
    const publishedAt = new Date(item.publishedAt);
    const url = item.url || `aktools://${item.id}`;
    return {
      title: item.title,
      summary: item.summary,
      url,
      publishedAt,
      capturedAt: new Date(item.capturedAt),
      metadata: {
        ...(item.providerMetadata ?? {}),
        provider: 'aktools',
        requestId: result.metadata.requestId,
        providerIdentity: result.metadata.providerIdentity,
        sourceRecordId: item.id,
        recordId: createStableNewsRecordId(source, item.title, item.summary, url, publishedAt),
        capturedAt: item.capturedAt,
        contentQuality: 'summary',
      },
    } satisfies IDailyArticle;
  });

  return {
    articles,
    breakdown,
  };
};

const serializeArticles = (articles: readonly IDailyArticle[]): IAktoolsNewsFetchSummary['articles'] => {
  return articles.map(article => ({
    title: article.title,
    summary: article.summary,
    url: article.url,
    publishedAt: article.publishedAt.toISOString(),
    metadata: article.metadata,
  }));
};

const deserializeArticles = (
  rows: readonly IAktoolsNewsFetchSummary['articles'][number][],
): readonly IDailyArticle[] => {
  return rows.map((row) => {
    const publishedAt = new Date(row.publishedAt);
    const source = String(row.metadata?.source ?? row.metadata?.provider ?? 'aktools');
    return {
      title: row.title,
      summary: row.summary,
      url: row.url,
      publishedAt,
      capturedAt: new Date(),
      metadata: {
        ...row.metadata,
        sourceRecordId: typeof row.metadata?.recordId === 'string' ? row.metadata.recordId : row.metadata?.sourceRecordId,
        recordId: createStableNewsRecordId(source, row.title, row.summary, row.url, publishedAt),
      },
    };
  });
};

const resolveAkToolsNewsWithCache = async (
  prisma: any,
  traceId: string,
  clusterKey: string,
  asOf: Date,
  bucketKey: string,
): Promise<{
  readonly articles: readonly IDailyArticle[];
  readonly summary: Record<string, unknown>;
  readonly cacheHit: boolean;
}> => {
  const ledger = new DataRefreshLedgerService();
  const result = await ledger.withLedgerCache<IAktoolsNewsFetchSummary>(prisma, {
    dataKind: 'news_fetch',
    source: 'aktools',
    clusterKey,
    bucketKey,
    now: asOf,
    ttlMs: NEWS_FETCH_CACHE_TTL_MS,
    traceId,
    loader: async () => {
      const fetched = await fetchAkToolsArticles(asOf);
      if (fetched.articles.length === 0) {
        throw new Error('AKTools 获取结果为空');
      }
      return {
        articles: serializeArticles(fetched.articles),
        breakdown: fetched.breakdown,
        totalArticles: fetched.articles.length,
      };
    },
  });
  const articles = deserializeArticles(result.summary.articles);
  return {
    articles,
    cacheHit: result.cacheHit,
    summary: {
      cacheHit: result.cacheHit,
      bucketKey,
      ttlMinutes: NEWS_FETCH_CACHE_BUCKET_MINUTES,
      baseUrl: DEFAULT_AKTOOLS_BASE_URL,
      totalArticles: articles.length,
      breakdown: result.summary.breakdown,
    },
  };
};

const resolveNewsNowWithCache = async (
  prisma: any,
  traceId: string,
  clusterKey: string,
  asOf: Date,
  bucketKey: string,
): Promise<{
  readonly articles: readonly IDailyArticle[];
  readonly summary: Record<string, unknown>;
  readonly cacheHit: boolean;
}> => {
  const ledger = new DataRefreshLedgerService();
  const result = await ledger.withLedgerCache<INewsNowFetchSummary>(prisma, {
    dataKind: 'news_fetch',
    source: 'newsnow',
    clusterKey,
    bucketKey,
    now: asOf,
    ttlMs: NEWS_FETCH_CACHE_TTL_MS,
    traceId,
    loader: async () => {
      const newsNowResult = await fetchNewsNowToFile(path.resolve(process.cwd(), 'tmp'));
      const newsNowArticles = await loadNewsNowArticles(newsNowResult.filePath, asOf);
      if (newsNowArticles.length === 0) {
        throw new Error('NewsNow 获取结果为空');
      }
      return {
        articles: serializeArticles(newsNowArticles),
        newsFile: newsNowResult.filePath,
        totalArticles: newsNowArticles.length,
        withContentCount: newsNowResult.withContentCount,
        breakdown: newsNowResult.sourcesBreakdown,
      };
    },
  });
  const articles = deserializeArticles(result.summary.articles);
  return {
    articles,
    cacheHit: result.cacheHit,
    summary: {
      cacheHit: result.cacheHit,
      bucketKey,
      ttlMinutes: NEWS_FETCH_CACHE_BUCKET_MINUTES,
      newsFile: result.summary.newsFile,
      totalArticles: articles.length,
      withContentCount: result.summary.withContentCount,
      breakdown: result.summary.breakdown,
    },
  };
};

const resolvePublicNewsWithCache = async (
  prisma: any,
  args: Record<string, string>,
  traceId: string,
  clusterKey: string,
  asOf: Date,
  bucketKey: string,
): Promise<{
  readonly articles: readonly IDailyArticle[];
  readonly summary: Record<string, unknown>;
  readonly cacheHit: boolean;
}> => {
  const mode = getNewsSourceMode(args);
  const timeoutMs = getOptionalPositiveInteger(args, 'public-news-timeout-ms', 'PUBLIC_NEWS_TIMEOUT_MS', 12_000);
  const perSourceLimit = getOptionalPositiveInteger(args, 'public-news-source-limit', 'PUBLIC_NEWS_SOURCE_LIMIT', 300);
  const ledger = new DataRefreshLedgerService();
  const result = await ledger.withLedgerCache<IPublicNewsFetchSummary>(prisma, {
    dataKind: 'news_fetch',
    source: 'public-news',
    clusterKey,
    bucketKey,
    now: asOf,
    ttlMs: NEWS_FETCH_CACHE_TTL_MS,
    traceId,
    loader: async () => {
      const orchestrator = createDefaultPublicNewsSourceOrchestrator({
        timeoutMs,
        perSourceLimit,
      });
      const publicNewsResult = await orchestrator.fetch({
        asOf,
        capturedAt: asOf,
        mode,
      });
      return {
        articles: serializeArticles(publicNewsResult.articles.map(article => ({
          title: article.title,
          summary: article.summary,
          url: article.url,
          publishedAt: article.publishedAt,
          capturedAt: article.capturedAt,
          metadata: article.metadata as Record<string, unknown>,
        }))),
        totalArticles: publicNewsResult.articles.length,
        sourceSummary: publicNewsResult.summary as unknown as Record<string, unknown>,
      };
    },
  });
  const articles = deserializeArticles(result.summary.articles);
  return {
    articles,
    cacheHit: result.cacheHit,
    summary: {
      cacheHit: result.cacheHit,
      bucketKey,
      ttlMinutes: NEWS_FETCH_CACHE_BUCKET_MINUTES,
      mode,
      timeoutMs,
      perSourceLimit,
      totalArticles: articles.length,
      sourceSummary: result.summary.sourceSummary,
    },
  };
};

export const resolveNewsInput = async (
  prisma: any,
  args: Record<string, string>,
  traceId: string,
  clusterKey: string,
  asOf: Date,
): Promise<INewsInput> => {
  if (args['news-file']) {
    if (args.mode !== 'replay') {
      throw new PipelineStopError(
        'news_fetch',
        '指定 --news-file 时必须同时指定 --mode replay；今日推荐默认不允许用缓存绕过实时新闻采集失败',
      );
    }
    const newsFile = path.resolve(args['news-file']);
    const replayArticles = await loadNewsNowArticles(newsFile, asOf);
    return {
      articles: replayArticles,
      sourceMode: 'replay',
      sourceSummary: {
        newsFile,
        totalArticles: replayArticles.length,
      },
    };
  }

  try {
    const bucketKey = buildBeijingMinuteBucketKey(asOf, NEWS_FETCH_CACHE_BUCKET_MINUTES);
    const [aktoolsResult, newsNowResult, publicNewsResult] = await Promise.all([
      resolveAkToolsNewsWithCache(prisma, traceId, clusterKey, asOf, bucketKey),
      resolveNewsNowWithCache(prisma, traceId, clusterKey, asOf, bucketKey),
      resolvePublicNewsWithCache(prisma, args, traceId, clusterKey, asOf, bucketKey),
    ]);

    if (aktoolsResult.articles.length === 0) {
      throw new Error('AKTools 获取结果为空');
    }
    if (newsNowResult.articles.length === 0) {
      throw new Error('NewsNow 获取结果为空');
    }

    return {
      articles: [...aktoolsResult.articles, ...newsNowResult.articles, ...publicNewsResult.articles],
      sourceMode: 'live',
      sourceSummary: {
        cachePolicy: {
          bucketKey,
          ttlMinutes: NEWS_FETCH_CACHE_BUCKET_MINUTES,
          requiredSources: ['aktools', 'newsnow'],
          optionalSources: ['sina-finance-roll', 'sina-rss', 'google-news-rss'],
          newsSourceMode: getNewsSourceMode(args),
        },
        aktools: aktoolsResult.summary,
        newsnow: newsNowResult.summary,
        publicNews: publicNewsResult.summary,
        totalArticles: aktoolsResult.articles.length + newsNowResult.articles.length + publicNewsResult.articles.length,
      },
    };
  }
  catch (error) {
    throw new PipelineStopError(
      'news_fetch',
      `实时新闻获取失败，严格单向流程停止：${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const toCandidateArticles = (articles: readonly IDailyArticle[]): readonly INewsSourceArticle[] => {
  return articles.map(article => ({
    title: article.title,
    summary: article.summary,
    url: article.url,
    publishedAt: article.publishedAt,
    capturedAt: article.capturedAt,
    metadata: {
      provider: String(article.metadata.provider ?? article.metadata.source ?? 'unknown'),
      requestId: String(article.metadata.requestId ?? 'run-daily-recommendation'),
      providerIdentity: String(article.metadata.providerIdentity ?? article.metadata.provider ?? article.metadata.source ?? 'unknown'),
      ...article.metadata,
    },
  }));
};

export const persistNews = async (
  prisma: any,
  articles: readonly IDailyArticle[],
  candidates: readonly INormalizedNewsCandidate[],
  clusterKey: string,
): Promise<void> => {
  const rawRows = articles.map(article => ({
    title: article.title,
    content: article.summary,
    source: String(article.metadata.source ?? article.metadata.provider ?? 'newsnow-cache'),
    url: article.url,
    publishedAt: article.publishedAt,
    clusterKey,
    rawMetadata: article.metadata,
    titleHash: crypto.createHash('sha256').update(article.title).digest('hex'),
  }));
  if (rawRows.length > 0) {
    await prisma.rawNewsRecord.createMany({ data: rawRows, skipDuplicates: true });
  }

  const normalizedRows = candidates.map(candidate => ({
    id: candidate.id,
    title: candidate.title,
    content: candidate.content,
    source: candidate.source,
    url: candidate.url,
    publishedAt: candidate.publishedAt,
    clusterKey,
    reprintGroupId: candidate.reprintGroupId ?? candidate.id,
    reprintWeight: new Prisma.Decimal(candidate.reprintWeight ?? 1.0),
  }));
  if (normalizedRows.length > 0) {
    await prisma.normalizedNewsRecord.createMany({ data: normalizedRows, skipDuplicates: true });
  }
};

export const verifyStockExposureFacts = async (
  prisma: any,
  clusterKey: string,
  asOf: Date,
  minExposureFacts: number,
): Promise<IStockExposureVerificationResult> => {
  const activeScoringFactWhere = {
    clusterKey,
    status: 'active',
    source: { in: SCORING_EXPOSURE_SOURCES },
    exposureType: { in: SCORING_EXPOSURE_TYPES },
    validFrom: { lte: asOf },
    OR: [
      { validTo: null },
      { validTo: { gte: asOf } },
    ],
  };
  const [factCount, symbolCountRows, keywordCountRows, sample] = await Promise.all([
    prisma.stockExposureFact.count({
      where: activeScoringFactWhere,
    }),
    prisma.stockExposureFact.groupBy({
      by: ['symbol'],
      where: activeScoringFactWhere,
      _count: { _all: true },
    }),
    prisma.stockExposureFact.groupBy({
      by: ['keyword'],
      where: activeScoringFactWhere,
      _count: { _all: true },
    }),
    prisma.stockExposureFact.findMany({
      where: activeScoringFactWhere,
      orderBy: [
        { taxonomyLevel: 'desc' },
        { confidence: 'desc' },
      ],
      take: 10,
    }),
  ]);

  return {
    factCount,
    symbolCount: symbolCountRows.length,
    keywordCount: keywordCountRows.length,
    minExposureFacts,
    sample,
  };
};
