import { PipelineRunLease } from '../src/services/pipeline-run-lease.js';
import { checkpointWork, runArtifactStage, artifactFingerprint } from '../src/services/pipeline-checkpoint.js';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import pg from 'pg';

import { BacktestEngine } from '../src/services/backtest-engine.js';
import { AiWorkflowSession, DurableCausalExtractionService, readAiCheckpoint, type AiPipelineCheckpoint } from '../src/services/ai-causal-workflow.js';
import { AiPausedError, AiNeedsAttentionError } from '../src/services/ai-scheduling-errors.js';
import { loadAiProviderConfig } from '../src/services/ai-provider-config.js';
import {
  createCausalSignalExtractorFromEnv,
} from '../src/services/causal-signal-extraction-service.js';
import { AkToolsStockExposureService } from '../src/services/aktools-stock-exposure-service.js';
import { ExpectationGapService } from '../src/services/expectation-gap-service.js';
import { ClusterUpgradeProposalService } from '../src/services/cluster-upgrade-proposal-service.js';
import { createFriendNetworkEngine } from '../src/services/friend-network-engine.js';
import { getKeywordDictionary } from '../src/services/keyword-dictionary.js';
import { KeywordPerformancePenaltyService } from '../src/services/keyword-performance-penalty-service.js';
import { ThemeForecastReconciliationService } from '../src/services/theme-forecast.js';
import { ThemeForecastService } from '../src/services/theme-forecast.js';
import {
  NewsIngestDeduplicationPipeline,
  NewsIngestNormalizationPipeline,
  selectExtractionLeaders,
  type INormalizedNewsCandidate,
} from '../src/services/news-ingest-pipeline.js';
import { loadBackendEnv } from '../src/services/load-backend-env.js';
import { createTickFlowStockExposureServiceFromEnv } from '../src/services/tickflow-stock-exposure-service.js';
import { TraceManager } from '../src/services/trace-manager.js';
import {
  STAGE_IDS,
  type PipelineStage,
  type RunContext,
  type StageId,
} from '../src/services/pipeline/stage-registry.js';
import { executePipeline } from '../src/services/pipeline/stage-executor.js';
import {
  STAGE_CHECKPOINT_NAMES,
  TRACE_STATE_CARRY_OVER_STAGES,
  carryOverTraceScopedState,
  copyReusableCheckpoints,
  copyUpstreamArtifacts,
  createDailyPipelineStages,
  resolveRecomputePlan,
  resolveStageOrderForStop,
  type StageHandler,
} from '../src/services/pipeline/registry-pipeline.js';
import { publishRecommendation, recordCompleteEmpty, classifyEmptyResult, type PublishRecommendationResult } from '../src/services/publish/index.js';
import {
  DEFAULT_BUSINESS_CONFIG,
  DEFAULT_BUSINESS_CONFIG_HASH,
  RECIPE_VERSION,
  resolveScoringRecipe,
  resolveStageExecutor,
  type ScoringRecipe,
  type StageExecutor,
} from '../src/version.js';
import {
  PipelineStopError,
  getBeijingDateKey,
  createTraceId,
  getStopAfter,
  getPositiveIntegerOption,
  getOptionalPositiveInteger,
  getNewsSourceMode,
 resolveNewsInput,
  toCandidateArticles,
  persistNews,
  verifyStockExposureFacts,
  type IDailyArticle,
  type StopAfterStage,
  type IStockExposureVerificationResult,
} from '../src/services/pipeline-utils.js';

loadBackendEnv();

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://gupiao:password@localhost:5432/gupiaodb';
const DEFAULT_CLUSTER_KEY = 'global';
const DEFAULT_LIMIT = 30;
const DEFAULT_MAX_PER_INDUSTRY = 5;
const DEFAULT_AKTOOLS_BASE_URL = process.env.AKTOOLS_BASE_URL ?? 'http://127.0.0.1:8010';
const DEFAULT_MIN_EXPOSURE_FACTS = process.env.TICKFLOW_API_KEY ? 500 : 100;
const DEFAULT_TICKFLOW_REFRESH_INTERVAL_DAYS = 30;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SINA_SESSION_PROBE_TIMEOUT_MS = 15000;

/** 北京日加减天（输入/输出均为 YYYY-MM-DD）。 */
export const shiftBeijingDay = (day: string, deltaDays: number): string => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
};

/**
 * 周末期望交易日（纯本地推导，不碰网络）：A股周六日铁定休市。
 * 返回 null 表示工作日，需要在线确认（节假日）。
 */
export const resolveWeekendExpectedTradingDay = (asOfBeijingDay: string, weekday: number): string | null => {
  if (weekday === 0) {
    return shiftBeijingDay(asOfBeijingDay, -2);
  }
  if (weekday === 6) {
    return shiftBeijingDay(asOfBeijingDay, -1);
  }
  return null;
};

/** 新浪最后交易日（交易所日历）：探针单只高流动性个股，取其快照日期。 */
const fetchSinaLastSessionDay = async (): Promise<string> => {
  const response = await fetch('https://hq.sinajs.cn/list=sh600519', {
    signal: AbortSignal.timeout(SINA_SESSION_PROBE_TIMEOUT_MS),
    headers: { Referer: 'https://finance.sina.com.cn' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const text = new TextDecoder('gbk').decode(buffer);
  const match = text.match(/,(\d{4}-\d{2}-\d{2}),\d{2}:\d{2}:\d{2}/);
  if (!match?.[1]) {
    throw new Error('sina_session_date_not_found');
  }
  return match[1];
};

/**
 * 期望最新交易日（YYYY-MM-DD）：周末本地推导，工作日用新浪确认。
 * 新浪不可用时退回 asOf 当日（严格口径，只放行不收紧）。
 */
export const resolveExpectedLatestTradingDay = async (asOf: Date): Promise<string> => {
  const asOfDay = getBeijingDateKey(asOf);
  const weekday = new Date(`${asOfDay}T00:00:00Z`).getUTCDay();
  const weekendDay = resolveWeekendExpectedTradingDay(asOfDay, weekday);
  if (weekendDay !== null) {
    return weekendDay;
  }
  try {
    const sinaDay = await fetchSinaLastSessionDay();
    return sinaDay <= asOfDay ? sinaDay : asOfDay;
  }
  catch {
    return asOfDay;
  }
};
const TICKFLOW_SW_UNIVERSE_SOURCE = 'tickflow_sw_universe';

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

interface IDiagnosticQuery {
  readonly label: string;
  readonly sql: string;
  readonly values?: readonly unknown[];
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
  // 默认当日北京收盘边界 16:00 +08:00，调度器按此跑；回测/手动入口传 --as-of 覆盖
  const asOf = raw === undefined
    ? new Date(`${getBeijingDateKey(new Date())}T16:00:00.000+08:00`)
    : new Date(raw);
  if (Number.isNaN(asOf.getTime())) {
    throw new Error(`Invalid --as-of: ${raw}`);
  }
  return asOf;
};

/** CLI 参数名 → 环境变量名；`--flag` 不带值时 parseArgs 会给出 'true'，此处视为未覆盖。 */
const cliOverride = (value: string | undefined): string | undefined => {
  return value === undefined || value === 'true' ? undefined : value;
};

/**
 * 解析本次运行使用的阶段执行器：`--stage-executor` 覆盖 `PIPELINE_STAGE_EXECUTOR`，
 * 未设置时默认 `registry`（生产强制切换），非法值直接抛错，不静默回退到 legacy。
 */
export const resolveRunExecutor = (
  args: Readonly<Record<string, string>> = {},
  env: Record<string, string | undefined> = process.env,
): StageExecutor => {
  const overrides: Record<string, string> = {};
  const cliStageExecutor = cliOverride(args['stage-executor']);
  if (cliStageExecutor !== undefined) overrides.PIPELINE_STAGE_EXECUTOR = cliStageExecutor;
  return resolveStageExecutor({ ...env, ...overrides });
};

/**
 * 解析本次运行使用的评分配方：`--scoring-recipe` 覆盖 `SCORING_RECIPE`，
 * 未设置时默认 `event-v2`，非法值直接抛错。
 */
export const resolveRunScoringRecipe = (
  args: Readonly<Record<string, string>> = {},
  env: Record<string, string | undefined> = process.env,
): ScoringRecipe => {
  const overrides: Record<string, string> = {};
  const cliRecipe = cliOverride(args['scoring-recipe']);
  if (cliRecipe !== undefined) overrides.SCORING_RECIPE = cliRecipe;
  return resolveScoringRecipe({ ...env, ...overrides });
};

/**
 * registry 运行的 RunContext：运行键（clusterKey + mode + asOf + recipeVersion + businessConfigHash）
 * 与阶段输入指纹来源。`inputs` 只放确定性字符串，保证同一 trace 重复执行命中产物复用。
 */
export const buildRegistryRunContext = (input: {
  readonly traceId: string;
  readonly clusterKey: string;
  readonly asOf: Date;
  readonly mode: string;
  readonly stopAfter: string;
  readonly scoringRecipe: ScoringRecipe;
  readonly recomputeFrom?: string;
  readonly sourceTraceId?: string;
  readonly inputs?: Readonly<Record<string, string>>;
}): RunContext => ({
  traceId: input.traceId,
  clusterKey: input.clusterKey,
  mode: input.mode,
  asOf: input.asOf.toISOString(),
  recipeVersion: RECIPE_VERSION,
  businessConfigHash: DEFAULT_BUSINESS_CONFIG_HASH,
  inputs: {
    scoringRecipe: input.scoringRecipe,
    stopAfter: input.stopAfter,
    recomputeFrom: input.recomputeFrom ?? '',
    sourceTraceId: input.sourceTraceId ?? '',
    ...input.inputs,
  },
  businessConfig: DEFAULT_BUSINESS_CONFIG,
});

/** 策略实验结果的紧凑摘要（完整结果留在 RunTrace.metrics 之外，避免产物载荷过大）。 */
export const summarizeStrategyResult = (strategyResult: unknown): Record<string, unknown> => {
  const source = (strategyResult ?? {}) as Record<string, unknown>;
  return {
    strategyCount: Number(source.strategyCount ?? 0),
    enabledStrategyCount: Number(source.enabledStrategyCount ?? 0),
    successCount: Number(source.successCount ?? 0),
    failureCount: Number(source.failureCount ?? 0),
    recommendationCount: Number(source.recommendationCount ?? 0),
  };
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

  const traceIds = traceRows.map(trace => trace.traceId);
  const grouped = traceIds.length > 0
    ? await prisma.recommendationSnapshot.groupBy({
        by: ['traceId'],
        where: { traceId: { in: traceIds } },
        _count: { _all: true },
      })
    : [];
  const recommendationCountByTraceId = new Map(
    grouped.map(row => [row.traceId, row._count._all] as const),
  );

  for (const trace of traceRows) {
    const recommendationCount = recommendationCountByTraceId.get(trace.traceId) ?? 0;
    if (recommendationCount > 0) {
      // 原子发布：创建 RecommendationPublish 记录（兼容读路径由 isPublished 承担）。
      const publishResult = await publishRecommendation(prisma, {
        traceId: trace.traceId,
        clusterKey: input.clusterKey,
        asOf: trace.asOf,
        auditStatus: 'pass',
        reason: 'daily_auto_publish',
      });
      return {
        status: 'PUBLISHED',
        beijingDate,
        traceId: trace.traceId,
        recommendationCount,
        requestedLimit: input.limit,
        asOf: trace.asOf.toISOString(),
        completedAt: trace.completedAt?.toISOString() ?? null,
        publish: publishResult,
      };
    }
  }

  throw new PipelineStopError(
    'publish_snapshot',
    `没有找到 ${beijingDate} 的成功 DAILY_RECOMMENDATION 快照，停止发布`,
  );
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
): Promise<{ nodeCount: number; edgeCount: number; causalSignalCount: number }> => {
  // 读取本 trace 已落库的 CausalSignalCandidate（status='candidate'），作为因果图谱的主输入
  const causalRows = typeof prisma.causalSignalCandidate?.findMany === 'function'
    ? await prisma.causalSignalCandidate.findMany({
        where: {
          traceId,
          clusterKey,
          status: 'candidate',
        },
      })
    : [];
  const causalSignals = causalRows
    .filter((row: any) => row.businessVariable && row.assetOrThemeKeyword)
    .map((row: any) => ({
      newsId: String(row.newsId),
      businessVariable: String(row.businessVariable),
      assetOrThemeKeyword: String(row.assetOrThemeKeyword),
      direction: (['positive', 'negative', 'mixed', 'neutral'].includes(row.direction)
        ? row.direction
        : 'neutral') as 'positive' | 'negative' | 'mixed' | 'neutral',
      confidence: Number(row.confidence ?? 0.5),
      evidenceText: String(row.evidenceText ?? row.event ?? ''),
    }));

  const engine = createFriendNetworkEngine({ keywordDictionary: await getKeywordDictionary(prisma) });
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
    causalSignals,
  });

  await prisma.graphSnapshot.upsert({
    where: { traceId },
    create: {
      traceId,
      asOf,
      clusterKey,
      nodesJson: result.graph.nodes as unknown as Prisma.InputJsonValue,
      edgesJson: result.graph.relationships as unknown as Prisma.InputJsonValue,
    },
    update: {
      asOf,
      clusterKey,
      nodesJson: result.graph.nodes as unknown as Prisma.InputJsonValue,
      edgesJson: result.graph.relationships as unknown as Prisma.InputJsonValue,
    },
  });

  return {
    nodeCount: result.graph.nodes.length,
    edgeCount: result.graph.relationships.length,
    causalSignalCount: causalSignals.length,
  };
};

const runQuery = async (client: pg.Client, query: IDiagnosticQuery): Promise<readonly Record<string, unknown>[]> => {
  const result = await client.query(query.sql, query.values ? [...query.values] : []) as { readonly rows: readonly Record<string, unknown>[] };
  return result.rows;
};

/**
 * `--stop-after dedup` 的统一收口：抓取/清洗/去重/落库完成后输出诊断、
 * 以 NEWS_INGEST 语义的 RunTrace SUCCESS 结束本次运行。
 * legacy 与 registry 两个执行器共用本函数，保证入口输出一致。
 */
const emitIngestStopSummary = async (input: {
  readonly prisma: PrismaClient;
  readonly pgClient: pg.Client;
  readonly traceId: string;
  readonly clusterKey: string;
  readonly asOf: Date;
  readonly stopAfter: string;
  readonly sourceMode: string;
  readonly sourceSummary: Record<string, unknown>;
  readonly rawArticleCount: number;
  readonly normalizedCandidateCount: number;
  readonly visibleCandidates: readonly INormalizedNewsCandidate[];
  readonly newsQualityResult: unknown;
  readonly stepTimings: Readonly<Record<string, number>>;
}): Promise<void> => {
  const { prisma, pgClient, traceId, clusterKey, asOf, stopAfter, visibleCandidates, stepTimings } = input;
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
    sourceMode: input.sourceMode,
    sourceSummary: input.sourceSummary,
    rawArticles: input.rawArticleCount,
    normalizedCandidates: input.normalizedCandidateCount,
    visibleCandidates: visibleCandidates.length,
    reprintGroups: countReprintGroups(visibleCandidates),
    reprintPenalized: countReprintPenalized(visibleCandidates),
    newsQuality: input.newsQualityResult,
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

/**
 * --from-forecast 模式：盘中基于已存档 ThemeForecast + 最新 Candle 重排推荐。
 *
 * ponytail: 不重跑 news_fetch/normalize/dedup/LLM 抽取。从 asOf 之前最近一次成功的
 * DAILY_RECOMMENDATION trace 复制 CausalSignalCandidate + GraphSnapshot 到本 trace，
 * 让 BacktestEngine/ScoringContributionEngine 沿用既有证据链路，仅用最新 Candle 重新评分+对账。
 * 升级路径：若需在新 trace 重新做因果抽取，可退回主流程；若 ScoringContributionEngine
 * 支持显式 sourceTraceId 注入，可省去 SQL 复制。
 */
const runFromForecastMode = async (
  prisma: PrismaClient,
  pgClient: pg.Client,
  input: {
    readonly traceId: string;
    readonly asOf: Date;
    readonly clusterKey: string;
    readonly limit: number;
    readonly maxPerIndustry: number;
    readonly forecastLookbackDays: number;
  },
): Promise<void> => {
  const { traceId, asOf, clusterKey, limit, maxPerIndustry, forecastLookbackDays } = input;
  const stepTimings: Record<string, number> = {};
  const markStepStart = (): number => Date.now();
  const markStepEnd = (stepName: string, startedAt: number): void => {
    stepTimings[stepName] = Date.now() - startedAt;
  };

  let activeStep: string | null = null;
  try {
    await TraceManager.startRunTrace(prisma, traceId, clusterKey, 'DAILY_RECOMMENDATION', asOf);

    // 1. 找到 asOf 之前最近一次成功的 DAILY_RECOMMENDATION trace（因果信号/图谱来源）
    activeStep = 'forecast_source_resolve';
    const sourceTrace = await checkpointWork(prisma,traceId,'forecast_source',{asOf,clusterKey,forecastLookbackDays},()=>prisma.runTrace.findFirst({
      where: {
        clusterKey,
        status: 'SUCCESS',
        kind: 'DAILY_RECOMMENDATION',
        asOf: { lte: asOf },
      },
      orderBy: { asOf: 'desc' },
    }));
    if (!sourceTrace) {
      throw new PipelineStopError(
        'forecast_source_resolve',
        `未找到 asOf=${asOf.toISOString()} 之前成功的 DAILY_RECOMMENDATION trace，无法复用因果信号`,
      );
    }
    const sourceTraceId = String(sourceTrace.traceId);
    console.log(`[from-forecast] 复用源 trace=${sourceTraceId} asOf=${new Date(sourceTrace.asOf).toISOString()}`);
    activeStep = null;

    // 2. Candle 前置校验（复用 Task 2 逻辑，确保评分用最新 Candle）
    activeStep = 'candle_preflight_check';
    const candleCheckRows = await runQuery(pgClient, {
      label: 'latest_candle',
      sql: 'SELECT max(c."tradingDay") AS latest FROM "Candle" c JOIN "Stock" s ON c."stockId" = s.id WHERE s."clusterKey" = $1',
      values: [clusterKey],
    });
    const latestCandleRaw = candleCheckRows[0]?.latest;
    const latestCandleDay = latestCandleRaw instanceof Date
      ? getBeijingDateKey(latestCandleRaw)
      : null;
    const asOfBeijingDay = getBeijingDateKey(asOf);
    // 期望最新交易日（周末=周五，工作日节假日用新浪确认），而非 asOf 当日。
    const expectedTradingDay = await resolveExpectedLatestTradingDay(asOf);
    if (latestCandleDay === null || latestCandleDay < expectedTradingDay) {
      const gapDays = latestCandleDay === null
        ? 'unknown'
        : Math.round((new Date(expectedTradingDay).getTime() - new Date(latestCandleDay).getTime()) / ONE_DAY_MS);
      throw new PipelineStopError(
        'candle_stale',
        `Candle 数据未同步到期望交易日：最新=${latestCandleDay}, 期望=${expectedTradingDay}, asOf=${asOfBeijingDay}, 差值=${gapDays} 天，停止推荐`,
      );
    }
    console.log(`[candle_check] OK 最新 Candle 日=${latestCandleDay}, 期望交易日=${expectedTradingDay}, asOf 日=${asOfBeijingDay}`);
    activeStep = null;

    // 3. 复制源 trace 的 CausalSignalCandidate 到本 trace（不重新跑 LLM 抽取）
    activeStep = 'causal_signal_copy';
    let stepStartedAt = markStepStart();
    await TraceManager.startStepTrace(prisma, traceId, 'causal_signal_copy', {
      clusterKey,
      asOf: asOf.toISOString(),
      sourceTraceId,
      description: '从源 trace 复制因果信号，跳过 LLM 抽取',
    });
    const copiedSignals = await checkpointWork(prisma,traceId,'forecast_causal_copy',{sourceTraceId},async()=> {
    if (typeof prisma.$executeRawUnsafe === 'function') await prisma.$executeRawUnsafe(
        [
          'INSERT INTO "CausalSignalCandidate" (',
          '  id, "traceId", "asOf", "clusterKey", "newsId", event, "businessVariable",',
          '  "assetOrThemeKeyword", direction, confidence, "evidenceText",',
          '  "evidenceOffsetStart", "evidenceOffsetEnd", "extractorType", "modelVersion",',
          '  "promptVersion", "inputFingerprint", status, "failureReason", "createdAt", "updatedAt"',
          ')',
          'SELECT',
          '  gen_random_uuid(), $1, "asOf", "clusterKey", "newsId", event, "businessVariable",',
          '  "assetOrThemeKeyword", direction, confidence, "evidenceText",',
          '  "evidenceOffsetStart", "evidenceOffsetEnd", "extractorType", "modelVersion",',
          '  "promptVersion", "inputFingerprint", status, "failureReason", NOW(), NOW()',
          'FROM "CausalSignalCandidate"',
          'WHERE "traceId" = $2 AND status = \'candidate\'',
          'ON CONFLICT DO NOTHING',
        ].join(' '),
        traceId,
        sourceTraceId,
      );
      return prisma.causalSignalCandidate.count({where:{traceId,clusterKey,status:'candidate'}});
    });
    if (copiedSignals === 0) {
      throw new PipelineStopError(
        'causal_signal_copy',
        `源 trace=${sourceTraceId} 无可用 candidate 状态因果信号，停止`,
      );
    }
    markStepEnd('causal_signal_copy', stepStartedAt);
    await TraceManager.completeStepTrace(prisma, traceId, 'causal_signal_copy', {
      sourceTraceId,
      copiedCount: copiedSignals,
      elapsedMs: stepTimings.causal_signal_copy,
    });
    activeStep = null;

    // 4. 复制源 trace 的 GraphSnapshot 到本 trace（scoring.loadGraphSignal 按 traceId 读取）
    activeStep = 'graph_snapshot_copy';
    stepStartedAt = markStepStart();
    await TraceManager.startStepTrace(prisma, traceId, 'graph_snapshot_copy', {
      clusterKey,
      asOf: asOf.toISOString(),
      sourceTraceId,
      description: '从源 trace 复制图谱快照',
    });
    const copiedGraph = typeof prisma.$executeRawUnsafe === 'function'
      ? await prisma.$executeRawUnsafe(
        [
          'INSERT INTO "GraphSnapshot" ("id", "traceId", "asOf", "clusterKey", "nodesJson", "edgesJson", "createdAt")',
          'SELECT gen_random_uuid(), $1, "asOf", "clusterKey", "nodesJson", "edgesJson", NOW()',
          'FROM "GraphSnapshot" WHERE "traceId" = $2',
          'ON CONFLICT ("traceId") DO NOTHING',
        ].join(' '),
        traceId,
        sourceTraceId,
      )
      : 0;
    markStepEnd('graph_snapshot_copy', stepStartedAt);
    await TraceManager.completeStepTrace(prisma, traceId, 'graph_snapshot_copy', {
      sourceTraceId,
      copied: copiedGraph,
      elapsedMs: stepTimings.graph_snapshot_copy,
    });
    activeStep = null;

    // 5. 读取近 N 日 bullish ThemeForecast（reasons 标注 + 来源溯源，不强制注入评分）
    activeStep = 'forecast_lookup';
    stepStartedAt = markStepStart();
    await TraceManager.startStepTrace(prisma, traceId, 'forecast_lookup', {
      clusterKey,
      asOf: asOf.toISOString(),
      lookbackDays: forecastLookbackDays,
    });
    const forecastLookbackStart = new Date(asOf.getTime() - forecastLookbackDays * ONE_DAY_MS);
    const recentForecasts = await prisma.themeForecast.findMany({
      where: {
        clusterKey,
        asOf: { gte: forecastLookbackStart, lte: asOf },
        direction: 'bullish',
      },
      orderBy: { probability: 'desc' },
      take: 20,
    });
    console.log(`[from-forecast] 命中 bullish 预测 ${recentForecasts.length} 条（lookbackDays=${forecastLookbackDays}）`);
    markStepEnd('forecast_lookup', stepStartedAt);
    await TraceManager.completeStepTrace(prisma, traceId, 'forecast_lookup', {
      forecastCount: recentForecasts.length,
      topThemes: recentForecasts.slice(0, 10).map((f: any) => ({
        theme: f.theme,
        probability: Number(f.probability),
        relatedSymbols: f.relatedSymbols,
      })),
      elapsedMs: stepTimings.forecast_lookup,
    });
    activeStep = null;

    // 6. 刷新关键词表现惩罚（cluster 级，复用既有逻辑）
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

    // 7. 评分+推荐（复用 BacktestEngine；scoring 读取本 trace 复制来的因果信号/图谱 + 最新 Candle）
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

    await TraceManager.completeRunTrace(prisma, traceId, {
      mode: 'from-forecast',
      sourceTraceId,
      forecastCount: recentForecasts.length,
      recommendationsCreated: backtestResult.recommendationsCreated,
      reconciledCount: backtestResult.reconciledCount,
      stepTimings,
    });

    console.log(JSON.stringify({
      mode: 'from-forecast',
      traceId,
      sourceTraceId,
      asOf: asOf.toISOString(),
      recommendationsCreated: backtestResult.recommendationsCreated,
      reconciledCount: backtestResult.reconciledCount,
      forecastCount: recentForecasts.length,
    }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (activeStep) {
      try {
        await TraceManager.failStepTrace(prisma, traceId, activeStep, message);
      } catch {}
    }
    try {
      await TraceManager.failRunTrace(prisma, traceId, message);
    } catch {}
    throw error;
  }
};

/** registry 运行的共享状态：阶段之间只通过它传递「本次进程内」的已算结果。 */
interface IRegistryRunState {
  newsSourceMode?: string;
  newsSourceSummary?: Record<string, unknown>;
  articles?: IDailyArticle[];
  normalizedCount?: number;
  visibleCandidates?: INormalizedNewsCandidate[];
  newsQualityResult?: unknown;
  stockNameBySymbol?: ReadonlyMap<string, string>;
  aktoolsExposureResult?: Record<string, any>;
  tickflowExposureResult?: Record<string, any>;
  exposureResult?: IStockExposureVerificationResult;
  causalSignalResult?: Record<string, any>;
  graph?: Record<string, any>;
  expectationGapResult?: Record<string, any>;
  themeForecastResult?: Record<string, any>;
  keywordPerformancePenaltyResult?: Record<string, any>;
  backtestResult?: Record<string, any>;
  strategyResult?: Record<string, any>;
  publishResult?: PublishRecommendationResult;
  themeReconciliationResult?: Record<string, any> | null;
  autopilotEvalResult?: { evaluated: boolean; proposals: readonly unknown[] };
  completeEmpty?: { readonly evidenceCount: number; readonly reason: string } | null;
  readonly stepTimings: Record<string, number>;
}

/**
 * registry 执行器主链路：14 个阶段全部经 `executePipeline` 运行，
 * 业务实现复用既有 helper/service（与 legacy 路径同一套业务代码）。
 *
 * 阶段顺序与依赖来自 `stage-registry.ts`；`--stop-after` 取确定性前缀，
 * `--recompute-from` 取「起始阶段 + 全部下游」并对上游做产物/检查点/按 trace 归属状态复用。
 * 任何无法复用的上游状态都由对应 handler 显式抛错要求更早起点，绝不静默全量重算。
 */
const runRegistryDailyPipeline = async (input: {
  readonly prisma: PrismaClient;
  readonly database: PrismaClient;
  readonly pgClient: pg.Client;
  readonly args: Readonly<Record<string, string>>;
  readonly traceId: string;
  readonly asOf: Date;
  readonly clusterKey: string;
  readonly limit: number;
  readonly maxPerIndustry: number;
  readonly minExposureFacts: number;
  readonly tickFlowRefreshIntervalDays: number;
  readonly stopAfter: StopAfterStage;
  readonly scoringRecipe: ScoringRecipe;
  readonly recomputeFrom?: StageId;
  readonly sourceTraceId?: string;
  readonly runStartedAt: number;
  readonly runLease: PipelineRunLease;
}): Promise<void> => {
  const {
    prisma, database, pgClient, args, traceId, asOf, clusterKey, limit, maxPerIndustry,
    minExposureFacts, tickFlowRefreshIntervalDays, stopAfter,
  } = input;
  const leaseGuard = { owner: input.runLease.owner, generation: input.runLease.currentGeneration() };
  const aktoolsBoardLimit = getPositiveIntegerOption(args, 'aktools-board-limit', 'AKTOOLS_BOARD_LIMIT');
  const aktoolsSymbolLimit = getPositiveIntegerOption(args, 'aktools-symbol-limit', 'AKTOOLS_SYMBOL_LIMIT');
  const state: IRegistryRunState = { stepTimings: {} };
  const markStep = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    const result = await work();
    state.stepTimings[name] = Date.now() - startedAt;
    return result;
  };

  const buildGenerationMetrics = (): Record<string, unknown> => ({
    stageExecutor: 'registry',
    scoringRecipe: input.scoringRecipe,
    sourceMode: state.newsSourceMode ?? null,
    sourceSummary: state.newsSourceSummary ?? null,
    rawArticles: state.articles?.length ?? 0,
    normalizedCandidates: state.normalizedCount ?? 0,
    visibleCandidates: state.visibleCandidates?.length ?? 0,
    reprintGroups: countReprintGroups(state.visibleCandidates ?? []),
    reprintPenalized: countReprintPenalized(state.visibleCandidates ?? []),
    newsQuality: state.newsQualityResult ?? null,
    stockExposureFactsVisible: state.exposureResult?.factCount ?? 0,
    stockExposureSymbolsVisible: state.exposureResult?.symbolCount ?? 0,
    aktoolsExposure: state.aktoolsExposureResult ?? null,
    tickflowExposure: state.tickflowExposureResult ?? null,
    causalSignalCandidates: state.causalSignalResult?.candidateCount ?? 0,
    graphNodes: state.graph?.nodeCount ?? 0,
    graphEdges: state.graph?.edgeCount ?? 0,
    graphCausalSignalInputs: state.graph?.causalSignalCount ?? 0,
    expectationGap: state.expectationGapResult ?? null,
    themeForecast: state.themeForecastResult ?? null,
    recommendationsCreated: state.backtestResult?.recommendationsCreated ?? 0,
    reconciledCount: state.backtestResult?.reconciledCount ?? 0,
    strategyCount: state.strategyResult?.strategyCount ?? 0,
    enabledStrategyCount: state.strategyResult?.enabledStrategyCount ?? 0,
    strategySuccessCount: state.strategyResult?.successCount ?? 0,
    strategyFailureCount: state.strategyResult?.failureCount ?? 0,
    strategyRecommendationCount: state.strategyResult?.recommendationCount ?? 0,
    profileUsed: state.backtestResult?.profileUsed ?? null,
    stepTimings: state.stepTimings,
  });

  const handlers: Record<StageId, StageHandler> = {
    news_fetch: async () => markStep('news_fetch', async () => {
      const savedNewsInput = await checkpointWork(
        prisma,
        traceId,
        'news_input',
        { asOf, clusterKey, version: 1 },
        () => resolveNewsInput(prisma, args, traceId, clusterKey, asOf),
        leaseGuard,
      );
      const articles = savedNewsInput.articles.map((article: any) => ({
        ...article,
        publishedAt: new Date(article.publishedAt),
      }));
      if (articles.length === 0) {
        throw new PipelineStopError('news_fetch', '新闻获取结果为空，严格单向流程停止');
      }
      state.newsSourceMode = savedNewsInput.sourceMode;
      state.newsSourceSummary = savedNewsInput.sourceSummary as Record<string, unknown>;
      state.articles = articles;
      return {
        sourceMode: savedNewsInput.sourceMode,
        sourceSummary: savedNewsInput.sourceSummary,
        articleCount: articles.length,
        sample: articles.slice(0, 3).map((article: any) => ({
          title: article.title,
          source: article.metadata?.source ?? article.metadata?.provider,
          publishedAt: article.publishedAt.toISOString(),
        })),
      };
    }),

    news_prepare: async () => markStep('news_prepare', async () => {
      const articles = state.articles;
      if (!articles || articles.length === 0) {
        throw new AiNeedsAttentionError(
          'news_prepare 缺少 news_fetch 的新闻输入，无法复用上游状态；请从 news_fetch 或更早阶段重算',
        );
      }
      const prepared = await checkpointWork(
        prisma,
        traceId,
        'registry_prepare',
        { asOf, clusterKey, version: 1 },
        async () => {
          const normalizationReport = new NewsIngestNormalizationPipeline().process(toCandidateArticles(articles));
          const deduplicationReport = new NewsIngestDeduplicationPipeline({ blockingTerms: (await getKeywordDictionary(prisma)).blockingTerms }).process(normalizationReport.processed);
          const visibleCandidates = deduplicationReport.processed.filter(candidate => candidate.publishedAt <= asOf);
          if (visibleCandidates.length === 0) {
            throw new PipelineStopError('normalize', '新闻均不在 asOf 可见边界内，严格单向流程停止');
          }
          await persistNews(prisma, articles, visibleCandidates, clusterKey);
          const newsQualityResult = await persistNewsQualitySnapshots(prisma, {
            traceId,
            asOf,
            clusterKey,
            candidates: visibleCandidates,
          });
          return {
            normalizedCount: normalizationReport.processed.length,
            dedupedCount: deduplicationReport.processed.length,
            visibleCandidates: [...visibleCandidates],
            newsQualityResult,
          };
        },
        leaseGuard,
      );
      // 检查点经 JSONB 往返后 Date 会退化为字符串，与 legacy 一样显式还原。
      const visibleCandidates = prepared.visibleCandidates.map((candidate: any) => ({
        ...candidate,
        publishedAt: new Date(candidate.publishedAt),
      })) as INormalizedNewsCandidate[];
      state.visibleCandidates = visibleCandidates;
      state.normalizedCount = Number(prepared.normalizedCount);
      state.newsQualityResult = prepared.newsQualityResult;
      return {
        normalizedCount: prepared.normalizedCount,
        dedupedCount: prepared.dedupedCount,
        visibleCandidateCount: visibleCandidates.length,
        reprintGroups: countReprintGroups(visibleCandidates),
        reprintPenalized: countReprintPenalized(visibleCandidates),
        effectiveNewsBySource: summarizeEffectiveNewsBySource(visibleCandidates),
        newsQuality: prepared.newsQualityResult,
        sample: visibleCandidates.slice(0, 3).map(candidate => ({
          id: candidate.id,
          title: candidate.title,
          reprintGroupId: candidate.reprintGroupId,
          reprintWeight: candidate.reprintWeight,
        })),
      };
    }),

    exposure_refresh: async () => markStep('exposure_refresh', async () => {
      const stockNameBySymbol = await createStockNameMap(prisma, clusterKey);
      const aktoolsExposureResult = await checkpointWork(
        prisma,
        traceId,
        'aktools_exposure',
        { asOf, clusterKey, aktoolsBoardLimit, aktoolsSymbolLimit },
        () => new AkToolsStockExposureService({ baseUrl: DEFAULT_AKTOOLS_BASE_URL }).sync(prisma, {
          traceId,
          asOf,
          clusterKey,
          stockNameBySymbol,
          boardLimit: aktoolsBoardLimit,
          symbolLimit: aktoolsSymbolLimit,
        }),
        leaseGuard,
      );
      const { syncResult: tickflowExposureResult, exposureResult } = await checkpointWork(
        prisma,
        traceId,
        'tickflow_exposure',
        { asOf, clusterKey, minExposureFacts, tickFlowRefreshIntervalDays },
        () => syncAndVerifyStockExposureFacts({
          prisma,
          traceId,
          clusterKey,
          asOf,
          minExposureFacts,
          tickFlowRefreshIntervalDays,
          stockNameBySymbol,
          syncService: createTickFlowStockExposureServiceFromEnv(),
        }),
        leaseGuard,
      );
      if (exposureResult.factCount < minExposureFacts) {
        throw new PipelineStopError(
          'stock_exposure_tickflow',
          `TickFlow 自动同步后暴露层覆盖仍不足：当前 ${exposureResult.factCount} 条，要求至少 ${minExposureFacts} 条`,
        );
      }
      state.stockNameBySymbol = stockNameBySymbol;
      state.aktoolsExposureResult = aktoolsExposureResult as Record<string, any>;
      state.tickflowExposureResult = tickflowExposureResult as Record<string, any>;
      state.exposureResult = exposureResult;
      return {
        aktoolsExposure: aktoolsExposureResult,
        tickflowExposure: tickflowExposureResult,
        exposure: exposureResult,
      };
    }),

    causal_extract: async () => markStep('causal_signal_extraction', async () => {
      const visibleCandidates = state.visibleCandidates ?? [];
      if (visibleCandidates.length === 0) {
        throw new AiNeedsAttentionError(
          'causal_extract 缺少 news_prepare 的可见新闻候选，无法复用上游状态；请从 news_prepare 或更早阶段重算',
        );
      }
      const causalExtractionCandidates = selectExtractionLeaders(filterCausalExtractionCandidates(visibleCandidates));
      if (causalExtractionCandidates.length === 0) {
        throw new PipelineStopError('causal_signal_extraction', '没有命中经营变量/资产主题关键词的新闻');
      }
      const aiConfig = loadAiProviderConfig();
      const aiSession = new AiWorkflowSession(
        database,
        traceId,
        input.runStartedAt + (aiConfig.scheduling?.runTimeoutMs ?? 3600000),
      );
      input.runLease.controller.signal.addEventListener(
        'abort',
        () => aiSession.controller.abort(input.runLease.controller.signal.reason),
        { once: true },
      );
      const aiCheckpoint: AiPipelineCheckpoint = {
        asOf: asOf.toISOString(),
        clusterKey,
        limit,
        maxPerIndustry,
        newsInput: {
          sourceMode: state.newsSourceMode ?? 'unknown',
          sourceSummary: state.newsSourceSummary ?? {},
        },
        articleCount: state.articles?.length ?? 0,
        normalizedCount: state.normalizedCount ?? visibleCandidates.length,
        visibleCandidates,
        newsQualityResult: state.newsQualityResult ?? null,
        aktoolsExposureResult: state.aktoolsExposureResult ?? null,
        tickflowExposureResult: state.tickflowExposureResult ?? null,
        exposureResult: state.exposureResult
          ? { ...state.exposureResult }
          : { factCount: 0, symbolCount: 0 },
        stepTimings: { ...state.stepTimings },
      };
      await aiSession.start(aiCheckpoint);
      try {
        const causalSignalResult = await new DurableCausalExtractionService(
          createCausalSignalExtractorFromEnv(),
          aiSession,
          aiConfig,
        ).execute(prisma, {
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
        });
        if (!causalSignalResult.candidateCount) {
          throw new PipelineStopError('causal_signal_extraction', 'AI/结构化因果候选为空，严格单向流程停止');
        }
        aiSession.controller.signal.throwIfAborted();
        state.causalSignalResult = causalSignalResult as unknown as Record<string, any>;
        await aiSession.close('AI_COMPLETE');
        return causalSignalResult;
      }
      catch (error) {
        const status = error instanceof AiPausedError
          ? 'PAUSED'
          : error instanceof AiNeedsAttentionError ? 'NEEDS_ATTENTION' : 'FAILED';
        await aiSession.close(status).catch(() => undefined);
        throw error;
      }
    }),

    graph_snapshot: async () => markStep('graph_snapshot', async () => {
      const causalSignalCount = await prisma.causalSignalCandidate.count({ where: { traceId, clusterKey } });
      if (causalSignalCount === 0) {
        throw new AiNeedsAttentionError(
          'graph_snapshot 需要本 trace 的 CausalSignalCandidate；上游 causal_extract 状态无法复用，请从 causal_extract 或更早阶段重算',
        );
      }
      const visibleCandidates = state.visibleCandidates ?? [];
      if (visibleCandidates.length === 0) {
        throw new AiNeedsAttentionError(
          'graph_snapshot 缺少 news_prepare 的可见新闻候选；请从 news_prepare 或更早阶段重算',
        );
      }
      const causalArtifacts = await artifactFingerprint(prisma, { traceId, clusterKey }, ['causalSignalCandidate']);
      const graph = await runArtifactStage(
        prisma,
        traceId,
        clusterKey,
        'graph_snapshot',
        { version: 'graph-v2', asOf, causalArtifacts },
        ['graphSnapshot'],
        tx => persistGraphSnapshot(tx, traceId, asOf, clusterKey, visibleCandidates),
      );
      state.graph = graph as unknown as Record<string, any>;
      return graph;
    }),

    market_features: async () => markStep('candle_preflight_check', async () => {
      const candleCheckRows = await runQuery(pgClient, {
        label: 'latest_candle',
        sql: 'SELECT max(c."tradingDay") AS latest FROM "Candle" c JOIN "Stock" s ON c."stockId" = s.id WHERE s."clusterKey" = $1',
        values: [clusterKey],
      });
      const latestCandleRaw = candleCheckRows[0]?.latest;
      const latestCandleDay = latestCandleRaw instanceof Date ? getBeijingDateKey(latestCandleRaw) : null;
      const asOfBeijingDay = getBeijingDateKey(asOf);
      const expectedTradingDay = await resolveExpectedLatestTradingDay(asOf);
      if (latestCandleDay === null || latestCandleDay < expectedTradingDay) {
        const gapDays = latestCandleDay === null
          ? 'unknown'
          : Math.round((new Date(expectedTradingDay).getTime() - new Date(latestCandleDay).getTime()) / ONE_DAY_MS);
        console.error(`[candle_check] FAIL 最新 Candle 日=${latestCandleDay}, 期望交易日=${expectedTradingDay}, asOf 日=${asOfBeijingDay}, 差值=${gapDays} 天`);
        throw new PipelineStopError(
          'candle_stale',
          `Candle 数据未同步到期望交易日：最新 Candle 日=${latestCandleDay}, 期望=${expectedTradingDay}, asOf 日=${asOfBeijingDay}, 差值=${gapDays} 天，停止推荐`,
        );
      }
      console.log(`[candle_check] OK 最新 Candle 日=${latestCandleDay}, 期望交易日=${expectedTradingDay}, asOf 日=${asOfBeijingDay}, 校验通过`);
      return { latestCandleDay, asOfBeijingDay };
    }),

    expectation_gap: async () => markStep('expectation_gap', async () => {
      const graphRows = await prisma.graphSnapshot.count({ where: { traceId, clusterKey } });
      if (graphRows === 0) {
        throw new AiNeedsAttentionError(
          'expectation_gap 需要本 trace 的 GraphSnapshot；上游 graph_snapshot 状态无法复用，请从 graph_snapshot 或更早阶段重算',
        );
      }
      const graphArtifacts = await artifactFingerprint(prisma, { traceId, clusterKey }, ['graphSnapshot']);
      const expectationGapResult = await runArtifactStage(
        prisma,
        traceId,
        clusterKey,
        'expectation_gap',
        { version: 'expectation-v2', asOf, graphArtifacts },
        ['expectationGapSnapshot'],
        tx => new ExpectationGapService().calculate(tx, { traceId, asOf, clusterKey }),
      );
      state.expectationGapResult = expectationGapResult as unknown as Record<string, any>;
      return expectationGapResult;
    }),

    theme_forecast: async () => markStep('theme_forecast', async () => {
      const causalSignalCount = await prisma.causalSignalCandidate.count({ where: { traceId, clusterKey } });
      if (causalSignalCount === 0) {
        throw new AiNeedsAttentionError(
          'theme_forecast 需要本 trace 的 CausalSignalCandidate；请从 causal_extract 或更早阶段重算',
        );
      }
      const causalArtifacts = await artifactFingerprint(prisma, { traceId, clusterKey }, ['causalSignalCandidate']);
      const expectationArtifacts = await artifactFingerprint(prisma, { traceId, clusterKey }, ['expectationGapSnapshot']);
      const themeForecastResult = await runArtifactStage(
        prisma,
        traceId,
        clusterKey,
        'theme_forecast',
        { version: 'theme-v2', asOf, causalArtifacts, expectationArtifacts },
        ['themeForecast'],
        tx => new ThemeForecastService().generate(tx, { traceId, asOf, clusterKey }),
      );
      state.themeForecastResult = themeForecastResult as unknown as Record<string, any>;
      return themeForecastResult;
    }),

    penalty_refresh: async () => markStep('keyword_performance_penalty_refresh', async () => {
      const keywordPerformancePenaltyResult = await new KeywordPerformancePenaltyService().refresh(prisma, {
        asOf,
        clusterKey,
      });
      state.keywordPerformancePenaltyResult = keywordPerformancePenaltyResult as unknown as Record<string, any>;
      return keywordPerformancePenaltyResult;
    }),

    evidence_score: async () => markStep('scoring_recommendation', async () => {
      const [causalSignalCount, graphRows] = await Promise.all([
        prisma.causalSignalCandidate.count({ where: { traceId, clusterKey } }),
        prisma.graphSnapshot.count({ where: { traceId, clusterKey } }),
      ]);
      if (causalSignalCount === 0 || graphRows === 0) {
        throw new AiNeedsAttentionError(
          'evidence_score 需要本 trace 的 CausalSignalCandidate 与 GraphSnapshot；上游状态无法复用，请从 causal_extract 或更早阶段重算',
        );
      }
      const backtestResult = await new BacktestEngine().runBacktest(prisma, {
        traceId,
        asOf,
        clusterKey,
        manageTrace: false,
        recommendationLimit: limit,
        maxPerIndustry,
        scoringProfile: 'short_news',
        // registry reconciliation 阶段拥有 `reconciliation` 步骤名，legacy 直写会撞车
        skipStepTraces: ['reconciliation'],
      });
      state.backtestResult = backtestResult as unknown as Record<string, any>;
      state.strategyResult = backtestResult.strategyResult as unknown as Record<string, any>;
      return {
        recommendationsCreated: backtestResult.recommendationsCreated,
        reconciledCount: backtestResult.reconciledCount,
        profileUsed: backtestResult.profileUsed,
        halfLifeDaysUsed: backtestResult.halfLifeDaysUsed,
        maxWindowDaysUsed: backtestResult.maxWindowDaysUsed,
        strategy: summarizeStrategyResult(backtestResult.strategyResult),
      };
    }),

    recommendation_select: async () => markStep('recommendation_select', async () => {
      const recommendationCount = await prisma.recommendationSnapshot.count({ where: { traceId, clusterKey } });
      if (recommendationCount > 0) {
        return { recommendationCount, completeEmpty: false };
      }
      const evidenceCount = await prisma.evidenceContribution.count({ where: { traceId } });
      const decision = classifyEmptyResult({ recommendationsCreated: 0, evidenceCount });
      if (decision !== 'complete_empty') {
        throw new PipelineStopError('recommendation', '推荐结果为空，严格单向流程停止');
      }
      const reason = `证据存在(${evidenceCount}条)但候选被质量门槛全部过滤，无推荐产出`;
      await recordCompleteEmpty(prisma, traceId, reason);
      state.completeEmpty = { evidenceCount, reason };
      console.log(JSON.stringify({
        traceId,
        asOf: asOf.toISOString(),
        clusterKey,
        status: 'COMPLETE_EMPTY',
        reason: '候选被质量门槛全部过滤',
        evidenceCount,
      }, null, 2));
      return { recommendationCount: 0, completeEmpty: true, evidenceCount, reason };
    }),

    recommendation_publish: async () => markStep('publish', async () => {
      const recommendationCount = await prisma.recommendationSnapshot.count({ where: { traceId, clusterKey } });
      if (recommendationCount === 0) {
        throw new AiNeedsAttentionError(
          'recommendation_publish 需要本 trace 的 RecommendationSnapshot；上游 recommendation_select 状态无法复用，请从 recommendation_select 或更早阶段重算',
        );
      }
      // 与 legacy 一致：发布提交在推荐生成后立即完成，且置于后处理之前，
      // 使「对账/惩罚/自提升」失败无法撤销或阻断已发布的原子结果。
      const generationMetrics = buildGenerationMetrics();
      await TraceManager.completeRunTrace(prisma, traceId, generationMetrics);
      const publishResult = await publishRecommendation(prisma, {
        traceId,
        clusterKey,
        asOf,
        auditStatus: 'pass',
        reason: 'daily_auto_publish',
      });
      state.publishResult = publishResult;
      console.log(`[publish] trace=${traceId} 已发布 v${publishResult.publishVersion} reused=${publishResult.reused}`);
      return {
        recommendationCount,
        publishVersion: publishResult.publishVersion,
        auditStatus: publishResult.auditStatus,
        reused: publishResult.reused,
      };
    }),

    reconciliation: async () => markStep('theme_forecast_reconciliation', async () => {
      const themeReconciliationResult = await new ThemeForecastReconciliationService().reconcile(prisma, {
        asOf,
        clusterKey,
      });
      state.themeReconciliationResult = (themeReconciliationResult ?? null) as Record<string, any> | null;
      return themeReconciliationResult ?? { reconciled: false };
    }),

    strategy_evaluation: async () => markStep('autopilot_evaluation', async () => {
      let autopilotEvalResult: { evaluated: boolean; proposals: readonly unknown[] } = { evaluated: false, proposals: [] };
      try {
        const runtimeStateStore = {
          read: async () => {
            try {
              const raw = await readFile(path.resolve(process.cwd(), 'tmp', 'http-runtime', 'runtime-store.json'), 'utf8');
              return JSON.parse(raw) as { readonly autopilot_policies: Readonly<Record<string, Record<string, unknown>>> };
            } catch {
              return { autopilot_policies: {} as Record<string, Record<string, unknown>> };
            }
          },
        };
        const proposalResult = await new ClusterUpgradeProposalService(runtimeStateStore).evaluateAndPropose(prisma, {
          groupId: clusterKey,
          asOf,
          clusterKey,
        });
        autopilotEvalResult = {
          evaluated: true,
          proposals: proposalResult.shouldPropose
            ? [{
                groupId: proposalResult.groupId,
                triggers: proposalResult.triggers,
                failureReasons: proposalResult.failureReasons,
                proposal: proposalResult.proposal,
                recommendationStats: proposalResult.recommendationStats,
                themeForecastStats: proposalResult.themeForecastStats,
              }]
            : [],
        };
        if (proposalResult.shouldPropose) {
          console.log(`[autopilot_evaluation] ⚠️ 集团 ${clusterKey} 触发升级建议：${proposalResult.failureReasons.join('; ')}`);
        }
      } catch (error) {
        autopilotEvalResult = { evaluated: false, proposals: [] };
        console.error(`[autopilot_evaluation] 评估失败：${error instanceof Error ? error.message : String(error)}`);
      }
      state.autopilotEvalResult = autopilotEvalResult;
      return {
        ...autopilotEvalResult,
        strategy: summarizeStrategyResult(state.strategyResult ?? {}),
      };
    }),
  };

  const stages = createDailyPipelineStages({ handlers });
  const context = buildRegistryRunContext({
    traceId,
    clusterKey,
    asOf,
    mode: stopAfter === 'none' ? 'daily' : 'ingest',
    stopAfter,
    scoringRecipe: input.scoringRecipe,
    recomputeFrom: input.recomputeFrom,
    sourceTraceId: input.sourceTraceId,
    inputs: {
      limit: String(limit),
      maxPerIndustry: String(maxPerIndustry),
      minExposureFacts: String(minExposureFacts),
      tickflowRefreshDays: String(tickFlowRefreshIntervalDays),
      aktoolsBoardLimit: String(aktoolsBoardLimit),
      aktoolsSymbolLimit: String(aktoolsSymbolLimit),
    },
  });
  const order = resolveStageOrderForStop(stopAfter);
  const completedStages = new Set<StageId>();
  let stagePlan: readonly StageId[] = order;

  if (input.recomputeFrom) {
    if (!input.sourceTraceId) throw new Error('--recompute-from requires --source-trace-id');
    if (stopAfter !== 'none') throw new Error('--recompute-from 与 --stop-after 不能同时使用');
    const plan = resolveRecomputePlan(input.recomputeFrom);
    const sourceTraceId = input.sourceTraceId;
    const artifacts = await copyUpstreamArtifacts(prisma, {
      sourceTraceId,
      targetTraceId: traceId,
      stages: plan.upstream,
    });
    const checkpointNames = plan.upstream.flatMap(stage => [...(STAGE_CHECKPOINT_NAMES[stage] ?? [])]);
    const checkpoints = await copyReusableCheckpoints(prisma, {
      sourceTraceId,
      targetTraceId: traceId,
      stages: checkpointNames,
    });
    const carryOver = await carryOverTraceScopedState(prisma, {
      sourceTraceId,
      targetTraceId: traceId,
      stages: plan.upstream.filter(stage => TRACE_STATE_CARRY_OVER_STAGES.includes(stage)),
    });
    console.log(JSON.stringify({
      mode: 'recompute',
      startStage: input.recomputeFrom,
      sourceTraceId,
      targetTraceId: traceId,
      affected: plan.affected,
      upstream: plan.upstream,
      reusedArtifacts: artifacts,
      reusedCheckpoints: checkpoints,
      carryOverTraceState: carryOver,
    }, null, 2));
    stagePlan = plan.affected;
    for (const stage of plan.upstream) completedStages.add(stage);
  }

  const stageById = new Map(stages.map(stage => [stage.id, stage] as const));
  const stageList = (ids: readonly StageId[]): PipelineStage<unknown, unknown>[] =>
    ids.map(id => stageById.get(id) as PipelineStage<unknown, unknown>);
  const orderIndex = new Map(order.map((id, index) => [id, index] as const));
  const selectIndex = orderIndex.get('recommendation_select') ?? order.length - 1;
  const phaseA = stagePlan.filter(id => (orderIndex.get(id) ?? Number.MAX_SAFE_INTEGER) <= selectIndex);
  const phaseB = stagePlan.filter(id => (orderIndex.get(id) ?? Number.MAX_SAFE_INTEGER) > selectIndex);
  // 发布与后处理分离：发布失败必须抛出；对账/自提升属于后处理，失败只记录、绝不撤销已发布结果。
  const publishStages = phaseB.filter(id => id === 'recommendation_publish');
  const postProcessingStages = phaseB.filter(id => id !== 'recommendation_publish');
  const selectInPlan = stagePlan.includes('recommendation_select');
  const stageResults: Record<string, unknown> = {};
  const recordResults = (results: ReadonlyMap<StageId, { reused: boolean; artifactId: string; version: number; contentHash: string }>): void => {
    for (const [stageId, result] of results) {
      stageResults[stageId] = {
        reused: result.reused,
        artifactId: result.artifactId,
        version: result.version,
        contentHash: result.contentHash,
      };
    }
  };

  await TraceManager.startRunTrace(
    prisma,
    traceId,
    clusterKey,
    stopAfter === 'none' ? 'DAILY_RECOMMENDATION' : 'NEWS_INGEST',
    asOf,
  );

  try {
    if (phaseA.length > 0) {
      const results = await executePipeline(
        prisma,
        stageList(phaseA),
        context,
        { completedStages, lease: leaseGuard },
      );
      recordResults(results);
      for (const stage of phaseA) completedStages.add(stage);
    }

    // COMPLETE_EMPTY：证据存在但候选被质量门槛全部过滤 → 不发布、不补位、不当作失败。
    // 只有本计划确实执行/复用了 recommendation_select 时才在此判定；
    // 若 select 属于「上游复用」阶段，缺 RecommendationSnapshot 必须由后续阶段显式报错。
    if (selectInPlan) {
      const recommendationCount = await prisma.recommendationSnapshot.count({ where: { traceId, clusterKey } });
      if (recommendationCount === 0) {
        const evidenceCount = state.completeEmpty?.evidenceCount
          ?? await prisma.evidenceContribution.count({ where: { traceId } });
        if (evidenceCount === 0) {
          throw new PipelineStopError('recommendation', '推荐结果为空，严格单向流程停止');
        }
        const reason = state.completeEmpty?.reason
          ?? `证据存在(${evidenceCount}条)但候选被质量门槛全部过滤，无推荐产出`;
        if (!state.completeEmpty) await recordCompleteEmpty(database, traceId, reason);
        state.completeEmpty = { evidenceCount, reason };
        console.log(JSON.stringify({
          traceId,
          asOf: asOf.toISOString(),
          clusterKey,
          status: 'COMPLETE_EMPTY',
          stageExecutor: 'registry',
          reason: '候选被质量门槛全部过滤',
          evidenceCount,
          stepTimings: state.stepTimings,
          stageResults,
        }, null, 2));
        return;
      }
    }

    if (publishStages.length > 0) {
      const results = await executePipeline(
        prisma,
        stageList(publishStages),
        context,
        { completedStages, lease: leaseGuard },
      );
      recordResults(results);
      for (const stage of publishStages) completedStages.add(stage);
    }

    let postProcessingError: string | null = null;
    if (postProcessingStages.length > 0) {
      try {
        const results = await executePipeline(
          prisma,
          stageList(postProcessingStages),
          context,
          { completedStages, lease: leaseGuard },
        );
        recordResults(results);
        for (const stage of postProcessingStages) completedStages.add(stage);
      }
      catch (error) {
        // 与 legacy 一致：发布已完成时，后处理失败只记录错误状态，不撤销、不阻断发布。
        postProcessingError = error instanceof Error ? error.message : String(error);
        console.error(`[post_processing] 后处理失败（已发布结果不受影响）：${postProcessingError}`);
      }
    }

    if (stopAfter === 'dedup') {
      await emitIngestStopSummary({
        prisma,
        pgClient,
        traceId,
        clusterKey,
        asOf,
        stopAfter,
        sourceMode: state.newsSourceMode ?? 'unknown',
        sourceSummary: state.newsSourceSummary ?? {},
        rawArticleCount: state.articles?.length ?? 0,
        normalizedCandidateCount: state.normalizedCount ?? 0,
        visibleCandidates: state.visibleCandidates ?? [],
        newsQualityResult: state.newsQualityResult ?? null,
        stepTimings: state.stepTimings,
      });
      return;
    }

    if (stopAfter !== 'none') {
      const metrics = {
        ...buildGenerationMetrics(),
        stageExecutor: 'registry',
        stopAfter,
        stageResults,
        stepTimings: state.stepTimings,
      };
      await TraceManager.completeRunTrace(prisma, traceId, metrics);
      console.log(JSON.stringify({
        traceId,
        asOf: asOf.toISOString(),
        clusterKey,
        status: 'STOPPED_AFTER_STAGE',
        ...metrics,
      }, null, 2));
      return;
    }

    const generationMetrics = buildGenerationMetrics();
    await prisma.runTrace.update({
      where: { traceId },
      data: {
        metrics: {
          ...generationMetrics,
          themeReconciliation: state.themeReconciliationResult ?? null,
          keywordPerformancePenalty: state.keywordPerformancePenaltyResult ?? null,
          autopilot: state.autopilotEvalResult ?? { evaluated: false, proposals: [] },
          postProcessingError,
          stageResults,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    console.log(JSON.stringify({
      traceId,
      asOf: asOf.toISOString(),
      beijingAsOf: '2026-05-24 23:59:59.999 UTC+8',
      clusterKey,
      stageExecutor: 'registry',
      scoringRecipe: input.scoringRecipe,
      recomputeFrom: input.recomputeFrom ?? null,
      sourceTraceId: input.sourceTraceId ?? null,
      stages: {
        rawArticles: state.articles?.length ?? 0,
        normalizedCandidates: state.normalizedCount ?? 0,
        visibleCandidates: state.visibleCandidates?.length ?? 0,
        graphNodes: state.graph?.nodeCount ?? 0,
        graphEdges: state.graph?.edgeCount ?? 0,
        graphCausalSignalInputs: state.graph?.causalSignalCount ?? 0,
        stockExposureFactsVisible: state.exposureResult?.factCount ?? 0,
        stockExposureSymbolsVisible: state.exposureResult?.symbolCount ?? 0,
        aktoolsExposure: state.aktoolsExposureResult ?? null,
        tickflowExposure: state.tickflowExposureResult ?? null,
        keywordPerformancePenalty: state.keywordPerformancePenaltyResult ?? null,
        causalSignalCandidates: state.causalSignalResult?.candidateCount ?? 0,
        newsQuality: state.newsQualityResult ?? null,
        stepTimings: state.stepTimings,
      },
      backtestResult: {
        recommendationsCreated: state.backtestResult?.recommendationsCreated ?? 0,
        reconciledCount: state.backtestResult?.reconciledCount ?? 0,
        profileUsed: state.backtestResult?.profileUsed ?? null,
      },
      strategyResult: summarizeStrategyResult(state.strategyResult ?? {}),
      publishResult: state.publishResult ?? null,
      postProcessingError,
      stageResults,
    }, null, 2));
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof AiPausedError
      ? 'PAUSED'
      : error instanceof AiNeedsAttentionError ? 'NEEDS_ATTENTION' : 'FAILED';
    // 失败标记走未加租约守卫的 database 连接：不得因为租约丢失而丢掉失败状态。
    try {
      const existing = await database.runTrace.findUnique({ where: { traceId } });
      if (existing?.status === 'SUCCESS') {
        // 发布已经提交：后处理失败绝不把 RunTrace 改回失败状态（与 legacy 语义一致）。
        const existingMetrics = (existing.metrics && typeof existing.metrics === 'object' && !Array.isArray(existing.metrics))
          ? existing.metrics as Record<string, unknown>
          : {};
        await database.runTrace.update({
          where: { traceId },
          data: {
            metrics: {
              ...existingMetrics,
              postProcessingError: message,
            } as unknown as Prisma.InputJsonValue,
          },
        });
      }
      else {
        await database.runTrace.update({
          where: { traceId },
          data: { status, errorMessage: message, completedAt: null },
        });
      }
    } catch { /* 失败标记尽力而为，原始错误始终原样抛出 */ }
    throw error;
  }
};

async function executeMain(args: Record<string, string>, runLease: PipelineRunLease): Promise<void> {
  const runStartedAt = Date.now();
  let clusterKey = args.cluster ?? DEFAULT_CLUSTER_KEY;
  let asOf = getAsOf(args['as-of']);
  const traceId = args['resume-trace-id'] ?? args['trace-id'] ?? createTraceId(asOf, clusterKey);
  let limit = Number(args.limit ?? DEFAULT_LIMIT);
  let maxPerIndustry = Number(args['max-per-industry'] ?? DEFAULT_MAX_PER_INDUSTRY);
  const minExposureFacts = Number(args['min-exposure-facts'] ?? DEFAULT_MIN_EXPOSURE_FACTS);
  const tickFlowRefreshIntervalDays = getOptionalPositiveInteger(
    args,
    'tickflow-refresh-days',
    'TICKFLOW_REFRESH_DAYS',
    DEFAULT_TICKFLOW_REFRESH_INTERVAL_DAYS,
  );
  const stopAfter = getStopAfter(args['stop-after']);
  const recomputeFrom = args['recompute-from'];
  const sourceTraceId = args['source-trace-id'];
  if (recomputeFrom !== undefined && !sourceTraceId) throw new Error('--recompute-from requires --source-trace-id');
  if (recomputeFrom !== undefined && !(STAGE_IDS as readonly string[]).includes(recomputeFrom)) {
    throw new Error(`Invalid --recompute-from: ${recomputeFrom}. Supported: ${STAGE_IDS.join(', ')}`);
  }
  const database = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
  const guarded = database.$extends({ query: { $allOperations: async ({ args: queryArgs, query }) => {
    runLease.assertActive();
    return query(queryArgs);
  } } });
  const prisma = new Proxy(guarded, { get(target,key,receiver) {
    if(key==='$transaction')return (work: any, options: any) => {
      runLease.assertActive();
      if(typeof work !== 'function')return target.$transaction(work,options);
      return target.$transaction(async tx=>{
        const result=await work(tx);
        runLease.assertActive();
        return result;
      },options);
    };
    return Reflect.get(target,key,receiver);
  } }) as unknown as PrismaClient;

  try {
  const resumed = args['resume-trace-id'] ? await readAiCheckpoint(prisma, traceId) : undefined;
  if (resumed) {
    if ((args['as-of'] && getAsOf(args['as-of']).getTime() !== new Date(resumed.asOf).getTime()) || (args.cluster && args.cluster !== resumed.clusterKey)) throw new Error('Resume must retain the checkpoint asOf and cluster');
    asOf = new Date(resumed.asOf); clusterKey = resumed.clusterKey; limit = resumed.limit; maxPerIndustry = resumed.maxPerIndustry;
  }
  await checkpointWork(prisma,traceId,'identity',{asOf,clusterKey,limit,maxPerIndustry,mode:args['from-forecast']==='true'?'forecast':'daily'},async()=>({asOf:asOf.toISOString(),clusterKey,limit,maxPerIndustry}));
  if(args['publish-only'] !== 'true' && (await prisma.runTrace.findUnique({where:{traceId}}))?.status === 'SUCCESS') {
    console.log(JSON.stringify({traceId,status:'SUCCESS',message:'推荐已完成；未重复执行。'}));
    return;
  }
  let aiSession: AiWorkflowSession | undefined;
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

  if (args['from-forecast'] === 'true') {
    const forecastLookbackDays = Number(args['forecast-lookback-days'] ?? 7);
    if (!Number.isFinite(forecastLookbackDays) || forecastLookbackDays <= 0) {
      throw new Error(`Invalid --forecast-lookback-days: ${args['forecast-lookback-days']}`);
    }
    const pgClient = new pg.Client({ connectionString: DATABASE_URL });
    await pgClient.connect();
    try {
      await runFromForecastMode(prisma, pgClient, {
        traceId,
        asOf,
        clusterKey,
        limit,
        maxPerIndustry,
        forecastLookbackDays,
      });
    }
    finally {
      await pgClient.end();
      await prisma.$disconnect();
    }
    return;
  }

  // === 阶段执行器选择：registry 走 executePipeline（14 阶段），legacy 走下方既有串行流程 ===
  const stageExecutor = resolveRunExecutor(args);
  if (stageExecutor === 'registry') {
    if (args['resume-trace-id']) {
      throw new Error('registry 执行器暂不支持 --resume-trace-id；请用 PIPELINE_STAGE_EXECUTOR=legacy 续跑中断的 trace');
    }
    const scoringRecipe = resolveRunScoringRecipe(args);
    let registrySourceTraceId = sourceTraceId;
    if (recomputeFrom !== undefined) {
      if (!registrySourceTraceId) throw new Error('--recompute-from requires --source-trace-id');
      const sourceTrace = await database.runTrace.findUnique({ where: { traceId: registrySourceTraceId } });
      if (!sourceTrace) throw new Error(`--source-trace-id 不存在：${registrySourceTraceId}`);
      if (sourceTrace.traceId === traceId) {
        throw new Error('--recompute-from 必须使用新的 trace id（不能与 --source-trace-id 相同）');
      }
      const sourceAsOf = new Date(sourceTrace.asOf);
      if (args['as-of'] && getAsOf(args['as-of']).getTime() !== sourceAsOf.getTime()) {
        throw new Error('--recompute-from 必须沿用源 trace 的 asOf：请去掉 --as-of');
      }
      if (args.cluster && args.cluster !== sourceTrace.clusterKey) {
        throw new Error('--recompute-from 必须沿用源 trace 的 clusterKey：请去掉 --cluster');
      }
      asOf = sourceAsOf;
      clusterKey = String(sourceTrace.clusterKey);
    }
    const registryPgClient = new pg.Client({ connectionString: DATABASE_URL });
    await registryPgClient.connect();
    try {
      await runRegistryDailyPipeline({
        prisma,
        database,
        pgClient: registryPgClient,
        args,
        traceId,
        asOf,
        clusterKey,
        limit,
        maxPerIndustry,
        minExposureFacts,
        tickFlowRefreshIntervalDays,
        stopAfter,
        scoringRecipe,
        recomputeFrom: recomputeFrom as StageId | undefined,
        sourceTraceId: registrySourceTraceId,
        runStartedAt,
        runLease,
      });
    }
    finally {
      await registryPgClient.end();
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
    if (!resumed) {
      await TraceManager.startRunTrace(prisma, traceId, clusterKey, stopAfter === 'none' ? 'DAILY_RECOMMENDATION' : 'NEWS_INGEST', asOf);
      runTraceStarted = true;
    }
    else {
      const existingTrace = await prisma.runTrace.findUnique({ where: { traceId } });
      if (existingTrace?.status === 'SUCCESS') {
        console.log(JSON.stringify({ traceId, status: 'SUCCESS', resumed: false, message: '推荐已完成；未重复执行。' }, null, 2));
        return;
      }
      await prisma.runTrace.update({
        where: { traceId },
        data: { status: 'PENDING', errorMessage: null, completedAt: null },
      });
      runTraceStarted = true;
    }

    let stepStartedAt = markStepStart();
    const prepare = async (): Promise<AiPipelineCheckpoint | undefined> => {
    activeStep = 'news_fetch';
    stepStartedAt = markStepStart();
    await TraceManager.startStepTrace(prisma, traceId, 'news_fetch', {
      clusterKey,
      asOf: asOf.toISOString(),
      requiredSources: ['aktools', 'newsnow'],
      optionalSources: ['sina-finance-roll', 'sina-rss', 'google-news-rss'],
      newsSourceMode: getNewsSourceMode(args),
    });
    const savedNewsInput = await checkpointWork(prisma, traceId, 'news_input', {asOf,clusterKey,version:1}, () => resolveNewsInput(prisma, args, traceId, clusterKey, asOf));
    const newsInput = {...savedNewsInput, articles:savedNewsInput.articles.map(article=>({...article,publishedAt:new Date(article.publishedAt)}))};
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
    const deduplicationReport = new NewsIngestDeduplicationPipeline({ blockingTerms: (await getKeywordDictionary(prisma)).blockingTerms }).process(normalizationReport.processed);
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
      await emitIngestStopSummary({
        prisma,
        pgClient,
        traceId,
        clusterKey,
        asOf,
        stopAfter,
        sourceMode: newsInput.sourceMode,
        sourceSummary: newsInput.sourceSummary,
        rawArticleCount: articles.length,
        normalizedCandidateCount: normalizationReport.processed.length,
        visibleCandidates,
        newsQualityResult,
        stepTimings,
      });
      return undefined;
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
    const aktoolsExposureResult = await checkpointWork(prisma,traceId,'aktools_exposure',{asOf,clusterKey,aktoolsBoardLimit,aktoolsSymbolLimit},()=>new AkToolsStockExposureService({
      baseUrl: DEFAULT_AKTOOLS_BASE_URL,
    }).sync(prisma, {
      traceId,
      asOf,
      clusterKey,
      stockNameBySymbol,
      boardLimit: aktoolsBoardLimit,
      symbolLimit: aktoolsSymbolLimit,
    }));
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
    } = await checkpointWork(prisma,traceId,'tickflow_exposure',{asOf,clusterKey,minExposureFacts,tickFlowRefreshIntervalDays},()=>syncAndVerifyStockExposureFacts({
      prisma,
      traceId,
      clusterKey,
      asOf,
      minExposureFacts,
      tickFlowRefreshIntervalDays,
      stockNameBySymbol,
      syncService: createTickFlowStockExposureServiceFromEnv(),
    }));
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

      return {asOf:asOf.toISOString(),clusterKey,limit,maxPerIndustry,newsInput:{sourceMode:newsInput.sourceMode,sourceSummary:newsInput.sourceSummary},articleCount:articles.length,normalizedCount:normalizationReport.processed.length,visibleCandidates:[...visibleCandidates],newsQualityResult,aktoolsExposureResult,tickflowExposureResult,exposureResult:{...exposureResult},stepTimings};
    };
    const checkpoint = resumed?.exposureResult ? resumed : await checkpointWork(prisma,traceId,'prepared',{asOf,clusterKey,limit,maxPerIndustry},prepare);
    if (!checkpoint) return;
    Object.assign(stepTimings, checkpoint.stepTimings);
    const {newsInput,newsQualityResult,aktoolsExposureResult,tickflowExposureResult,exposureResult}=checkpoint;
    const visibleCandidates = checkpoint.visibleCandidates.map(candidate=>({...candidate,publishedAt:new Date(candidate.publishedAt)})) as INormalizedNewsCandidate[];
    const causalExtractionCandidates=selectExtractionLeaders(filterCausalExtractionCandidates(visibleCandidates));
    if (!causalExtractionCandidates.length) throw new PipelineStopError('causal_signal_extraction','没有命中经营变量/资产主题关键词的新闻');
    let causalSignalResult: Record<string, any>;
    {
      activeStep = 'causal_signal_extraction';
      stepStartedAt=markStepStart();
      const aiConfig = loadAiProviderConfig();
      aiSession=new AiWorkflowSession(database,traceId,runStartedAt+(aiConfig.scheduling?.runTimeoutMs ?? 3600000));
      const activeAiSession=aiSession;
      runLease.controller.signal.addEventListener('abort',()=>activeAiSession.controller.abort(runLease.controller.signal.reason),{once:true});
      await aiSession.start(checkpoint);
      await TraceManager.startStepTrace(prisma, traceId, 'causal_signal_extraction', {
        llmInputCandidates: causalExtractionCandidates.length,
        durable: true,
      });
      causalSignalResult=await new DurableCausalExtractionService(createCausalSignalExtractorFromEnv(),aiSession,aiConfig).execute(prisma,{
        traceId,asOf,clusterKey,news:causalExtractionCandidates.map(candidate=>({id:candidate.id,title:candidate.title,content:candidate.content,source:candidate.source,publishedAt:candidate.publishedAt,reprintWeight:candidate.reprintWeight})),
      });
      if (!causalSignalResult.candidateCount) throw new PipelineStopError('causal_signal_extraction','AI/结构化因果候选为空，严格单向流程停止');
      markStepEnd('causal_signal_extraction',stepStartedAt);
      await TraceManager.completeStepTrace(prisma,traceId,'causal_signal_extraction',causalSignalResult);
      aiSession.controller.signal.throwIfAborted();
      // No downstream stage requires the AI lease.  Release it immediately so
      // a later scoring failure can resume without holding an AI workflow lock.
      await aiSession.close('AI_COMPLETE');
      aiSession=undefined;
      activeStep=null;
    }

    activeStep='graph_snapshot';
    const causalArtifacts=await artifactFingerprint(prisma,{traceId,clusterKey},['causalSignalCandidate']);
    const graph=await runArtifactStage(prisma,traceId,clusterKey,'graph_snapshot',
      {version:'graph-v2',asOf,causalArtifacts},['graphSnapshot'],
      tx=>persistGraphSnapshot(tx,traceId,asOf,clusterKey,visibleCandidates));
    activeStep='expectation_gap';
    const graphArtifacts=await artifactFingerprint(prisma,{traceId,clusterKey},['graphSnapshot']);
    const expectationGapResult=await runArtifactStage(prisma,traceId,clusterKey,'expectation_gap',
      {version:'expectation-v2',asOf,graphArtifacts},['expectationGapSnapshot'],
      tx=>new ExpectationGapService().calculate(tx,{traceId,asOf,clusterKey}));
    activeStep='theme_forecast';
    const expectationArtifacts=await artifactFingerprint(prisma,{traceId,clusterKey},['expectationGapSnapshot']);
    const themeForecastResult=await runArtifactStage(prisma,traceId,clusterKey,'theme_forecast',
      {version:'theme-v2',asOf,causalArtifacts,expectationArtifacts},['themeForecast'],
      tx=>new ThemeForecastService().generate(tx,{traceId,asOf,clusterKey}));
    // NOTE: 主题对账 / 关键词惩罚 / 自提升建议 已从「发布之前」移到「发布之后」（见下方
    // POST_PROCESSING 区块），其核心约束是：后处理失败绝不能撤销、也不能阻断已经完成的发布。
    let themeReconciliationResult: any = null;
    let keywordPerformancePenaltyResult: any;

    // Candle 前置校验：评分前确认 Candle 已同步到 asOf 北京日，避免用旧数据评分
    activeStep = 'candle_preflight_check';
    const candleCheckRows = await runQuery(pgClient, {
      label: 'latest_candle',
      sql: 'SELECT max(c."tradingDay") AS latest FROM "Candle" c JOIN "Stock" s ON c."stockId" = s.id WHERE s."clusterKey" = $1',
      values: [clusterKey],
    });
    const latestCandleRaw = candleCheckRows[0]?.latest;
    const latestCandleDay = latestCandleRaw instanceof Date
      ? getBeijingDateKey(latestCandleRaw)
      : null;
    const asOfBeijingDay = getBeijingDateKey(asOf);
    const expectedTradingDay = await resolveExpectedLatestTradingDay(asOf);
    if (latestCandleDay === null || latestCandleDay < expectedTradingDay) {
      const gapDays = latestCandleDay === null
        ? 'unknown'
        : Math.round((new Date(expectedTradingDay).getTime() - new Date(latestCandleDay).getTime()) / ONE_DAY_MS);
      console.error(`[candle_check] FAIL 最新 Candle 日=${latestCandleDay}, 期望交易日=${expectedTradingDay}, asOf 日=${asOfBeijingDay}, 差值=${gapDays} 天`);
      throw new PipelineStopError(
        'candle_stale',
        `Candle 数据未同步到期望交易日：最新 Candle 日=${latestCandleDay}, 期望=${expectedTradingDay}, asOf 日=${asOfBeijingDay}, 差值=${gapDays} 天，停止推荐`,
      );
    }
    console.log(`[candle_check] OK 最新 Candle 日=${latestCandleDay}, 期望交易日=${expectedTradingDay}, asOf 日=${asOfBeijingDay}, 校验通过`);
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
      // 区分「证据为空」与「候选被质量门槛全部过滤」：
      // 证据为空 → 保持现状语义，抛错停止；候选被全部过滤 → 记录 COMPLETE_EMPTY，不抛错、不发布。
      const evidenceCount = await prisma.evidenceContribution.count({ where: { traceId } });
      const decision = classifyEmptyResult({ recommendationsCreated: 0, evidenceCount });
      if (decision === 'complete_empty') {
        await recordCompleteEmpty(prisma, traceId, `证据存在(${evidenceCount}条)但候选被质量门槛全部过滤，无推荐产出`);
        console.log(JSON.stringify({
          traceId,
          asOf: asOf.toISOString(),
          clusterKey,
          status: 'COMPLETE_EMPTY',
          reason: '候选被质量门槛全部过滤',
          evidenceCount,
        }, null, 2));
        return;
      }
      throw new PipelineStopError('recommendation', '推荐结果为空，严格单向流程停止');
    }
    markStepEnd('scoring_recommendation', stepStartedAt);
    activeStep = null;

    const strategyResult = backtestResult.strategyResult;

    // === 发布提交：在推荐生成后立即完成，且置于后处理之前 ===
    // publishRecommendation 在单个事务内创建 RecommendationPublish 记录并置 isPublished（兼容读路径）；
    // completeRunTrace 标记 SUCCESS + isPublished。二者均在后处理之前执行，
    // 确保「后处理（对账/惩罚/自提升）失败」无法撤销或阻断已发布的原子结果。
    activeStep = 'publish';
    const generationMetrics = {
      sourceMode: newsInput.sourceMode,
      sourceSummary: newsInput.sourceSummary,
      rawArticles: checkpoint.articleCount,
      normalizedCandidates: checkpoint.normalizedCount,
      visibleCandidates: visibleCandidates.length,
      reprintGroups: countReprintGroups(visibleCandidates),
      reprintPenalized: countReprintPenalized(visibleCandidates),
      newsQuality: newsQualityResult,
      stockExposureFactsVisible: exposureResult.factCount,
      stockExposureSymbolsVisible: exposureResult.symbolCount,
      aktoolsExposure: aktoolsExposureResult,
      tickflowExposure: tickflowExposureResult,
      causalSignalCandidates: causalSignalResult?.candidateCount ?? 0,
      graphNodes: graph.nodeCount,
      graphEdges: graph.edgeCount,
      graphCausalSignalInputs: graph.causalSignalCount,
      expectationGap: expectationGapResult,
      themeForecast: themeForecastResult,
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
    };
    await TraceManager.completeRunTrace(prisma, traceId, generationMetrics);
    const publishResult: PublishRecommendationResult = await publishRecommendation(prisma, {
      traceId,
      clusterKey,
      asOf,
      auditStatus: 'pass',
      reason: 'daily_auto_publish',
    });
    console.log(`[publish] trace=${traceId} 已发布 v${publishResult.publishVersion} reused=${publishResult.reused}`);
    activeStep = null;


    // === 后处理（对账 / 惩罚 / 自提升）：必须在发布之后执行；失败绝不撤销已发布结果 ===
    let postProcessingError: string | null = null;
    let autopilotEvalResult: { evaluated: boolean; proposals: readonly unknown[] } = { evaluated: false, proposals: [] };
    try {
      // 1) 主题对账
      activeStep = 'theme_forecast_reconciliation';
      stepStartedAt = markStepStart();
      await TraceManager.startStepTrace(prisma, traceId, 'theme_forecast_reconciliation', {
        clusterKey,
        asOf: asOf.toISOString(),
        source: 'reconciled_recommendation_snapshot',
      });
      themeReconciliationResult = await new ThemeForecastReconciliationService().reconcile(prisma, { asOf, clusterKey });
      markStepEnd('theme_forecast_reconciliation', stepStartedAt);
      await TraceManager.completeStepTrace(prisma, traceId, 'theme_forecast_reconciliation', {
        ...(themeReconciliationResult ?? {}),
        elapsedMs: stepTimings.theme_forecast_reconciliation,
      });
      activeStep = null;

      // 2) 关键词惩罚刷新
      {
        activeStep = 'keyword_performance_penalty_refresh';
        stepStartedAt = markStepStart();
        await TraceManager.startStepTrace(prisma, traceId, 'keyword_performance_penalty_refresh', {
          clusterKey,
          asOf: asOf.toISOString(),
          source: 'reconciled_recommendation_snapshot',
          cooldownDays: 7,
        });
        keywordPerformancePenaltyResult = await new KeywordPerformancePenaltyService().refresh(prisma, {
          asOf,
          clusterKey,
        });
        markStepEnd('keyword_performance_penalty_refresh', stepStartedAt);
        await TraceManager.completeStepTrace(prisma, traceId, 'keyword_performance_penalty_refresh', {
          ...keywordPerformancePenaltyResult,
          elapsedMs: stepTimings.keyword_performance_penalty_refresh,
        });
        activeStep = null;
      }

      // 3) 自提升建议（集团升级评估）
      activeStep = 'autopilot_evaluation';
      stepStartedAt = markStepStart();
      await TraceManager.startStepTrace(prisma, traceId, 'autopilot_evaluation', {
        clusterKey,
        asOf: asOf.toISOString(),
        description: '集团自提升：双指标监控 → 生成升级建议（不自动升级）',
      });
      try {
        const runtimeStateStore = {
          read: async () => {
            try {
              const raw = await readFile(path.resolve(process.cwd(), 'tmp', 'http-runtime', 'runtime-store.json'), 'utf8');
              return JSON.parse(raw) as { readonly autopilot_policies: Readonly<Record<string, Record<string, unknown>>> };
            } catch {
              return { autopilot_policies: {} as Record<string, Record<string, unknown>> };
            }
          },
        };
        const proposalService = new ClusterUpgradeProposalService(runtimeStateStore);
        const proposalResult = await proposalService.evaluateAndPropose(prisma, {
          groupId: clusterKey,
          asOf,
          clusterKey,
        });
        autopilotEvalResult = {
          evaluated: true,
          proposals: proposalResult.shouldPropose
            ? [{
                groupId: proposalResult.groupId,
                triggers: proposalResult.triggers,
                failureReasons: proposalResult.failureReasons,
                proposal: proposalResult.proposal,
                recommendationStats: proposalResult.recommendationStats,
                themeForecastStats: proposalResult.themeForecastStats,
              }]
            : [],
        };
        if (proposalResult.shouldPropose) {
          console.log(`[autopilot_evaluation] ⚠️ 集团 ${clusterKey} 触发升级建议：${proposalResult.failureReasons.join('; ')}`);
        }
      } catch (error) {
        autopilotEvalResult = { evaluated: false, proposals: [] };
        console.error(`[autopilot_evaluation] 评估失败：${error instanceof Error ? error.message : String(error)}`);
      }
      markStepEnd('autopilot_evaluation', stepStartedAt);
      await TraceManager.completeStepTrace(prisma, traceId, 'autopilot_evaluation', {
        ...autopilotEvalResult,
        elapsedMs: stepTimings.autopilot_evaluation,
      });
      activeStep = null;
    } catch (error) {
      // 后处理整体失败：已发布的原子结果不受影响，仅记录错误状态。
      postProcessingError = error instanceof Error ? error.message : String(error);
      console.error(`[post_processing] 后处理失败（已发布结果不受影响）：${postProcessingError}`);
    }

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

    // 发布已在推荐生成后立即完成（见上方 PUBLISH 区块）。此处仅把后处理结果与错误状态合入
    // RunTrace.metrics，不再触碰 isPublished / 发布记录，确保后处理失败不会撤销已发布结果。
    await prisma.runTrace.update({
      where: { traceId },
      data: {
        metrics: {
          ...generationMetrics,
          themeReconciliation: themeReconciliationResult,
          keywordPerformancePenalty: keywordPerformancePenaltyResult,
          autopilot: autopilotEvalResult,
          postProcessingError,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    console.log(JSON.stringify({
      traceId,
      asOf: asOf.toISOString(),
      beijingAsOf: '2026-05-24 23:59:59.999 UTC+8',
      clusterKey,
      sourceMode: newsInput.sourceMode,
      sourceSummary: newsInput.sourceSummary,
      stages: {
        rawArticles: checkpoint.articleCount,
        normalizedCandidates: checkpoint.normalizedCount,
        visibleCandidates: visibleCandidates.length,
        graphNodes: graph.nodeCount,
        graphEdges: graph.edgeCount,
        graphCausalSignalInputs: graph.causalSignalCount,
        stockExposureFactsVisible: exposureResult.factCount,
        stockExposureSymbolsVisible: exposureResult.symbolCount,
        aktoolsExposure: aktoolsExposureResult,
        tickflowExposure: tickflowExposureResult,
        keywordPerformancePenalty: keywordPerformancePenaltyResult,
        causalSignalCandidates: causalSignalResult?.candidateCount ?? 0,
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
    const resumable=error instanceof AiPausedError || error instanceof AiNeedsAttentionError;
    const status=error instanceof AiPausedError?'PAUSED':error instanceof AiNeedsAttentionError?'NEEDS_ATTENTION':'FAILED';
    if(aiSession) await aiSession.close(status).catch(()=>undefined);
    if(resumable && runTraceStarted) {
      await database.runTrace.update({where:{traceId},data:{status,errorMessage:message,completedAt:null}});
      if(activeStep) await database.pipelineStepTrace.updateMany({where:{traceId,stepName:activeStep},data:{status,errorMessage:message,endedAt:null}});
      throw error;
    }
    if (runTraceStarted) {
      if (activeStep) {
        try {
          await TraceManager.failStepTrace(database, traceId, activeStep, message);
        }
        catch {}
      }
      try {
        await TraceManager.failRunTrace(database, traceId, message);
      }
      catch {}
    }
    throw error;
  }
  finally {
    await pgClient.end();
    await prisma.$disconnect();
  }
  } finally { await database.$disconnect(); }
}

async function main(): Promise<void> {
  const args = parseArgs();
  args['trace-id'] = args['resume-trace-id'] ?? args['trace-id'] ?? createTraceId(getAsOf(args['as-of']), args.cluster ?? DEFAULT_CLUSTER_KEY);
  const lease = new PipelineRunLease(DATABASE_URL, args['trace-id']);
  await lease.start(3600000);
  const originalFetch=globalThis.fetch;
  globalThis.fetch=((request: Parameters<typeof fetch>[0], init?: RequestInit) => {
    lease.assertActive();
    const signals=[lease.controller.signal, ...(init?.signal?[init.signal]:[]), ...(request instanceof Request?[request.signal]:[])];
    return originalFetch(request,{...init,signal:AbortSignal.any(signals)});
  }) as typeof fetch;
  try { await executeMain(args, lease); }
  finally { globalThis.fetch=originalFetch; await lease.close(); }
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
