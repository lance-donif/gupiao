import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import pg from 'pg';

import { BacktestEngine } from '../src/services/backtest-engine.js';
import {
  CausalSignalExtractionService,
  createCausalSignalExtractorFromEnv,
} from '../src/services/causal-signal-extraction-service.js';
import { AkToolsStockExposureService } from '../src/services/aktools-stock-exposure-service.js';
import { ExpectationGapService } from '../src/services/expectation-gap-service.js';
import { ClusterUpgradeProposalService } from '../src/services/cluster-upgrade-proposal-service.js';
import { createFriendNetworkEngine } from '../src/services/friend-network-engine.js';
import { KeywordPerformancePenaltyService } from '../src/services/keyword-performance-penalty-service.js';
import { ThemeForecastReconciliationService } from '../src/services/theme-forecast-reconciliation-service.js';
import { ThemeForecastService } from '../src/services/theme-forecast-service.js';
import {
  NewsIngestDeduplicationPipeline,
  NewsIngestNormalizationPipeline,
  type INormalizedNewsCandidate,
} from '../src/services/news-ingest-pipeline.js';
import { loadBackendEnv } from '../src/services/load-backend-env.js';
import { createTickFlowStockExposureServiceFromEnv } from '../src/services/tickflow-stock-exposure-service.js';
import { TraceManager } from '../src/services/trace-manager.js';
import { StrategyExperimentRunner } from '../src/services/strategy-runner.js';
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
const DEFAULT_CAUSAL_SIGNAL_BATCH_SIZE = 10;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
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
    causalSignals,
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
    causalSignalCount: causalSignals.length,
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
    const sourceTrace = await prisma.runTrace.findFirst({
      where: {
        clusterKey,
        status: 'SUCCESS',
        kind: 'DAILY_RECOMMENDATION',
        asOf: { lte: asOf },
      },
      orderBy: { asOf: 'desc' },
    });
    if (!sourceTrace) {
      throw new PipelineStopError(
        'forecast_source_resolve',
        `未找到 asOf=${asOf.toISOString()} 之前成功的 DAILY_RECOMMENDATION trace，无法复用因果信号`,
      );
    }
    const sourceTraceId = String(sourceTrace.traceId);
    console.log(`[from-forecast] 复用源 trace=${sourceTraceId} asOf=${sourceTrace.asOf.toISOString()}`);
    activeStep = null;

    // 2. Candle 前置校验（复用 Task 2 逻辑，确保评分用最新 Candle）
    activeStep = 'candle_preflight_check';
    const candleCheckRows = await runQuery(pgClient, {
      label: 'latest_candle',
      sql: 'SELECT max("tradingDay") AS latest FROM "Candle"',
      values: [],
    });
    const latestCandleRaw = candleCheckRows[0]?.latest;
    const latestCandleDay = latestCandleRaw instanceof Date
      ? getBeijingDateKey(latestCandleRaw)
      : null;
    const asOfBeijingDay = getBeijingDateKey(asOf);
    if (latestCandleDay === null || latestCandleDay < asOfBeijingDay) {
      const gapDays = latestCandleDay === null
        ? 'unknown'
        : Math.round((new Date(asOfBeijingDay).getTime() - new Date(latestCandleDay).getTime()) / ONE_DAY_MS);
      throw new PipelineStopError(
        'candle_stale',
        `Candle 数据未同步到 asOf 北京日：最新=${latestCandleDay}, asOf=${asOfBeijingDay}, 差值=${gapDays} 天，停止推荐`,
      );
    }
    console.log(`[candle_check] OK 最新 Candle 日=${latestCandleDay}, asOf 日=${asOfBeijingDay}`);
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
    const copiedSignals = typeof prisma.$executeRawUnsafe === 'function'
      ? await prisma.$executeRawUnsafe(
        [
          'INSERT INTO "CausalSignalCandidate" (',
          '  id, "traceId", "asOf", "clusterKey", "newsId", event, "businessVariable",',
          '  "assetOrThemeKeyword", direction, confidence, "evidenceText",',
          '  "evidenceOffsetStart", "evidenceOffsetEnd", "extractorType", "modelVersion",',
          '  "promptVersion", status, "failureReason", "createdAt", "updatedAt"',
          ')',
          'SELECT',
          '  gen_random_uuid(), $1, "asOf", "clusterKey", "newsId", event, "businessVariable",',
          '  "assetOrThemeKeyword", direction, confidence, "evidenceText",',
          '  "evidenceOffsetStart", "evidenceOffsetEnd", "extractorType", "modelVersion",',
          '  "promptVersion", status, "failureReason", NOW(), NOW()',
          'FROM "CausalSignalCandidate"',
          'WHERE "traceId" = $2 AND status = \'candidate\'',
        ].join(' '),
        traceId,
        sourceTraceId,
      )
      : 0;
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
  const causalSignalConcurrency = Number(args['causal-signal-concurrency'] ?? process.env.CAUSAL_SIGNAL_CONCURRENCY ?? 20);
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
    let causalSignalResult: any = null;
    const maxStepRetries = 3;
    const stepRetryDelayMs = 5 * 60 * 1000; // 5 minutes

    for (let attempt = 1; attempt <= maxStepRetries; attempt++) {
      if (attempt > 1) {
        // Clean up previous attempt's step trace row to avoid compound primary key constraint violation
        try {
          await prisma.pipelineStepTrace.delete({
            where: {
              traceId_stepName: {
                traceId,
                stepName: 'causal_signal_extraction',
              },
            },
          });
        } catch {}
      }

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
        concurrency: causalSignalConcurrency,
        retryAttempt: attempt,
      });

      try {
        causalSignalResult = await new CausalSignalExtractionService(createCausalSignalExtractorFromEnv()).execute(prisma, {
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
          concurrency: Number.isFinite(causalSignalConcurrency) ? causalSignalConcurrency : 20,
          onBatchComplete: event => console.log(
            `[causal_signal_extraction] batch ${event.batchIndex}/${event.batchCount} size=${event.batchSize} elapsedMs=${event.elapsedMs} signalCount=${event.signalCount}`,
          ),
        });
        if (causalSignalResult.candidateCount === 0) {
          throw new PipelineStopError('causal_signal_extraction', 'AI/结构化因果候选为空，严格单向流程停止');
        }
        markStepEnd('causal_signal_extraction', stepStartedAt);
        await TraceManager.completeStepTrace(prisma, traceId, 'causal_signal_extraction', causalSignalResult);
        break;
      } catch (error) {
        if (error instanceof PipelineStopError) {
          throw error;
        }
        console.error(`[causal_signal_extraction] Attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);

        try {
          await TraceManager.failStepTrace(prisma, traceId, 'causal_signal_extraction', error instanceof Error ? error.message : String(error));
        } catch {}

        if (attempt === maxStepRetries) {
          throw error;
        }
        console.log(`[causal_signal_extraction] Waiting ${stepRetryDelayMs / 1000}s before retrying...`);
        await new Promise(resolve => setTimeout(resolve, stepRetryDelayMs));
      }
    }
    activeStep = null;

    activeStep = 'graph_snapshot';
    stepStartedAt = markStepStart();
    const graph = await persistGraphSnapshot(prisma, traceId, asOf, clusterKey, visibleCandidates);
    markStepEnd('graph_snapshot', stepStartedAt);
    activeStep = null;

    activeStep = 'expectation_gap';
    stepStartedAt = markStepStart();
    await TraceManager.startStepTrace(prisma, traceId, 'expectation_gap', {
      clusterKey,
      asOf: asOf.toISOString(),
      description: '弱信号/预期差：图谱强度 vs 股价5日反应',
    });
    const expectationGapResult = await new ExpectationGapService().calculate(prisma, {
      traceId,
      asOf,
      clusterKey,
    });
    markStepEnd('expectation_gap', stepStartedAt);
    await TraceManager.completeStepTrace(prisma, traceId, 'expectation_gap', {
      ...expectationGapResult,
      weakSignalKeywords: expectationGapResult.topGaps
        .filter(item => item.isWeakSignal)
        .map(item => ({ keyword: item.keyword, expectationGap: item.expectationGap, relatedSymbols: item.relatedSymbols.slice(0, 5) })),
      elapsedMs: stepTimings.expectation_gap,
    });
    activeStep = null;

    activeStep = 'theme_forecast';
    stepStartedAt = markStepStart();
    await TraceManager.startStepTrace(prisma, traceId, 'theme_forecast', {
      clusterKey,
      asOf: asOf.toISOString(),
      horizon: 5,
      description: '主题/资产级预测：因果信号 + 预期差 → 未来5日上涨概率',
    });
    const themeForecastResult = await new ThemeForecastService().generate(prisma, {
      traceId,
      asOf,
      clusterKey,
    });
    // 对账历史预测（独立于今日预测，评估过往准确率）
    const themeReconciliationResult = await new ThemeForecastReconciliationService().reconcile(prisma, {
      asOf,
      clusterKey,
    });
    markStepEnd('theme_forecast', stepStartedAt);
    await TraceManager.completeStepTrace(prisma, traceId, 'theme_forecast', {
      forecast: themeForecastResult,
      reconciliation: themeReconciliationResult,
      topBullish: themeForecastResult.topForecasts
        .filter(item => item.direction === 'bullish')
        .slice(0, 10)
        .map(item => ({ theme: item.theme, probability: item.probability, relatedSymbols: item.relatedSymbols.slice(0, 5), weakSignal: item.evidenceChain.weakSignal })),
      elapsedMs: stepTimings.theme_forecast,
    });
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

    // Candle 前置校验：评分前确认 Candle 已同步到 asOf 北京日，避免用旧数据评分
    activeStep = 'candle_preflight_check';
    const candleCheckRows = await runQuery(pgClient, {
      label: 'latest_candle',
      sql: 'SELECT max("tradingDay") AS latest FROM "Candle"',
      values: [],
    });
    const latestCandleRaw = candleCheckRows[0]?.latest;
    const latestCandleDay = latestCandleRaw instanceof Date
      ? getBeijingDateKey(latestCandleRaw)
      : null;
    const asOfBeijingDay = getBeijingDateKey(asOf);
    if (latestCandleDay === null || latestCandleDay < asOfBeijingDay) {
      const gapDays = latestCandleDay === null
        ? 'unknown'
        : Math.round((new Date(asOfBeijingDay).getTime() - new Date(latestCandleDay).getTime()) / ONE_DAY_MS);
      console.error(`[candle_check] FAIL 最新 Candle 日=${latestCandleDay}, asOf 日=${asOfBeijingDay}, 差值=${gapDays} 天`);
      throw new PipelineStopError(
        'candle_stale',
        `Candle 数据未同步到 asOf 北京日：最新 Candle 日=${latestCandleDay}, asOf 日=${asOfBeijingDay}, 差值=${gapDays} 天，停止推荐`,
      );
    }
    console.log(`[candle_check] OK 最新 Candle 日=${latestCandleDay}, asOf 日=${asOfBeijingDay}, 校验通过`);
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

    activeStep = 'autopilot_evaluation';
    stepStartedAt = markStepStart();
    await TraceManager.startStepTrace(prisma, traceId, 'autopilot_evaluation', {
      clusterKey,
      asOf: asOf.toISOString(),
      description: '集团自提升：双指标监控 → 生成升级建议（不自动升级）',
    });
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
      causalSignalCandidates: causalSignalResult?.candidateCount ?? 0,
      graphNodes: graph.nodeCount,
      graphEdges: graph.edgeCount,
      graphCausalSignalInputs: graph.causalSignalCount,
      expectationGap: expectationGapResult,
      themeForecast: themeForecastResult,
      themeReconciliation: themeReconciliationResult,
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
