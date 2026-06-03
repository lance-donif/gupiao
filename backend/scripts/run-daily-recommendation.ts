import type { INormalizedNewsCandidate } from '../src/services/news-ingest-pipeline.js';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import pg from 'pg';

import { BacktestEngine } from '../src/services/backtest-engine.js';
import {
  CausalSignalExtractionService,
  createCausalSignalExtractorFromEnv,
} from '../src/services/causal-signal-extraction-service.js';
import { AkToolsStockExposureService } from '../src/services/aktools-stock-exposure-service.js';
import {
  buildBeijingMinuteBucketKey,
  DataRefreshLedgerService,
} from '../src/services/data-refresh-ledger-service.js';
import { createFriendNetworkEngine } from '../src/services/friend-network-engine.js';
import { KeywordPerformancePenaltyService } from '../src/services/keyword-performance-penalty-service.js';
import {
  NewsIngestDeduplicationPipeline,
  NewsIngestNormalizationPipeline,
} from '../src/services/news-ingest-pipeline.js';
import {
  createDefaultPublicNewsSourceOrchestrator,
  type PublicNewsSourceMode,
} from '../src/services/public-news-source-orchestrator.js';
import { loadBackendEnv } from '../src/services/load-backend-env.js';
import { AkToolsHttpNewsProvider } from '../src/services/tavily-news-provider.js';
import { createTickFlowStockExposureServiceFromEnv } from '../src/services/tickflow-stock-exposure-service.js';
import { TraceManager } from '../src/services/trace-manager.js';
import { StrategyExperimentRunner } from '../src/services/strategy-runner.js';
import type { INewsSourceArticle } from '../src/sources/contracts.js';
import { createProviderRequestMetadata } from '../src/sources/index.js';
import { fetchNewsNowToFile } from './fetch-newsnow.js';

loadBackendEnv();

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://gupiao:password@localhost:5432/gupiaodb';
const DEFAULT_CLUSTER_KEY = 'global';
const DEFAULT_LIMIT = 30;
const DEFAULT_MAX_PER_INDUSTRY = 5;
const DEFAULT_AKTOOLS_BASE_URL = process.env.AKTOOLS_BASE_URL ?? 'http://127.0.0.1:8010';
const DEFAULT_MIN_EXPOSURE_FACTS = process.env.TICKFLOW_API_KEY ? 500 : 100;
const DEFAULT_TICKFLOW_REFRESH_INTERVAL_DAYS = 30;
const DEFAULT_CAUSAL_SIGNAL_BATCH_SIZE = 50;
const NEWS_FETCH_CACHE_BUCKET_MINUTES = 15;
const NEWS_FETCH_CACHE_TTL_MS = NEWS_FETCH_CACHE_BUCKET_MINUTES * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TICKFLOW_SW_UNIVERSE_SOURCE = 'tickflow_sw_universe';
const SCORING_EXPOSURE_SOURCES = [
  TICKFLOW_SW_UNIVERSE_SOURCE,
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

interface INewsNowItem {
  readonly title?: string;
  readonly summary?: string;
  readonly content?: string;
  readonly url?: string;
  readonly sourceDomain?: string;
  readonly category?: string;
}

interface INewsNowPayload {
  readonly fetchedAt?: string;
  readonly news?: readonly INewsNowItem[];
}

interface IDailyArticle {
  readonly title: string;
  readonly summary: string;
  readonly url: string;
  readonly publishedAt: Date;
  readonly capturedAt: Date;
  readonly metadata: Record<string, unknown>;
}

interface INewsInput {
  readonly articles: readonly IDailyArticle[];
  readonly sourceMode: 'live' | 'replay';
  readonly sourceSummary: Record<string, unknown>;
}

interface IStockExposureVerificationResult {
  readonly factCount: number;
  readonly symbolCount: number;
  readonly keywordCount: number;
  readonly minExposureFacts: number;
  readonly sample: readonly Record<string, unknown>[];
}

interface IStockExposureFreshnessResult {
  readonly source: typeof TICKFLOW_SW_UNIVERSE_SOURCE;
  readonly refreshIntervalDays: number;
  readonly minExposureFacts: number;
  readonly activeFactCount: number;
  readonly activeSymbolCount: number;
  readonly latestValidFrom: string | null;
  readonly ageDays: number | null;
  readonly isFresh: boolean;
}

interface ITickFlowExposureSyncService {
  sync: (
    prisma: any,
    input: {
      readonly traceId: string;
      readonly asOf: Date;
      readonly clusterKey: string;
      readonly stockNameBySymbol: ReadonlyMap<string, string>;
      readonly universeLimit?: number;
    },
  ) => Promise<unknown>;
}

interface IAktoolsNewsFetchSummary {
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

interface INewsNowFetchSummary {
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

interface IPublicNewsFetchSummary {
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

interface IDiagnosticQuery {
  readonly label: string;
  readonly sql: string;
  readonly values?: readonly unknown[];
}

type StopAfterStage = 'none' | 'dedup';

class PipelineStopError extends Error {
  public constructor(
    public readonly failedStep: string,
    message: string,
  ) {
    super(message);
    this.name = 'PipelineStopError';
  }
}

const parseArgs = (): Record<string, string> => {
  const parsed: Record<string, string> = {};
  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    parsed[token.slice(2)] = process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
      ? process.argv[++index]
      : 'true';
  }
  return parsed;
};

const getAsOf = (raw: string | undefined): Date => {
  const asOf = new Date(raw ?? Date.now());
  if (Number.isNaN(asOf.getTime())) {
    throw new Error(`Invalid --as-of: ${raw}`);
  }
  return asOf;
};

const getBeijingDateKey = (date: Date): string => {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
};

const publishLatestSnapshot = async (
  prisma: PrismaClient,
  input: {
    readonly clusterKey: string;
    readonly asOf: Date;
    readonly limit: number;
  },
): Promise<Record<string, unknown>> => {
  const beijingDate = getBeijingDateKey(input.asOf);
  const startOfBeijingDay = new Date(`${beijingDate}T00:00:00.000+08:00`);
  const endOfBeijingDay = new Date(`${beijingDate}T23:59:59.999+08:00`);

  const traceRows = await prisma.runTrace.findMany({
    where: {
      clusterKey: input.clusterKey,
      kind: 'DAILY_RECOMMENDATION',
      status: 'SUCCESS',
      asOf: {
        gte: startOfBeijingDay,
        lte: endOfBeijingDay,
      },
    },
    orderBy: { completedAt: 'desc' },
    take: 10,
  });

  for (const trace of traceRows) {
    const recommendationCount = await prisma.recommendationSnapshot.count({
      where: { traceId: trace.traceId },
    });
    if (recommendationCount > 0) {
      return {
        status: 'PUBLISHED',
        beijingDate,
        traceId: trace.traceId,
        recommendationCount,
        requestedLimit: input.limit,
        asOf: trace.asOf.toISOString(),
        completedAt: trace.completedAt?.toISOString() ?? null,
      };
    }
  }

  throw new PipelineStopError(
    'publish_snapshot',
    `没有找到 ${beijingDate} 的成功 DAILY_RECOMMENDATION 快照，停止发布`,
  );
};

const getStopAfter = (raw: string | undefined): StopAfterStage => {
  if (raw === undefined || raw === 'none') {
    return 'none';
  }
  if (raw === 'dedup') {
    return raw;
  }
  throw new Error(`Invalid --stop-after: ${raw}. Supported values: dedup`);
};


const getPositiveIntegerOption = (
  args: Readonly<Record<string, string>>,
  cliName: 'aktools-board-limit' | 'aktools-symbol-limit',
  envName: 'AKTOOLS_BOARD_LIMIT' | 'AKTOOLS_SYMBOL_LIMIT',
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

const getOptionalPositiveInteger = (
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

const getNewsSourceMode = (
  args: Readonly<Record<string, string>>,
): PublicNewsSourceMode => {
  const raw = args['news-source-mode'] ?? process.env.NEWS_SOURCE_MODE ?? 'expanded';
  if (raw === 'baseline' || raw === 'expanded') {
    return raw;
  }
  throw new Error(`Invalid --news-source-mode/NEWS_SOURCE_MODE: ${raw}. Supported values: baseline, expanded`);
};

const createTraceId = (asOf: Date, clusterKey: string): string => {
  const dateKey = asOf.toISOString().slice(0, 10);
  const suffix = crypto.randomBytes(4).toString('hex');
  return `daily-${clusterKey}-${dateKey}-${suffix}`;
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

const resolveNewsInput = async (
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

const toCandidateArticles = (articles: readonly IDailyArticle[]): readonly INewsSourceArticle[] => {
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

const persistNews = async (
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

const verifyStockExposureFacts = async (
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
    sample: sample.map((row: any) => ({
      symbol: row.symbol,
      stockName: row.stockName,
      keyword: row.keyword,
      exposureType: row.exposureType,
      taxonomyLevel: row.taxonomyLevel,
      source: row.source,
      sourceId: row.sourceId,
      confidence: row.confidence?.toString?.() ?? row.confidence,
      memberCount: row.memberCount,
    })),
  };
};

const getTickFlowExposureFreshness = async (
  prisma: any,
  clusterKey: string,
  asOf: Date,
  minExposureFacts: number,
  refreshIntervalDays: number,
): Promise<IStockExposureFreshnessResult> => {
  const activeTickFlowWhere = {
    clusterKey,
    status: 'active',
    source: TICKFLOW_SW_UNIVERSE_SOURCE,
    exposureType: 'industry_exposure',
    validFrom: { lte: asOf },
    OR: [
      { validTo: null },
      { validTo: { gte: asOf } },
    ],
  };
  const [activeFactCount, symbolRows, latest] = await Promise.all([
    prisma.stockExposureFact.count({ where: activeTickFlowWhere }),
    prisma.stockExposureFact.groupBy({
      by: ['symbol'],
      where: activeTickFlowWhere,
      _count: { _all: true },
    }),
    prisma.stockExposureFact.aggregate({
      where: activeTickFlowWhere,
      _max: { validFrom: true },
    }),
  ]);
  const latestValidFromRaw = latest?._max?.validFrom;
  const latestValidFrom = latestValidFromRaw instanceof Date ? latestValidFromRaw : null;
  const ageMs = latestValidFrom ? Math.max(0, asOf.getTime() - latestValidFrom.getTime()) : null;
  const ageDays = ageMs === null ? null : Number((ageMs / ONE_DAY_MS).toFixed(2));
  const refreshIntervalMs = refreshIntervalDays * ONE_DAY_MS;

  return {
    source: TICKFLOW_SW_UNIVERSE_SOURCE,
    refreshIntervalDays,
    minExposureFacts,
    activeFactCount,
    activeSymbolCount: symbolRows.length,
    latestValidFrom: latestValidFrom?.toISOString() ?? null,
    ageDays,
    isFresh: latestValidFrom !== null
      && activeFactCount >= minExposureFacts
      && ageMs !== null
      && ageMs <= refreshIntervalMs,
  };
};

export const syncAndVerifyStockExposureFacts = async (input: {
  readonly prisma: any;
  readonly traceId: string;
  readonly clusterKey: string;
  readonly asOf: Date;
  readonly minExposureFacts: number;
  readonly tickFlowRefreshIntervalDays?: number;
  readonly stockNameBySymbol: ReadonlyMap<string, string>;
  readonly syncService: ITickFlowExposureSyncService;
}): Promise<{
  readonly syncResult: unknown;
  readonly exposureResult: IStockExposureVerificationResult;
}> => {
  const refreshIntervalDays = input.tickFlowRefreshIntervalDays ?? DEFAULT_TICKFLOW_REFRESH_INTERVAL_DAYS;
  const freshnessBefore = await getTickFlowExposureFreshness(
    input.prisma,
    input.clusterKey,
    input.asOf,
    input.minExposureFacts,
    refreshIntervalDays,
  );
  let syncResult: unknown;
  if (freshnessBefore.isFresh) {
    syncResult = {
      mode: 'skip_fresh_monthly_cache',
      skippedSync: true,
      reason: 'tickflow_sw_universe_fresh_enough',
      freshnessBefore,
    };
  }
  else {
    const upstreamSyncResult = await input.syncService.sync(input.prisma, {
      traceId: input.traceId,
      asOf: input.asOf,
      clusterKey: input.clusterKey,
      stockNameBySymbol: input.stockNameBySymbol,
    });
    const freshnessAfter = await getTickFlowExposureFreshness(
      input.prisma,
      input.clusterKey,
      input.asOf,
      input.minExposureFacts,
      refreshIntervalDays,
    );
    syncResult = {
      mode: 'synced_stale_or_insufficient',
      skippedSync: false,
      refreshIntervalDays,
      freshnessBefore,
      freshnessAfter,
      upstreamSyncResult,
    };
  }
  const exposureResult = await verifyStockExposureFacts(
    input.prisma,
    input.clusterKey,
    input.asOf,
    input.minExposureFacts,
  );
  return { syncResult, exposureResult };
};

const CHINESE_TEXT_PATTERN = /[\u3400-\u9FFF]/u;

const trustedStockNameSources = new Set([
  'tickflow_sw_universe',
  'akshare_industry_board_em',
  'akshare_concept_board_em',
  'akshare_individual_info_em',
  'manual_verified',
  'test_exposure',
]);

const stockNameFactRank = (row: { source?: string | null; taxonomyLevel?: string | null; confidence?: unknown }): number => {
  const source = String(row.source ?? '');
  const taxonomyLevel = String(row.taxonomyLevel ?? '').toUpperCase();
  if (!trustedStockNameSources.has(source)) {
    return -1;
  }
  if (source === 'tickflow_sw_universe') {
    if (taxonomyLevel === 'SW3') {
      return 100;
    }
    if (taxonomyLevel === 'SW2') {
      return 90;
    }
    if (taxonomyLevel === 'SW1') {
      return 80;
    }
    return 70;
  }
  if (source === 'akshare_industry_board_em') {
    return 75;
  }
  if (source === 'akshare_concept_board_em') {
    return 65;
  }
  if (source === 'akshare_individual_info_em') {
    return 55;
  }
  return 40;
};

const createStockNameMap = async (prisma: PrismaClient, clusterKey: string): Promise<Map<string, string>> => {
  const stocks = await prisma.stock.findMany({
    where: { clusterKey },
    select: {
      symbol: true,
      name: true,
    },
  });

  const result = new Map<string, string>();
  for (const stock of stocks) {
    if (/^\d{6}$/u.test(stock.symbol) && stock.name.trim().length > 0) {
      result.set(stock.symbol, stock.name);
    }
  }

  const trustedNameFacts = await prisma.stockExposureFact.findMany({
    where: {
      clusterKey,
      status: 'active',
      source: { in: [...trustedStockNameSources] },
    },
    select: {
      symbol: true,
      stockName: true,
      source: true,
      taxonomyLevel: true,
      confidence: true,
    },
  });
  const sortedNameFacts = trustedNameFacts
    .filter(row => /^\d{6}$/u.test(row.symbol) && CHINESE_TEXT_PATTERN.test(row.stockName))
    .sort((left, right) => {
      return stockNameFactRank(right) - stockNameFactRank(left)
        || Number(right.confidence ?? 0) - Number(left.confidence ?? 0);
    });
  for (const row of sortedNameFacts) {
    if (CHINESE_TEXT_PATTERN.test(result.get(row.symbol) ?? '')) {
      continue;
    }
    result.set(row.symbol, row.stockName);
  }
  return result;
};

const persistGraphSnapshot = async (
  prisma: any,
  traceId: string,
  asOf: Date,
  clusterKey: string,
  candidates: readonly INormalizedNewsCandidate[],
): Promise<{ nodeCount: number; edgeCount: number }> => {
  const engine = createFriendNetworkEngine();
  const result = await engine.run({
    cluster: clusterKey,
    sourceNewsFilePath: 'database:NormalizedNewsRecord',
    asOf,
    newsItems: candidates.map(candidate => ({
      id: candidate.id,
      title: candidate.title,
      summary: candidate.content,
      url: candidate.url,
      publishedAt: candidate.publishedAt.toISOString(),
      capturedAt: asOf.toISOString(),
      source: candidate.source,
    })),
  });

  await prisma.graphSnapshot.create({
    data: {
      traceId,
      asOf,
      clusterKey,
      nodesJson: result.graph.nodes as unknown as Prisma.InputJsonValue,
      edgesJson: result.graph.relationships as unknown as Prisma.InputJsonValue,
    },
  });

  return {
    nodeCount: result.graph.nodes.length,
    edgeCount: result.graph.relationships.length,
  };
};

const runQuery = async (client: pg.Client, query: IDiagnosticQuery): Promise<readonly Record<string, unknown>[]> => {
  const result = await client.query(query.sql, query.values ? [...query.values] : []) as { readonly rows: readonly Record<string, unknown>[] };
  return result.rows;
};

const countReprintGroups = (candidates: readonly INormalizedNewsCandidate[]): number => {
  return new Set(candidates.map(candidate => candidate.reprintGroupId ?? candidate.id)).size;
};

const countReprintPenalized = (candidates: readonly INormalizedNewsCandidate[]): number => {
  return candidates.filter(candidate => (candidate.reprintWeight ?? 1) < 1).length;
};

const summarizeEffectiveNewsBySource = (
  candidates: readonly INormalizedNewsCandidate[],
): Record<string, {
  readonly visibleCandidates: number;
  readonly effectiveCandidates: number;
  readonly businessVariableCount: number;
  readonly lowQualityCount: number;
}> => {
  const summary: Record<string, {
    visibleCandidates: number;
    effectiveCandidates: number;
    businessVariableCount: number;
    lowQualityCount: number;
  }> = {};
  for (const candidate of candidates) {
    const source = candidate.source || 'unknown';
    const current = summary[source] ?? {
      visibleCandidates: 0,
      effectiveCandidates: 0,
      businessVariableCount: 0,
      lowQualityCount: 0,
    };
    const qualityScore = candidate.quality?.qualityScore ?? 0;
    const hasBusinessVariable = candidate.quality?.hasBusinessVariable === true;
    current.visibleCandidates += 1;
    if (hasBusinessVariable) {
      current.businessVariableCount += 1;
    }
    if (qualityScore < 0.3) {
      current.lowQualityCount += 1;
    }
    if (qualityScore >= 0.3 && hasBusinessVariable) {
      current.effectiveCandidates += 1;
    }
    summary[source] = current;
  }
  return summary;
};

const persistNewsQualitySnapshots = async (
  prisma: any,
  input: {
    readonly traceId: string;
    readonly asOf: Date;
    readonly clusterKey: string;
    readonly candidates: readonly INormalizedNewsCandidate[];
  },
): Promise<{
  readonly snapshotCount: number;
  readonly businessVariableCount: number;
  readonly directStockMentionCount: number;
  readonly lowQualityCount: number;
  readonly averageQualityScore: number;
}> => {
  if (!prisma.newsQualitySnapshot?.createMany || input.candidates.length === 0) {
    return {
      snapshotCount: 0,
      businessVariableCount: 0,
      directStockMentionCount: 0,
      lowQualityCount: 0,
      averageQualityScore: 0,
    };
  }

  const rows = input.candidates.map((candidate) => {
    const quality = candidate.quality ?? {
      titleQuality: candidate.title.trim().length > 0 ? 'normal' : 'empty',
      contentQuality: candidate.content.trim().length > candidate.title.trim().length ? 'summary' : 'title_only',
      hasBusinessVariable: CAUSAL_EXTRACTION_KEYWORD_PATTERN.test(`${candidate.title} ${candidate.content}`),
      hasDirectStockName: false,
      qualityScore: 0.5,
      failureReason: null,
    };
    return {
      traceId: input.traceId,
      asOf: input.asOf,
      clusterKey: input.clusterKey,
      newsId: candidate.id,
      source: candidate.source,
      reprintGroupId: candidate.reprintGroupId ?? candidate.id,
      reprintWeight: new Prisma.Decimal((candidate.reprintWeight ?? 1).toFixed(2)),
      sameTopicCount: candidate.sameTopicCount ?? 1,
      titleQuality: quality.titleQuality,
      contentQuality: quality.contentQuality,
      hasBusinessVariable: quality.hasBusinessVariable,
      hasDirectStockName: quality.hasDirectStockName,
      qualityScore: new Prisma.Decimal(quality.qualityScore.toFixed(4)),
      failureReason: quality.failureReason ?? null,
    };
  });

  await prisma.newsQualitySnapshot.createMany({
    data: rows,
    skipDuplicates: true,
  });

  const qualityScores = rows.map(row => Number(row.qualityScore));
  const averageQualityScore = qualityScores.length === 0
    ? 0
    : qualityScores.reduce((sum, value) => sum + value, 0) / qualityScores.length;
  return {
    snapshotCount: rows.length,
    businessVariableCount: rows.filter(row => row.hasBusinessVariable).length,
    directStockMentionCount: rows.filter(row => row.hasDirectStockName).length,
    lowQualityCount: rows.filter(row => Number(row.qualityScore) < 0.3).length,
    averageQualityScore: Number(averageQualityScore.toFixed(4)),
  };
};

const CAUSAL_EXTRACTION_KEYWORD_PATTERN = /(需求|订单|销量|销售|消费|装机|采购|交付|出口|中标|库存|产量|产能|供应|供给|不足|下降|减少|紧张|短缺|瓶颈|受限|价格|报价|现货|期货|上涨|涨价|大涨|突破|新高|资金|成交|融资|增持|回购|政策|补贴|支持|推进|促进|审批|准入|许可|白银|黄金|铜|铝|锂|镍|稀土|煤炭|石油|天然气|电力|光伏|新能源|储能|电池|芯片|半导体|机器人|算力|医药|创新药|化工|航运|航空|军工)/u;

const filterCausalExtractionCandidates = (
  candidates: readonly INormalizedNewsCandidate[],
): readonly INormalizedNewsCandidate[] => {
  return candidates.filter(candidate =>
    CAUSAL_EXTRACTION_KEYWORD_PATTERN.test(`${candidate.title} ${candidate.content}`),
  );
};

async function main(): Promise<void> {
  const args = parseArgs();
  const clusterKey = args.cluster ?? DEFAULT_CLUSTER_KEY;
  const asOf = getAsOf(args['as-of']);
  const traceId = args['trace-id'] ?? createTraceId(asOf, clusterKey);
  const limit = Number(args.limit ?? DEFAULT_LIMIT);
  const maxPerIndustry = Number(args['max-per-industry'] ?? DEFAULT_MAX_PER_INDUSTRY);
  const minExposureFacts = Number(args['min-exposure-facts'] ?? DEFAULT_MIN_EXPOSURE_FACTS);
  const tickFlowRefreshIntervalDays = getOptionalPositiveInteger(
    args,
    'tickflow-refresh-days',
    'TICKFLOW_REFRESH_DAYS',
    DEFAULT_TICKFLOW_REFRESH_INTERVAL_DAYS,
  );
  const causalSignalBatchSize = Number(args['causal-signal-batch-size'] ?? process.env.CAUSAL_SIGNAL_BATCH_SIZE ?? DEFAULT_CAUSAL_SIGNAL_BATCH_SIZE);
  const stopAfter = getStopAfter(args['stop-after']);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL }),
  });

  if (args['publish-only'] === 'true') {
    try {
      console.log(JSON.stringify(await publishLatestSnapshot(prisma, {
        clusterKey,
        asOf,
        limit,
      }), null, 2));
    }
    finally {
      await prisma.$disconnect();
    }
    return;
  }

  const pgClient = new pg.Client({ connectionString: DATABASE_URL });
  await pgClient.connect();

  let runTraceStarted = false;
  let activeStep: string | null = null;
  const stepTimings: Record<string, number> = {};
  const markStepStart = (): number => Date.now();
  const markStepEnd = (stepName: string, startedAt: number): void => {
    stepTimings[stepName] = Date.now() - startedAt;
  };

  try {
    await TraceManager.startRunTrace(prisma, traceId, clusterKey, stopAfter === 'none' ? 'DAILY_RECOMMENDATION' : 'NEWS_INGEST', asOf);
    runTraceStarted = true;

    activeStep = 'news_fetch';
    let stepStartedAt = markStepStart();
    await TraceManager.startStepTrace(prisma, traceId, 'news_fetch', {
      clusterKey,
      asOf: asOf.toISOString(),
      requiredSources: ['aktools', 'newsnow'],
      optionalSources: ['sina-finance-roll', 'sina-rss', 'google-news-rss'],
      newsSourceMode: getNewsSourceMode(args),
    });
    const newsInput = await resolveNewsInput(prisma, args, traceId, clusterKey, asOf);
    markStepEnd('news_fetch', stepStartedAt);
    const articles = newsInput.articles;
    if (articles.length === 0) {
      throw new PipelineStopError('news_fetch', '新闻获取结果为空，严格单向流程停止');
    }
    await TraceManager.completeStepTrace(prisma, traceId, 'news_fetch', {
      sourceMode: newsInput.sourceMode,
      sourceSummary: newsInput.sourceSummary,
      elapsedMs: stepTimings.news_fetch,
      articleCount: articles.length,
      sample: articles.slice(0, 3).map(article => ({
        title: article.title,
        source: article.metadata.source ?? article.metadata.provider,
        publishedAt: article.publishedAt.toISOString(),
      })),
    });
    activeStep = null;

    activeStep = 'normalize';
    stepStartedAt = markStepStart();
    await TraceManager.startStepTrace(prisma, traceId, 'normalize', {
      inputArticles: articles.length,
    });
    const normalizationReport = new NewsIngestNormalizationPipeline().process(toCandidateArticles(articles));
    markStepEnd('normalize', stepStartedAt);
    await TraceManager.completeStepTrace(prisma, traceId, 'normalize', {
      outputCandidates: normalizationReport.processed.length,
      elapsedMs: stepTimings.normalize,
      steps: normalizationReport.steps,
      sample: normalizationReport.processed.slice(0, 3).map(candidate => ({
        id: candidate.id,
        title: candidate.title,
        source: candidate.source,
        publishedAt: candidate.publishedAt.toISOString(),
      })),
    });
    activeStep = null;

    activeStep = 'deduplicate';
    stepStartedAt = markStepStart();
    await TraceManager.startStepTrace(prisma, traceId, 'deduplicate', {
      inputCandidates: normalizationReport.processed.length,
    });
    const deduplicationReport = new NewsIngestDeduplicationPipeline().process(normalizationReport.processed);
    const visibleCandidates = deduplicationReport.processed.filter(candidate => candidate.publishedAt <= asOf);
    markStepEnd('deduplicate', stepStartedAt);
    if (visibleCandidates.length === 0) {
      throw new PipelineStopError('normalize', '新闻均不在 asOf 可见边界内，严格单向流程停止');
    }
    await TraceManager.completeStepTrace(prisma, traceId, 'deduplicate', {
      outputCandidates: deduplicationReport.processed.length,
      visibleCandidates: visibleCandidates.length,
      reprintGroups: countReprintGroups(visibleCandidates),
      reprintPenalized: countReprintPenalized(visibleCandidates),
      elapsedMs: stepTimings.deduplicate,
      steps: deduplicationReport.steps,
      quality: {
        businessVariableCount: visibleCandidates.filter(candidate => candidate.quality?.hasBusinessVariable).length,
        directStockMentionCount: visibleCandidates.filter(candidate => candidate.quality?.hasDirectStockName).length,
        lowQualityCount: visibleCandidates.filter(candidate => (candidate.quality?.qualityScore ?? 1) < 0.3).length,
      },
      effectiveNewsBySource: summarizeEffectiveNewsBySource(visibleCandidates),
      sample: visibleCandidates.slice(0, 3).map(candidate => ({
        id: candidate.id,
        title: candidate.title,
        reprintGroupId: candidate.reprintGroupId,
        reprintWeight: candidate.reprintWeight,
      })),
    });
    activeStep = null;

    activeStep = 'persist_news';
    stepStartedAt = markStepStart();
    await TraceManager.startStepTrace(prisma, traceId, 'persist_news', {
      rawArticles: articles.length,
      normalizedCandidates: visibleCandidates.length,
    });
    await persistNews(prisma, articles, visibleCandidates, clusterKey);
    const newsQualityResult = await persistNewsQualitySnapshots(prisma, {
      traceId,
      asOf,
      clusterKey,
      candidates: visibleCandidates,
    });
    markStepEnd('persist_news', stepStartedAt);
    await TraceManager.completeStepTrace(prisma, traceId, 'persist_news', {
      rawArticles: articles.length,
      normalizedCandidates: visibleCandidates.length,
      newsQuality: newsQualityResult,
      elapsedMs: stepTimings.persist_news,
    });
    activeStep = null;

    if (stopAfter === 'dedup') {
      const diagnostics: IDiagnosticQuery[] = [
        {
          label: 'ingest_counts',
          sql: [
            'SELECT',
            '  (SELECT count(*)::int FROM "RawNewsRecord" WHERE "clusterKey" = $1 AND "publishedAt" <= $2) AS raw_news_visible,',
            '  (SELECT count(*)::int FROM "NormalizedNewsRecord" WHERE "clusterKey" = $1 AND "publishedAt" <= $2) AS normalized_news_visible,',
            '  (SELECT count(*)::int FROM "NormalizedNewsRecord" WHERE "clusterKey" = $1 AND "publishedAt" <= $2 AND "reprintWeight" < 1) AS reprint_penalized_visible',
          ].join(' '),
          values: [clusterKey, asOf],
        },
        {
          label: 'source_counts',
          sql: [
            'SELECT source, count(*)::int AS count',
            'FROM "RawNewsRecord"',
            'WHERE "clusterKey" = $1 AND "publishedAt" <= $2',
            'GROUP BY source',
            'ORDER BY count DESC, source ASC',
          ].join(' '),
          values: [clusterKey, asOf],
        },
        {
          label: 'reprint_samples',
          sql: [
            'SELECT id, title, source, "publishedAt", "reprintGroupId", "reprintWeight"::text',
            'FROM "NormalizedNewsRecord"',
            'WHERE "clusterKey" = $1 AND "publishedAt" <= $2',
            'ORDER BY "capturedAt" DESC',
            'LIMIT 10',
          ].join(' '),
          values: [clusterKey, asOf],
        },
        {
          label: 'step_traces',
          sql: 'SELECT "stepName", status, "inputSummary", "outputSummary", "errorMessage" FROM "PipelineStepTrace" WHERE "traceId" = $1 ORDER BY "startedAt"',
          values: [traceId],
        },
      ];

      const diagnosticResults: Record<string, readonly Record<string, unknown>[]> = {};
      for (const query of diagnostics) {
        diagnosticResults[query.label] = await runQuery(pgClient, query);
      }

      const metrics = {
        stopAfter,
        sourceMode: newsInput.sourceMode,
        sourceSummary: newsInput.sourceSummary,
        rawArticles: articles.length,
        normalizedCandidates: normalizationReport.processed.length,
        visibleCandidates: visibleCandidates.length,
        reprintGroups: countReprintGroups(visibleCandidates),
        reprintPenalized: countReprintPenalized(visibleCandidates),
        newsQuality: newsQualityResult,
        stepTimings,
      };
      await TraceManager.completeRunTrace(prisma, traceId, metrics);

      console.log(JSON.stringify({
        traceId,
        asOf: asOf.toISOString(),
        beijingAsOf: '2026-05-24 23:59:59.999 UTC+8',
        clusterKey,
        status: 'STOPPED_AFTER_DEDUP',
        ...metrics,
        diagnostics: diagnosticResults,
      }, null, 2));
      return;
    }


    const aktoolsBoardLimit = getPositiveIntegerOption(args, 'aktools-board-limit', 'AKTOOLS_BOARD_LIMIT');
    const aktoolsSymbolLimit = getPositiveIntegerOption(args, 'aktools-symbol-limit', 'AKTOOLS_SYMBOL_LIMIT');
    activeStep = 'stock_exposure_aktools';
    stepStartedAt = markStepStart();
    await TraceManager.startStepTrace(prisma, traceId, 'stock_exposure_aktools', {
      clusterKey,
      asOf: asOf.toISOString(),
      source: 'aktools',
      exposureTypes: ['industry_exposure', 'concept_exposure', 'company_profile_exposure', 'movement_evidence'],
      boardLimit: aktoolsBoardLimit,
      symbolLimit: aktoolsSymbolLimit,
    });
    const stockNameBySymbol = await createStockNameMap(prisma, clusterKey);
    const aktoolsExposureResult = await new AkToolsStockExposureService({
      baseUrl: DEFAULT_AKTOOLS_BASE_URL,
    }).sync(prisma, {
      traceId,
      asOf,
      clusterKey,
      stockNameBySymbol,
      boardLimit: aktoolsBoardLimit,
      symbolLimit: aktoolsSymbolLimit,
    });
    markStepEnd('stock_exposure_aktools', stepStartedAt);
    await TraceManager.completeStepTrace(prisma, traceId, 'stock_exposure_aktools', {
      ...aktoolsExposureResult,
      boardLimit: aktoolsBoardLimit,
      symbolLimit: aktoolsSymbolLimit,
      elapsedMs: stepTimings.stock_exposure_aktools,
    });
    activeStep = null;

    activeStep = 'stock_exposure_tickflow';
    stepStartedAt = markStepStart();
    await TraceManager.startStepTrace(prisma, traceId, 'stock_exposure_tickflow', {
      clusterKey,
      asOf: asOf.toISOString(),
      mode: 'sync_then_verify',
      exposureTypes: ['industry_exposure', 'concept_exposure', 'company_profile_exposure', 'movement_evidence'],
      minExposureFacts,
      refreshIntervalDays: tickFlowRefreshIntervalDays,
    });
    const {
      syncResult: tickflowExposureResult,
      exposureResult,
    } = await syncAndVerifyStockExposureFacts({
      prisma,
      traceId,
      clusterKey,
      asOf,
      minExposureFacts,
      tickFlowRefreshIntervalDays,
      stockNameBySymbol,
      syncService: createTickFlowStockExposureServiceFromEnv(),
    });
    markStepEnd('stock_exposure_tickflow', stepStartedAt);
    if (exposureResult.factCount < minExposureFacts) {
      throw new PipelineStopError(
        'stock_exposure_tickflow',
        `TickFlow 自动同步后暴露层覆盖仍不足：当前 ${exposureResult.factCount} 条，要求至少 ${minExposureFacts} 条`,
      );
    }
    await TraceManager.completeStepTrace(prisma, traceId, 'stock_exposure_tickflow', {
      mode: 'sync_then_verify',
      tickflowExposure: tickflowExposureResult,
      verification: exposureResult,
      ...exposureResult,
      elapsedMs: stepTimings.stock_exposure_tickflow,
    });
    activeStep = null;

    activeStep = 'causal_signal_extraction';
    stepStartedAt = markStepStart();
    const causalExtractionCandidates = filterCausalExtractionCandidates(visibleCandidates);
    if (causalExtractionCandidates.length === 0) {
      throw new PipelineStopError('causal_signal_extraction', '没有命中经营变量/资产主题关键词的新闻，严格单向流程停止');
    }
    await TraceManager.startStepTrace(prisma, traceId, 'causal_signal_extraction', {
      clusterKey,
      asOf: asOf.toISOString(),
      extractor: process.env.CAUSAL_SIGNAL_EXTRACTOR ?? null,
      noImplicitFallback: true,
      visibleCandidates: visibleCandidates.length,
      llmInputCandidates: causalExtractionCandidates.length,
      batchSize: causalSignalBatchSize,
    });
    const causalSignalResult = await new CausalSignalExtractionService(createCausalSignalExtractorFromEnv()).execute(prisma, {
      traceId,
      asOf,
      clusterKey,
      news: causalExtractionCandidates.map(candidate => ({
        id: candidate.id,
        title: candidate.title,
        content: candidate.content,
        source: candidate.source,
        publishedAt: candidate.publishedAt,
        reprintWeight: candidate.reprintWeight,
      })),
      batchSize: Number.isFinite(causalSignalBatchSize) ? causalSignalBatchSize : DEFAULT_CAUSAL_SIGNAL_BATCH_SIZE,
      onBatchComplete: event => console.log(
        `[causal_signal_extraction] batch ${event.batchIndex}/${event.batchCount} size=${event.batchSize} elapsedMs=${event.elapsedMs} signalCount=${event.signalCount}`,
      ),
    });
    if (causalSignalResult.candidateCount === 0) {
      throw new PipelineStopError('causal_signal_extraction', 'AI/结构化因果候选为空，严格单向流程停止');
    }
    markStepEnd('causal_signal_extraction', stepStartedAt);
    await TraceManager.completeStepTrace(prisma, traceId, 'causal_signal_extraction', causalSignalResult);
    activeStep = null;

    activeStep = 'graph_snapshot';
    stepStartedAt = markStepStart();
    const graph = await persistGraphSnapshot(prisma, traceId, asOf, clusterKey, visibleCandidates);
    markStepEnd('graph_snapshot', stepStartedAt);
    activeStep = null;

    activeStep = 'keyword_performance_penalty_refresh';
    stepStartedAt = markStepStart();
    await TraceManager.startStepTrace(prisma, traceId, 'keyword_performance_penalty_refresh', {
      clusterKey,
      asOf: asOf.toISOString(),
      source: 'reconciled_recommendation_snapshot',
      cooldownDays: 7,
    });
    const keywordPerformancePenaltyResult = await new KeywordPerformancePenaltyService().refresh(prisma, {
      asOf,
      clusterKey,
    });
    markStepEnd('keyword_performance_penalty_refresh', stepStartedAt);
    await TraceManager.completeStepTrace(prisma, traceId, 'keyword_performance_penalty_refresh', {
      ...keywordPerformancePenaltyResult,
      elapsedMs: stepTimings.keyword_performance_penalty_refresh,
    });
    activeStep = null;

    activeStep = 'scoring_recommendation';
    stepStartedAt = markStepStart();
    const backtestResult = await new BacktestEngine().runBacktest(prisma, {
      traceId,
      asOf,
      clusterKey,
      manageTrace: false,
      recommendationLimit: limit,
      maxPerIndustry,
      scoringProfile: 'short_news',
    });
    if (backtestResult.recommendationsCreated === 0) {
      throw new PipelineStopError('recommendation', '推荐结果为空，严格单向流程停止');
    }
    markStepEnd('scoring_recommendation', stepStartedAt);
    activeStep = null;

    activeStep = 'strategy_experiment';
    stepStartedAt = markStepStart();
    await TraceManager.startStepTrace(prisma, traceId, 'strategy_experiment', {
      traceId,
      asOf: asOf.toISOString(),
      clusterKey,
      enabledMode: 'multi-strategy',
    });
    const strategyResult = await new StrategyExperimentRunner().runEnabledStrategies(prisma, {
      traceId,
      asOf,
      clusterKey,
    });
    markStepEnd('strategy_experiment', stepStartedAt);
    await TraceManager.completeStepTrace(prisma, traceId, 'strategy_experiment', strategyResult);
    activeStep = null;

    const diagnostics: IDiagnosticQuery[] = [
      {
        label: 'pipeline_counts',
        sql: [
          'SELECT',
          '  (SELECT count(*)::int FROM "RawNewsRecord" WHERE "clusterKey" = $1 AND "publishedAt" <= $2) AS raw_news,',
          '  (SELECT count(*)::int FROM "NormalizedNewsRecord" WHERE "clusterKey" = $1 AND "publishedAt" <= $2) AS normalized_news,',
          '  (SELECT count(*)::int FROM "StockExposureFact" WHERE "clusterKey" = $1 AND status = $4 AND "validFrom" <= $2 AND ("validTo" IS NULL OR "validTo" >= $2)) AS stock_exposure_facts,',
          '  (SELECT count(*)::int FROM "EvidenceContribution" WHERE "traceId" = $3) AS evidence_contributions,',
          '  (SELECT count(*)::int FROM "StockFeatureSnapshot" WHERE "traceId" = $3) AS feature_snapshots,',
          '  (SELECT count(*)::int FROM "RecommendationSnapshot" WHERE "traceId" = $3) AS recommendation_snapshots,',
          '  (SELECT count(*)::int FROM "StrategyRun" WHERE "traceId" = $3) AS strategy_runs,',
          '  (SELECT count(*)::int FROM "StrategyRecommendationEvent" WHERE "traceId" = $3) AS strategy_recommendation_events,',
          '  (SELECT count(*)::int FROM "MarketSignalSnapshot" WHERE "traceId" = $3) AS market_signal_snapshots,',
          '  (SELECT count(*)::int FROM "NewsQualitySnapshot" WHERE "traceId" = $3) AS news_quality_snapshots',
        ].join(' '),
        values: [clusterKey, asOf, traceId, 'active'],
      },
      {
        label: 'latest_visible_candle',
        sql: 'SELECT max("tradingDay") AS latest_trading_day FROM "Candle" WHERE "tradingDay" <= $1',
        values: [asOf],
      },
      {
        label: 'market_signal_samples',
        sql: [
          'SELECT symbol, "latestTradingDay", "momentum5dPct"::text, "momentum20dPct"::text,',
          '       "volumeRatio20d"::text, "breakout20d", "volatilityCompression", "recentWeekGainExceeded", score::text',
          'FROM "MarketSignalSnapshot"',
          'WHERE "traceId" = $1',
          'ORDER BY score DESC, symbol ASC',
          'LIMIT 20',
        ].join(' '),
        values: [traceId],
      },
      {
        label: 'news_quality',
        sql: [
          'SELECT count(*)::int AS snapshots,',
          '       count(*) FILTER (WHERE "hasBusinessVariable")::int AS business_variable_news,',
          '       count(*) FILTER (WHERE "hasDirectStockName")::int AS direct_stock_news,',
          '       count(*) FILTER (WHERE "qualityScore" < 0.3)::int AS low_quality_news,',
          '       avg("qualityScore")::text AS avg_quality_score',
          'FROM "NewsQualitySnapshot"',
          'WHERE "traceId" = $1',
        ].join(' '),
        values: [traceId],
      },
      {
        label: 'recommendations',
        sql: [
          'SELECT r.rank, r.symbol, r."stockName", r.industry, r."finalScore"::text, r."realizedPrice"::text,',
          '       lc."tradingDay" AS latest_trading_day, lc.close::text AS latest_close,',
          '       (SELECT count(*)::int FROM "EvidenceContribution" e WHERE e."traceId" = r."traceId" AND e.symbol = r.symbol) AS evidence_count,',
          '       r.reasons',
          'FROM "RecommendationSnapshot" r',
          'JOIN "Stock" s ON s."clusterKey" = r."clusterKey" AND s.symbol = r.symbol',
          'LEFT JOIN LATERAL (',
          '  SELECT c."tradingDay", c.close FROM "Candle" c',
          '  WHERE c."stockId" = s.id AND c."tradingDay" <= $2',
          '  ORDER BY c."tradingDay" DESC LIMIT 1',
          ') lc ON TRUE',
          'WHERE r."traceId" = $1',
          'ORDER BY r.rank ASC',
        ].join(' '),
        values: [traceId, asOf],
      },
      {
        label: 'strategy_runs',
        sql: [
          'SELECT sr."strategyId" AS strategy_id, sd.name AS strategy_name, sr.status,',
          '       count(e.id)::int AS recommendation_count,',
          '       avg(CASE WHEN e."returnPct" IS NULL THEN NULL ELSE e."returnPct"::numeric END)::text AS avg_return_pct',
          'FROM "StrategyRun" sr',
          'JOIN "StrategyDefinition" sd ON sd.id = sr."strategyId"',
          'LEFT JOIN "StrategyRecommendationEvent" e ON e."strategyRunId" = sr.id',
          'WHERE sr."traceId" = $1',
          'GROUP BY sr."strategyId", sd.name, sr.status',
          'ORDER BY sd.name ASC',
        ].join(' '),
        values: [traceId],
      },
      {
        label: 'top_evidence',
        sql: [
          'SELECT e.symbol, e.keyword, e."finalContribScore"::text, e."baseFrequencyScore"::text,',
          '       e."timeDecayedScore"::text, e."reprintPenaltyScore"::text, n.title, n.source,',
          '       n."publishedAt", n."reprintWeight"::text, e.reasons',
          'FROM "EvidenceContribution" e',
          'JOIN "NormalizedNewsRecord" n ON n.id = e."newsId"',
          'WHERE e."traceId" = $1',
          'ORDER BY e."finalContribScore" DESC, e.symbol ASC',
          'LIMIT 30',
        ].join(' '),
        values: [traceId],
      },
      {
        label: 'step_traces',
        sql: 'SELECT "stepName", status, "inputSummary", "outputSummary", "errorMessage" FROM "PipelineStepTrace" WHERE "traceId" = $1 ORDER BY "startedAt"',
        values: [traceId],
      },
    ];

    const diagnosticResults: Record<string, readonly Record<string, unknown>[]> = {};
    for (const query of diagnostics) {
      diagnosticResults[query.label] = await runQuery(pgClient, query);
    }

    await TraceManager.completeRunTrace(prisma, traceId, {
      sourceMode: newsInput.sourceMode,
      sourceSummary: newsInput.sourceSummary,
      rawArticles: articles.length,
      normalizedCandidates: normalizationReport.processed.length,
      visibleCandidates: visibleCandidates.length,
      reprintGroups: countReprintGroups(visibleCandidates),
      reprintPenalized: countReprintPenalized(visibleCandidates),
      newsQuality: newsQualityResult,
      stockExposureFactsVisible: exposureResult.factCount,
      stockExposureSymbolsVisible: exposureResult.symbolCount,
      aktoolsExposure: aktoolsExposureResult,
      tickflowExposure: tickflowExposureResult,
      keywordPerformancePenalty: keywordPerformancePenaltyResult,
      causalSignalCandidates: causalSignalResult.candidateCount,
      graphNodes: graph.nodeCount,
      graphEdges: graph.edgeCount,
      recommendationsCreated: backtestResult.recommendationsCreated,
      reconciledCount: backtestResult.reconciledCount,
      strategyCount: strategyResult.strategyCount,
      enabledStrategyCount: strategyResult.enabledStrategyCount,
      strategySuccessCount: strategyResult.successCount,
      strategyFailureCount: strategyResult.failureCount,
      strategyRecommendationCount: strategyResult.recommendationCount,
      profileUsed: backtestResult.profileUsed,
      stepTimings,
      backtestResult,
      strategyResult,
    });

    console.log(JSON.stringify({
      traceId,
      asOf: asOf.toISOString(),
      beijingAsOf: '2026-05-24 23:59:59.999 UTC+8',
      clusterKey,
      sourceMode: newsInput.sourceMode,
      sourceSummary: newsInput.sourceSummary,
      stages: {
        rawArticles: articles.length,
        normalizedCandidates: normalizationReport.processed.length,
        visibleCandidates: visibleCandidates.length,
        graphNodes: graph.nodeCount,
        graphEdges: graph.edgeCount,
        stockExposureFactsVisible: exposureResult.factCount,
        stockExposureSymbolsVisible: exposureResult.symbolCount,
        aktoolsExposure: aktoolsExposureResult,
        tickflowExposure: tickflowExposureResult,
        keywordPerformancePenalty: keywordPerformancePenaltyResult,
        causalSignalCandidates: causalSignalResult.candidateCount,
        newsQuality: newsQualityResult,
        stepTimings,
      },
      backtestResult,
      strategyResult,
      diagnostics: diagnosticResults,
    }, null, 2));
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (runTraceStarted) {
      if (activeStep) {
        try {
          await TraceManager.failStepTrace(prisma, traceId, activeStep, message);
        }
        catch {}
      }
      try {
        await TraceManager.failRunTrace(prisma, traceId, message);
      }
      catch {}
    }
    throw error;
  }
  finally {
    await pgClient.end();
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    if (error instanceof PipelineStopError) {
      console.error(JSON.stringify({
        status: 'FAILED',
        failedStep: error.failedStep,
        errorMessage: error.message,
      }, null, 2));
    }
    else {
      console.error(error);
    }
    process.exitCode = 1;
  });
}
