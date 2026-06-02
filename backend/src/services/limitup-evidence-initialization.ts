import type {
  ICoverageGapCaseRecord,
  IHistoricalLimitUpCaseRecord,
  IKeywordAliasRecord,
} from '../repositories/coverage-initialization-repository.js';

import crypto from 'node:crypto';

import { Prisma } from '@prisma/client';
import { CoverageInitializationRepository } from '../repositories/coverage-initialization-repository.js';

export type LimitUpCaseMode = 'touch' | 'sealed';
export type CoverageGapMissReason = 'no_evidence_chain' | 'score_too_low' | 'filtered_out' | 'not_in_stock_pool';

export interface IHistoricalLimitUpCaseRebuildInput {
  readonly traceId: string;
  readonly clusterKey: string;
  readonly asOf: Date;
  readonly days?: number;
  readonly mode?: LimitUpCaseMode;
}

export interface IHistoricalLimitUpCaseRebuildResult {
  readonly traceId: string;
  readonly clusterKey: string;
  readonly tradingDayCount: number;
  readonly caseCount: number;
  readonly touchCount: number;
  readonly sealedCount: number;
  readonly insertedCount: number;
}

export interface ICoverageGapAnalysisInput {
  readonly traceId: string;
  readonly clusterKey: string;
  readonly asOf: Date;
  readonly targetDate: Date;
  readonly mode?: LimitUpCaseMode;
  readonly lowScoreThreshold?: number;
}

export interface ICoverageGapAnalysisResult {
  readonly traceId: string;
  readonly clusterKey: string;
  readonly targetDate: Date;
  readonly limitUpCaseCount: number;
  readonly selectedCount: number;
  readonly unselectedCount: number;
  readonly insertedGapCount: number;
  readonly reasonCounts: Readonly<Record<string, number>>;
  readonly gaps: readonly ICoverageGapCaseRecord[];
}

export interface IHistoricalNewsWindowInput {
  readonly clusterKey: string;
  readonly tradeDate: Date;
  readonly lookbackDays?: number;
}

export interface IHistoricalNewsWindow {
  readonly status: 'ready' | 'news_missing';
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly news: readonly IHistoricalNewsRecord[];
}

export interface IHistoricalNewsRecord {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly source: string;
  readonly publishedAt: Date;
}

export interface IExposureCandidateDraft {
  readonly keyword: string;
  readonly exposureType: 'industry_exposure' | 'concept_exposure' | 'business_exposure';
  readonly sourceId: string;
  readonly sourceName?: string;
  readonly evidenceText: string;
  readonly confidence: number;
  readonly taxonomyLevel?: string | null;
  readonly memberCount?: number | null;
  readonly aliasSuggestions?: readonly IAliasSuggestionDraft[];
}

export interface IAliasSuggestionDraft {
  readonly sourceKeyword: string;
  readonly canonicalKeyword: string;
  readonly relationType?: string;
  readonly confidence?: number;
  readonly evidenceText?: string;
}

export interface IExposureCandidateExtractionInput {
  readonly limitUpCase: Record<string, unknown>;
  readonly news: readonly IHistoricalNewsRecord[];
}

export interface IExposureCandidateExtractor {
  readonly modelVersion: string;
  readonly promptVersion: string;
  extract: (input: IExposureCandidateExtractionInput) => Promise<readonly IExposureCandidateDraft[]>;
}

export interface IGenerateExposureCandidatesInput {
  readonly traceId: string;
  readonly clusterKey: string;
  readonly asOf: Date;
  readonly days?: number;
  readonly limitCases?: number;
  readonly concurrency?: number;
  readonly maxNewsPerCase?: number;
  readonly onProgress?: (progress: IGenerateExposureCandidatesProgress) => void;
  readonly source?: string;
  readonly dryRun?: boolean;
  readonly maxRequestChars?: number;
}

export interface IGenerateExposureCandidatesProgress {
  readonly processedCaseCount: number;
  readonly totalCaseCount: number;
  readonly candidateCount: number;
  readonly llmCaseCount: number;
  readonly newsMissingCount: number;
  readonly skippedInvalidCount: number;
}

export interface IGenerateExposureCandidatesResult {
  readonly gapCaseCount: number;
  readonly newsMissingCount: number;
  readonly llmCaseCount: number;
  readonly candidateCount: number;
  readonly insertedCount: number;
  readonly skippedInvalidCount: number;
}

export interface IGenerateRuleBasedAliasCandidatesInput {
  readonly traceId: string;
  readonly sourceTraceId: string;
  readonly clusterKey: string;
  readonly asOf: Date;
  readonly status?: string;
  readonly minConfidence?: number;
  readonly max?: number;
  readonly dryRun?: boolean;
}

export interface IGenerateRuleBasedAliasCandidatesResult {
  readonly gapCaseCount: number;
  readonly signalCount: number;
  readonly generatedAliasCount: number;
  readonly insertedAliasCount: number;
  readonly skippedNoExposureCount: number;
  readonly skippedLowConfidenceCount: number;
}

export interface IPromoteKeywordAliasCandidatesInput {
  readonly clusterKey: string;
  readonly status?: string;
  readonly validFrom: Date;
  readonly max?: number;
  readonly dryRun?: boolean;
}

export interface IPromoteKeywordAliasCandidatesResult {
  readonly candidateCount: number;
  readonly promotedCount: number;
  readonly rejectedCount?: number;
}

export interface IPromoteValidatedEvidenceInput {
  readonly clusterKey: string;
  readonly status?: string;
  readonly max?: number;
  readonly validFrom: Date;
  readonly dryRun?: boolean;
}

export interface IPromoteValidatedEvidenceResult {
  readonly candidateCount: number;
  readonly promotedFactCount: number;
  readonly promotedAliasCount: number;
  readonly rejectedCount: number;
}

export interface IValidateExposureCandidatesInput {
  readonly clusterKey: string;
  readonly status?: string;
  readonly max?: number;
  readonly dryRun?: boolean;
}

export interface IValidateExposureCandidatesResult {
  readonly candidateCount: number;
  readonly validatedCount: number;
  readonly rejectedCount: number;
}

export interface IFactSnapshotResult {
  readonly traceId: string;
  readonly clusterKey: string;
  readonly asOf: Date;
  readonly factHash: string;
  readonly activeExposureCount: number;
  readonly activeAliasCount: number;
}

export interface ICoverageGapLoopInput {
  readonly traceId: string;
  readonly clusterKey: string;
  readonly asOf: Date;
  readonly tradeDate: Date;
  readonly concurrency?: number;
  readonly maxNewsPerCase?: number;
  readonly dryRun?: boolean;
  readonly extractor?: IExposureCandidateExtractor;
}

export interface ICoverageGapLoopResult {
  readonly rebuild: IHistoricalLimitUpCaseRebuildResult;
  readonly gapAnalysis: ICoverageGapAnalysisResult;
  readonly candidateGeneration: IGenerateExposureCandidatesResult;
}

const BEIJING_DATE_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const DEFAULT_MAX_REQUEST_CHARS = 240_000;
const DEFAULT_MAX_LLM_NEWS_PER_CASE = 120;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toDate = (value: unknown): Date => {
  if (value instanceof Date) {
    return value;
  }
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid date: ${String(value)}`);
  }
  return parsed;
};

const toBeijingDate = (date: Date): string => BEIJING_DATE_FORMATTER.format(date);

const beijingDateTime = (date: string, time: string): Date => new Date(`${date}T${time}+08:00`);

const shiftBeijingDate = (date: string, offsetDays: number): string => {
  const base = beijingDateTime(date, '00:00:00');
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return toBeijingDate(base);
};

export const resolveHistoricalNewsWindowBounds = (
  tradeDate: Date,
  lookbackDays = 3,
): { readonly windowStart: Date; readonly windowEnd: Date } => {
  const tradeBeijingDate = toBeijingDate(tradeDate);
  return {
    windowStart: beijingDateTime(shiftBeijingDate(tradeBeijingDate, -lookbackDays), '00:00:00'),
    windowEnd: beijingDateTime(tradeBeijingDate, '15:00:00'),
  };
};

const roundPrice2 = (value: number): number => Math.round(value * 100) / 100;

export const resolveLimitRule = (
  symbol: string,
  stockName: string,
): { readonly boardType: string; readonly limitThresholdPct: number } => {
  const normalizedName = stockName.toLocaleUpperCase('zh-CN');
  if (normalizedName.startsWith('*ST') || normalizedName.startsWith('ST')) {
    return { boardType: 'ST', limitThresholdPct: 0.05 };
  }
  if (symbol.startsWith('300') || symbol.startsWith('301')) {
    return { boardType: 'CHINEXT', limitThresholdPct: 0.20 };
  }
  if (symbol.startsWith('68')) {
    return { boardType: 'STAR', limitThresholdPct: 0.20 };
  }
  if (symbol.startsWith('8') || symbol.startsWith('4') || symbol.startsWith('9')) {
    return { boardType: 'BEIJING', limitThresholdPct: 0.30 };
  }
  return { boardType: 'MAIN', limitThresholdPct: 0.10 };
};

const normalizeSourceText = (value: string): string => value.replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');

const evidenceTextExists = (news: IHistoricalNewsRecord | null, evidenceText: string): boolean => {
  if (!news || evidenceText.trim().length === 0) {
    return false;
  }
  return normalizeSourceText(`${news.title}。${news.content}`).includes(normalizeSourceText(evidenceText));
};

const stableHash = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

const sortByStableJson = <T>(rows: readonly T[]): readonly T[] => {
  return [...rows].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
};

const readNewsRecord = (row: Record<string, unknown>): IHistoricalNewsRecord => ({
  id: String(row.id),
  title: String(row.title ?? ''),
  content: String(row.content ?? ''),
  source: String(row.source ?? 'unknown'),
  publishedAt: toDate(row.publishedAt),
});

const tokenizeForNewsRelevance = (value: unknown): readonly string[] => {
  const text = String(value ?? '').trim();
  if (!text) {
    return [];
  }
  const compact = text.replace(/\s+/gu, '');
  const tokens = new Set<string>();
  if (compact.length >= 2 && /[\u4E00-\u9FFF]/u.test(compact)) {
    tokens.add(compact);
  }
  for (const token of text.split(/[^A-Za-z0-9\u4E00-\u9FFF]+/u)) {
    const normalized = token.trim();
    if (normalized.length >= 2) {
      tokens.add(normalized);
    }
  }
  return [...tokens];
};

const buildNewsRelevanceTerms = (limitUpCase: Record<string, unknown>, exposures: readonly Record<string, unknown>[]): readonly string[] => {
  const terms = new Set<string>();
  for (const token of tokenizeForNewsRelevance(limitUpCase.symbol)) {
    terms.add(token);
  }
  for (const token of tokenizeForNewsRelevance(limitUpCase.stockName)) {
    terms.add(token);
  }
  for (const token of tokenizeForNewsRelevance(limitUpCase.resolvedStockName)) {
    terms.add(token);
  }
  for (const exposure of exposures) {
    for (const token of tokenizeForNewsRelevance(exposure.stockName)) {
      terms.add(token);
    }
    for (const token of tokenizeForNewsRelevance(exposure.keyword)) {
      terms.add(token);
    }
  }
  return [...terms];
};

const resolveStockNameForLimitUpCase = (gapCase: Record<string, unknown>, exposures: readonly Record<string, unknown>[]): string => {
  const candidate = exposures
    .map(exposure => String(exposure.stockName ?? '').trim())
    .find(name => /[\u4E00-\u9FFF]/u.test(name));
  return candidate ?? String(gapCase.stockName ?? '');
};

const buildKnownExposuresForPrompt = (exposures: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] => {
  return exposures
    .map(exposure => ({
      keyword: String(exposure.keyword ?? ''),
      exposureType: String(exposure.exposureType ?? ''),
      taxonomyLevel: exposure.taxonomyLevel ?? null,
      source: String(exposure.source ?? ''),
    }))
    .filter(exposure => exposure.keyword.length > 0)
    .slice(0, 12);
};

const scoreNewsRelevance = (news: IHistoricalNewsRecord, terms: readonly string[]): number => {
  const haystack = `${news.title}\n${news.content}`;
  let score = 0;
  for (const term of terms) {
    if (news.title.includes(term)) {
      score += 4;
    }
    if (haystack.includes(term)) {
      score += 1;
    }
  }
  return score;
};

const selectNewsForLimitUpCase = (
  news: readonly IHistoricalNewsRecord[],
  limitUpCase: Record<string, unknown>,
  exposures: readonly Record<string, unknown>[],
  maxNews = DEFAULT_MAX_LLM_NEWS_PER_CASE,
): readonly IHistoricalNewsRecord[] => {
  if (news.length <= maxNews) {
    return news;
  }
  const terms = buildNewsRelevanceTerms(limitUpCase, exposures);
  return news
    .map(item => ({
      item,
      score: scoreNewsRelevance(item, terms),
    }))
    .sort((left, right) => {
      const scoreCompare = right.score - left.score;
      if (scoreCompare !== 0) {
        return scoreCompare;
      }
      return right.item.publishedAt.getTime() - left.item.publishedAt.getTime();
    })
    .slice(0, maxNews)
    .map(row => row.item)
    .sort((left, right) => left.publishedAt.getTime() - right.publishedAt.getTime());
};

const incrementReason = (
  counts: Record<string, number>,
  reason: string,
): void => {
  counts[reason] = (counts[reason] ?? 0) + 1;
};

const buildTradingDateKey = (date: Date): string => date.toISOString().slice(0, 10);

const startOfUtcDate = (value: Date): Date => {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
};

const nextUtcDate = (value: Date): Date => {
  const next = startOfUtcDate(value);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
};

const normalizeKeywordForRule = (value: unknown): string => {
  return String(value ?? '')
    .replace(/\s+/gu, '')
    .replace(/[()（）【】[\]《》"“”、,，.。:：;；/\\|-]/gu, '')
    .replace(/[ⅡⅢ]$/u, '')
    .toLocaleLowerCase('zh-CN');
};

const keywordsCanMap = (sourceKeyword: string, exposureKeyword: string): boolean => {
  const source = normalizeKeywordForRule(sourceKeyword);
  const exposure = normalizeKeywordForRule(exposureKeyword);
  if (!source || !exposure || source === exposure) {
    return false;
  }
  if (source.length < 3 || exposure.length < 3) {
    return false;
  }
  if (source.includes(exposure) || exposure.includes(source)) {
    return true;
  }
  const short = source.length <= exposure.length ? source : exposure;
  const long = source.length <= exposure.length ? exposure : source;
  return short.length >= 3 && long.includes(short);
};

const keywordAppearsInText = (text: string, keyword: string): boolean => {
  const normalizedKeyword = normalizeKeywordForRule(keyword);
  return normalizedKeyword.length >= 2 && normalizeKeywordForRule(text).includes(normalizedKeyword);
};

const splitEvidenceSegments = (text: string): readonly string[] => {
  return text
    .split(/[。！？!?；;\n\r]+/u)
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);
};

const findAliasEvidenceText = (
  news: IHistoricalNewsRecord,
  signal: Record<string, unknown>,
  sourceKeyword: string,
  canonicalKeyword: string,
): string | null => {
  if (normalizeKeywordForRule(sourceKeyword).length < 3 || normalizeKeywordForRule(canonicalKeyword).length < 3) {
    return null;
  }

  const signalEvidence = String(signal.evidenceText ?? '').trim();
  const segments = [
    signalEvidence,
    ...splitEvidenceSegments(`${news.title}。${news.content}`),
  ].filter(segment => segment.length > 0);

  const supported = segments.find(segment =>
    keywordAppearsInText(segment, sourceKeyword)
    && keywordAppearsInText(segment, canonicalKeyword)
    && evidenceTextExists(news, segment),
  );
  return supported ?? null;
};

const isSpecificExposureForRuleAlias = (exposure: Record<string, unknown>): boolean => {
  const exposureType = String(exposure.exposureType ?? '');
  const taxonomyLevel = String(exposure.taxonomyLevel ?? '').toUpperCase();
  return exposureType !== 'industry_exposure' || taxonomyLevel === 'SW3';
};

export class HistoricalLimitUpCaseRebuilder {
  public async rebuild(prisma: any, input: IHistoricalLimitUpCaseRebuildInput): Promise<IHistoricalLimitUpCaseRebuildResult> {
    const repository = new CoverageInitializationRepository(prisma);
    const stocks = await repository.listStocksByCluster(input.clusterKey);
    const stockIds = stocks.map(stock => String(stock.id)).filter(Boolean);
    const candleRows = await repository.listCandleRows({
      stockIds,
      asOf: input.asOf,
    });

    const tradingDates = [...new Set(candleRows.map(row => buildTradingDateKey(toDate(row.tradingDay))))].sort();
    const selectedTradingDates = new Set(tradingDates.slice(-(input.days ?? 120)));
    const candlesByStockId = new Map<string, Record<string, unknown>[]>();
    for (const candle of candleRows) {
      const stockId = String(candle.stockId);
      const list = candlesByStockId.get(stockId) ?? [];
      list.push(candle);
      candlesByStockId.set(stockId, list);
    }

    const cases: IHistoricalLimitUpCaseRecord[] = [];
    let touchCount = 0;
    let sealedCount = 0;

    for (const stock of stocks) {
      const stockId = String(stock.id);
      const symbol = String(stock.symbol);
      const stockName = String(stock.name ?? '');
      const candles = [...(candlesByStockId.get(stockId) ?? [])].sort(
        (left, right) => toDate(left.tradingDay).getTime() - toDate(right.tradingDay).getTime(),
      );
      for (let index = 1; index < candles.length; index += 1) {
        const previous = candles[index - 1];
        const current = candles[index];
        const tradeDate = toDate(current.tradingDay);
        if (!selectedTradingDates.has(buildTradingDateKey(tradeDate))) {
          continue;
        }

        const prevClose = toNumber(previous.close);
        const high = toNumber(current.high);
        const close = toNumber(current.close);
        if (prevClose <= 0 || high <= 0 || close <= 0) {
          continue;
        }

        const { boardType, limitThresholdPct } = resolveLimitRule(symbol, stockName);
        const limitPrice = roundPrice2(prevClose * (1 + limitThresholdPct));
        const touchLimit = high >= limitPrice - 0.0001;
        const sealedLimit = close >= limitPrice - 0.0001;
        if (!touchLimit && !sealedLimit) {
          continue;
        }

        if (touchLimit) {
          touchCount += 1;
        }
        if (sealedLimit) {
          sealedCount += 1;
        }

        cases.push({
          traceId: input.traceId,
          clusterKey: input.clusterKey,
          symbol,
          stockName,
          tradeDate,
          touchLimit,
          sealedLimit,
          prevClose: new Prisma.Decimal(prevClose.toFixed(4)),
          high: new Prisma.Decimal(high.toFixed(4)),
          close: new Prisma.Decimal(close.toFixed(4)),
          boardType,
          limitThresholdPct: new Prisma.Decimal(limitThresholdPct.toFixed(4)),
          diagnosticsJson: {
            limitPrice,
            highPct: Number(((high - prevClose) / prevClose).toFixed(6)),
            closePct: Number(((close - prevClose) / prevClose).toFixed(6)),
            rule: 'prevClose_limit_price',
          },
        });
      }
    }

    const mode = input.mode ?? 'touch';
    const rowsToWrite = mode === 'sealed' ? cases.filter(row => row.sealedLimit) : cases;
    const insertedCount = await repository.writeHistoricalLimitUpCases(rowsToWrite);
    return {
      traceId: input.traceId,
      clusterKey: input.clusterKey,
      tradingDayCount: selectedTradingDates.size,
      caseCount: rowsToWrite.length,
      touchCount,
      sealedCount,
      insertedCount,
    };
  }
}

export class CoverageGapAnalyzer {
  public async analyze(prisma: any, input: ICoverageGapAnalysisInput): Promise<ICoverageGapAnalysisResult> {
    const repository = new CoverageInitializationRepository(prisma);
    const mode = input.mode ?? 'sealed';
    const limitUpCases = (await repository.listHistoricalLimitUpCasesByTradeDate(
      input.clusterKey,
      input.targetDate,
      mode === 'sealed',
    )).filter(row => mode === 'sealed' ? row.sealedLimit === true : row.touchLimit === true);
    const [recommendations, evidenceRows, featureRows, stocks] = await Promise.all([
      repository.listRecommendationSnapshotsByTrace(input.traceId),
      repository.listEvidenceContributionsByTrace(input.traceId),
      repository.listStockFeaturesByTrace(input.traceId),
      repository.listStocksByCluster(input.clusterKey),
    ]);

    const recommendationsBySymbol = new Map(recommendations.map(row => [String(row.symbol), row]));
    const featureBySymbol = new Map(featureRows.map(row => [String(row.symbol), row]));
    const stockSymbols = new Set(stocks.map(row => String(row.symbol)));
    const evidenceCountBySymbol = new Map<string, number>();
    for (const row of evidenceRows) {
      const symbol = String(row.symbol);
      evidenceCountBySymbol.set(symbol, (evidenceCountBySymbol.get(symbol) ?? 0) + 1);
    }

    const gaps: ICoverageGapCaseRecord[] = [];
    const reasonCounts: Record<string, number> = {};
    let selectedCount = 0;

    for (const limitUpCase of limitUpCases) {
      const symbol = String(limitUpCase.symbol);
      const selected = recommendationsBySymbol.get(symbol);
      if (selected) {
        selectedCount += 1;
        continue;
      }

      const feature = featureBySymbol.get(symbol);
      const evidenceCount = evidenceCountBySymbol.get(symbol) ?? 0;
      const score = feature ? toNumber(feature.aggregatedScore, 0) : null;
      let missReason: CoverageGapMissReason = 'filtered_out';
      let gapStage = 'recommendation_selection';

      if (!stockSymbols.has(symbol)) {
        missReason = 'not_in_stock_pool';
        gapStage = 'stock_pool';
      }
      else if (evidenceCount === 0) {
        missReason = 'no_evidence_chain';
        gapStage = 'evidence_generation';
      }
      else if (score === null || score < (input.lowScoreThreshold ?? 60)) {
        missReason = 'score_too_low';
        gapStage = 'scoring';
      }

      incrementReason(reasonCounts, missReason);
      gaps.push({
        traceId: input.traceId,
        clusterKey: input.clusterKey,
        asOf: input.asOf,
        symbol,
        stockName: String(limitUpCase.stockName ?? ''),
        tradeDate: toDate(limitUpCase.tradeDate),
        historicalCaseId: typeof limitUpCase.id === 'string' ? limitUpCase.id : null,
        gapStage,
        missReason,
        selectedRank: null,
        scoreAtAsOf: score === null ? null : new Prisma.Decimal(score.toFixed(4)),
        diagnosticsJson: {
          mode,
          evidenceCount,
          hasFeature: Boolean(feature),
          selected: false,
          lowScoreThreshold: input.lowScoreThreshold ?? 60,
        },
        status: 'open',
      });
    }

    const insertedGapCount = await repository.writeCoverageGapCases(gaps);
    return {
      traceId: input.traceId,
      clusterKey: input.clusterKey,
      targetDate: input.targetDate,
      limitUpCaseCount: limitUpCases.length,
      selectedCount,
      unselectedCount: gaps.length,
      insertedGapCount,
      reasonCounts,
      gaps,
    };
  }
}

export class HistoricalNewsWindowLoader {
  public async load(prisma: any, input: IHistoricalNewsWindowInput): Promise<IHistoricalNewsWindow> {
    const repository = new CoverageInitializationRepository(prisma);
    const bounds = resolveHistoricalNewsWindowBounds(input.tradeDate, input.lookbackDays ?? 3);
    const rows = await repository.listNewsByWindow({
      clusterKey: input.clusterKey,
      windowStart: bounds.windowStart,
      windowEnd: bounds.windowEnd,
    });
    const news = rows.map(readNewsRecord);
    return {
      status: news.length > 0 ? 'ready' : 'news_missing',
      windowStart: bounds.windowStart,
      windowEnd: bounds.windowEnd,
      news,
    };
  }
}

const buildExposureCandidatePrompt = (input: IExposureCandidateExtractionInput): string => {
  return [
    '你是股票涨停复盘证据初始化器，只输出 JSON。',
    '任务：根据历史涨停股票和涨停前新闻，生成候选 StockExposureCandidate 和可选 aliasSuggestions。',
    '只允许生成候选，不允许推荐股票，不允许直接写 active fact。',
    '每条 candidate 必须有 keyword, exposureType, sourceId, evidenceText, confidence。',
    'sourceId 必须是输入 news.id，evidenceText 必须能在该新闻标题或正文中定位。',
    '返回格式：{"candidates":[...]}。',
    JSON.stringify({
      limitUpCase: input.limitUpCase,
      news: input.news.map(news => ({
        id: news.id,
        title: news.title,
        content: news.content.slice(0, 800),
        source: news.source,
        publishedAt: news.publishedAt.toISOString(),
      })),
    }, null, 2),
  ].join('\n');
};

const extractJsonObject = (content: string): string => {
  const fenced = content.match(/```json\s*([\s\S]*?)\s*```/iu);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const first = content.indexOf('{');
  const last = content.lastIndexOf('}');
  return first >= 0 && last > first ? content.slice(first, last + 1) : content.trim();
};

interface IOpenAiCompatibleExposureCandidateExtractorOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxRequestChars?: number;
  readonly requestTimeoutMs?: number;
}

export class OpenAiCompatibleExposureCandidateExtractor implements IExposureCandidateExtractor {
  public readonly modelVersion: string;
  public readonly promptVersion = 'historical-limitup-exposure-candidate-v1';
  private readonly fetchImpl: typeof fetch;
  private readonly maxRequestChars: number;
  private readonly requestTimeoutMs: number;

  public constructor(private readonly options: IOpenAiCompatibleExposureCandidateExtractorOptions) {
    this.modelVersion = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRequestChars = options.maxRequestChars ?? DEFAULT_MAX_REQUEST_CHARS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  public async extract(input: IExposureCandidateExtractionInput): Promise<readonly IExposureCandidateDraft[]> {
    const prompt = buildExposureCandidatePrompt(input);
    const body = JSON.stringify({
      model: this.options.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: '你只返回合法 JSON，不编造原文不存在的证据。',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    });
    if (prompt.length > this.maxRequestChars || body.length > this.maxRequestChars) {
      throw new Error(`Exposure candidate AI request too large: promptChars=${prompt.length}, bodyChars=${body.length}, max=${this.maxRequestChars}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/u, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.options.apiKey}`,
        },
        signal: controller.signal,
        body,
      });
    }
    finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`Exposure candidate AI request failed with HTTP ${response.status}`);
    }
    const payload = await response.json() as { readonly choices?: readonly { readonly message?: { readonly content?: string } }[] };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Exposure candidate AI response missing content');
    }
    const parsed = JSON.parse(extractJsonObject(content)) as { readonly candidates?: readonly Partial<IExposureCandidateDraft>[] };
    return (parsed.candidates ?? []).flatMap((candidate) => {
      if (
        typeof candidate.keyword !== 'string'
        || (candidate.exposureType !== 'industry_exposure' && candidate.exposureType !== 'concept_exposure' && candidate.exposureType !== 'business_exposure')
        || typeof candidate.sourceId !== 'string'
        || typeof candidate.evidenceText !== 'string'
        || typeof candidate.confidence !== 'number'
      ) {
        return [];
      }
      return [{
        keyword: candidate.keyword,
        exposureType: candidate.exposureType,
        sourceId: candidate.sourceId,
        sourceName: typeof candidate.sourceName === 'string' ? candidate.sourceName : undefined,
        evidenceText: candidate.evidenceText,
        confidence: Math.max(0, Math.min(candidate.confidence, 1)),
        taxonomyLevel: typeof candidate.taxonomyLevel === 'string' ? candidate.taxonomyLevel : null,
        memberCount: typeof candidate.memberCount === 'number' ? candidate.memberCount : null,
        aliasSuggestions: Array.isArray(candidate.aliasSuggestions)
          ? candidate.aliasSuggestions.filter(isRecord).flatMap((alias) => {
              if (typeof alias.sourceKeyword !== 'string' || typeof alias.canonicalKeyword !== 'string') {
                return [];
              }
              return [{
                sourceKeyword: alias.sourceKeyword,
                canonicalKeyword: alias.canonicalKeyword,
                relationType: typeof alias.relationType === 'string' ? alias.relationType : 'historical_news_alias',
                confidence: typeof alias.confidence === 'number' ? alias.confidence : candidate.confidence,
                evidenceText: typeof alias.evidenceText === 'string' ? alias.evidenceText : candidate.evidenceText,
              }];
            })
          : [],
      } satisfies IExposureCandidateDraft];
    });
  }
}

export const createExposureCandidateExtractorFromEnv = (
  environment: NodeJS.ProcessEnv = process.env,
): OpenAiCompatibleExposureCandidateExtractor => {
  const baseUrl = environment.OPENAI_BASE_URL ?? environment.AI_BASE_URL ?? environment.LLM_SMART_BASE_URL;
  const apiKey = environment.OPENAI_API_KEY ?? environment.AI_API_KEY ?? environment.LLM_SMART_API_KEY;
  const model = environment.EXPOSURE_CANDIDATE_MODEL ?? environment.OPENAI_MODEL ?? environment.LLM_SMART_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new Error('Missing exposure candidate AI env: OPENAI_BASE_URL/OPENAI_API_KEY/EXPOSURE_CANDIDATE_MODEL or LLM_SMART_BASE_URL/LLM_SMART_API_KEY/LLM_SMART_MODEL');
  }
  return new OpenAiCompatibleExposureCandidateExtractor({
    baseUrl,
    apiKey,
    model,
    maxRequestChars: environment.EXPOSURE_CANDIDATE_MAX_REQUEST_CHARS
      ? Number(environment.EXPOSURE_CANDIDATE_MAX_REQUEST_CHARS)
      : undefined,
  });
};

export class HistoricalExposureCandidateGenerator {
  public constructor(
    private readonly extractor: IExposureCandidateExtractor,
    private readonly newsWindowLoader = new HistoricalNewsWindowLoader(),
  ) {}

  private async generateCaseRows(
    prisma: any,
    input: IGenerateExposureCandidatesInput,
    gapCase: Record<string, unknown>,
    exposuresBySymbol: Map<string, Record<string, unknown>[]>,
  ): Promise<{
    readonly status: 'ready' | 'news_missing';
    readonly llmCaseCount: number;
    readonly rows: readonly Record<string, unknown>[];
    readonly skippedInvalidCount: number;
  }> {
    const window = await this.newsWindowLoader.load(prisma, {
      clusterKey: input.clusterKey,
      tradeDate: toDate(gapCase.tradeDate),
    });
    if (window.status === 'news_missing') {
      return { status: 'news_missing', llmCaseCount: 0, rows: [], skippedInvalidCount: 0 };
    }
    const caseExposures = exposuresBySymbol.get(String(gapCase.symbol)) ?? [];
    const enrichedGapCase = {
      ...gapCase,
      resolvedStockName: resolveStockNameForLimitUpCase(gapCase, caseExposures),
      knownExposures: buildKnownExposuresForPrompt(caseExposures),
    };

    const caseNews = selectNewsForLimitUpCase(
      window.news,
      enrichedGapCase,
      caseExposures,
      input.maxNewsPerCase ?? DEFAULT_MAX_LLM_NEWS_PER_CASE,
    );
    const prompt = buildExposureCandidatePrompt({
      limitUpCase: enrichedGapCase,
      news: caseNews,
    });
    const maxRequestChars = input.maxRequestChars ?? DEFAULT_MAX_REQUEST_CHARS;
    if (prompt.length > maxRequestChars) {
      throw new Error(`Exposure candidate prompt too large: symbol=${String(gapCase.symbol)} promptChars=${prompt.length}, max=${maxRequestChars}`);
    }

    const drafts = await this.extractor.extract({
      limitUpCase: enrichedGapCase,
      news: caseNews,
    });
    const newsById = new Map(caseNews.map(news => [news.id, news]));
    const rows: Record<string, unknown>[] = [];
    let skippedInvalidCount = 0;
    for (const draft of drafts) {
      const news = newsById.get(draft.sourceId);
      if (!news || !evidenceTextExists(news, draft.evidenceText)) {
        skippedInvalidCount += 1;
        continue;
      }
      rows.push({
        traceId: input.traceId,
        asOf: input.asOf,
        clusterKey: input.clusterKey,
        symbol: String(gapCase.symbol),
        stockName: String(enrichedGapCase.resolvedStockName ?? gapCase.stockName ?? ''),
        keyword: draft.keyword,
        exposureType: draft.exposureType,
        taxonomyLevel: draft.taxonomyLevel ?? null,
        source: input.source ?? 'historical_limitup_news',
        sourceId: draft.sourceId,
        sourceName: draft.sourceName ?? news.source,
        confidence: new Prisma.Decimal(draft.confidence.toFixed(4)),
        evidenceText: draft.evidenceText,
        evidenceJson: {
          schemaVersion: 'historical-limitup-exposure-candidate-v1',
          gapCaseId: typeof gapCase.id === 'string' ? gapCase.id : null,
          newsId: news.id,
          newsTitle: news.title,
          tradeDate: toDate(gapCase.tradeDate).toISOString(),
          aliasSuggestions: draft.aliasSuggestions ?? [],
          modelVersion: this.extractor.modelVersion,
          promptVersion: this.extractor.promptVersion,
        },
        memberCount: draft.memberCount ?? null,
        validFrom: input.asOf,
        validFromCandidate: input.asOf,
        validTo: null,
        status: 'pending_review',
        failureReason: null,
        coverageGapCaseId: typeof gapCase.id === 'string' ? gapCase.id : null,
      });
    }

    return {
      status: 'ready',
      llmCaseCount: 1,
      rows,
      skippedInvalidCount,
    };
  }

  public async generate(prisma: any, input: IGenerateExposureCandidatesInput): Promise<IGenerateExposureCandidatesResult> {
    const repository = new CoverageInitializationRepository(prisma);
    const gapCases = (await repository.listCoverageGapCasesByTrace(input.traceId))
      .slice(0, input.limitCases ?? Number.POSITIVE_INFINITY);
    const exposureFacts = await repository.listActiveExposureFacts(input.clusterKey, input.asOf);
    const exposuresBySymbol = new Map<string, Record<string, unknown>[]>();
    for (const exposure of exposureFacts) {
      const symbol = String(exposure.symbol ?? '');
      const rows = exposuresBySymbol.get(symbol) ?? [];
      rows.push(exposure);
      exposuresBySymbol.set(symbol, rows);
    }

    let newsMissingCount = 0;
    let llmCaseCount = 0;
    let candidateCount = 0;
    let skippedInvalidCount = 0;
    const concurrency = Math.max(1, Math.floor(input.concurrency ?? 1));

    for (let index = 0; index < gapCases.length; index += concurrency) {
      const results = await Promise.all(
        gapCases.slice(index, index + concurrency).map(gapCase =>
          this.generateCaseRows(prisma, input, gapCase, exposuresBySymbol),
        ),
      );
      const rows = results.flatMap(result => [...result.rows]);
      newsMissingCount += results.filter(result => result.status === 'news_missing').length;
      llmCaseCount += results.reduce((sum, result) => sum + result.llmCaseCount, 0);
      candidateCount += rows.length;
      skippedInvalidCount += results.reduce((sum, result) => sum + result.skippedInvalidCount, 0);
      if (!input.dryRun && rows.length > 0) {
        await writeStockExposureCandidates(prisma, rows);
      }
      input.onProgress?.({
        processedCaseCount: Math.min(index + concurrency, gapCases.length),
        totalCaseCount: gapCases.length,
        candidateCount,
        llmCaseCount,
        newsMissingCount,
        skippedInvalidCount,
      });
    }

    return {
      gapCaseCount: gapCases.length,
      newsMissingCount,
      llmCaseCount,
      candidateCount,
      insertedCount: input.dryRun ? 0 : candidateCount,
      skippedInvalidCount,
    };
  }
}

async function writeStockExposureCandidates(prisma: any, rows: readonly Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const dedupedRows = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = [row.traceId, row.symbol, row.keyword, row.exposureType, row.source, row.sourceId]
      .map(value => String(value))
      .join('|');
    const existing = dedupedRows.get(key);
    if (!existing || toNumber(row.confidence) > toNumber(existing.confidence)) {
      dedupedRows.set(key, row);
    }
  }
  const uniqueRows = [...dedupedRows.values()];
  if (typeof prisma?.$executeRawUnsafe === 'function') {
    await prisma.$executeRawUnsafe(
      [
        'INSERT INTO "StockExposureCandidate" (',
        '  id, "traceId", "asOf", "clusterKey", symbol, "stockName", keyword, "exposureType", "taxonomyLevel",',
        '  source, "sourceId", "sourceName", confidence, "evidenceText", "evidenceJson", "memberCount",',
        '  "validFrom", "validFromCandidate", "validTo", status, "failureReason", "coverageGapCaseId", "updatedAt"',
        ')',
        'SELECT',
        '  row.id, row."traceId", row."asOf"::timestamp(3), row."clusterKey", row.symbol, row."stockName", row.keyword,',
        '  row."exposureType", row."taxonomyLevel", row.source, row."sourceId", row."sourceName",',
        '  row.confidence::decimal(5,4), row."evidenceText", row."evidenceJson", row."memberCount",',
        '  row."validFrom"::timestamp(3), row."validFromCandidate"::timestamp(3), row."validTo"::timestamp(3),',
        '  row.status, row."failureReason", row."coverageGapCaseId", CURRENT_TIMESTAMP',
        'FROM jsonb_to_recordset($1::jsonb) AS row(',
        '  id text, "traceId" text, "asOf" text, "clusterKey" text, symbol text, "stockName" text, keyword text,',
        '  "exposureType" text, "taxonomyLevel" text, source text, "sourceId" text, "sourceName" text,',
        '  confidence text, "evidenceText" text, "evidenceJson" jsonb, "memberCount" integer,',
        '  "validFrom" text, "validFromCandidate" text, "validTo" text, status text, "failureReason" text, "coverageGapCaseId" text',
        ')',
        'ON CONFLICT ("traceId", symbol, keyword, "exposureType", source, "sourceId") DO UPDATE SET',
        '  confidence = GREATEST("StockExposureCandidate".confidence, EXCLUDED.confidence),',
        '  "evidenceText" = EXCLUDED."evidenceText",',
        '  "evidenceJson" = EXCLUDED."evidenceJson",',
        '  "validFromCandidate" = EXCLUDED."validFromCandidate",',
        '  status = EXCLUDED.status,',
        '  "failureReason" = EXCLUDED."failureReason",',
        '  "updatedAt" = CURRENT_TIMESTAMP',
      ].join(' '),
      JSON.stringify(uniqueRows.map(row => ({
        ...row,
        id: stableHash([row.traceId, row.symbol, row.keyword, row.exposureType, row.source, row.sourceId]).slice(0, 28),
        asOf: toDate(row.asOf).toISOString(),
        confidence: String(row.confidence),
        validFrom: toDate(row.validFrom).toISOString(),
        validFromCandidate: row.validFromCandidate ? toDate(row.validFromCandidate).toISOString() : null,
        validTo: row.validTo ? toDate(row.validTo).toISOString() : null,
      }))),
    );
    return;
  }
  await prisma.stockExposureCandidate.createMany({
    data: uniqueRows,
    skipDuplicates: true,
  });
}

const loadNewsById = async (prisma: any, id: string): Promise<IHistoricalNewsRecord | null> => {
  if (typeof prisma?.normalizedNewsRecord?.findUnique === 'function') {
    const row = await prisma.normalizedNewsRecord.findUnique({ where: { id } });
    return row ? readNewsRecord(row) : null;
  }
  if (typeof prisma?.normalizedNewsRecord?.findMany === 'function') {
    const rows = await prisma.normalizedNewsRecord.findMany({ where: { id } });
    const row = rows[0];
    return row ? readNewsRecord(row) : null;
  }
  return null;
};

const parseAliasSuggestions = (value: unknown): readonly IAliasSuggestionDraft[] => {
  const payload = isRecord(value) ? value : {};
  const suggestions = Array.isArray(payload.aliasSuggestions) ? payload.aliasSuggestions : [];
  return suggestions.filter(isRecord).flatMap((item) => {
    if (typeof item.sourceKeyword !== 'string' || typeof item.canonicalKeyword !== 'string') {
      return [];
    }
    return [{
      sourceKeyword: item.sourceKeyword,
      canonicalKeyword: item.canonicalKeyword,
      relationType: typeof item.relationType === 'string' ? item.relationType : 'historical_news_alias',
      confidence: typeof item.confidence === 'number' ? item.confidence : 0.7,
      evidenceText: typeof item.evidenceText === 'string' ? item.evidenceText : undefined,
    }];
  });
};

export class RuleBasedAliasCandidateGenerator {
  public async generate(prisma: any, input: IGenerateRuleBasedAliasCandidatesInput): Promise<IGenerateRuleBasedAliasCandidatesResult> {
    if (
      typeof prisma?.coverageGapCase?.findMany !== 'function'
      || typeof prisma?.causalSignalCandidate?.findMany !== 'function'
      || typeof prisma?.stockExposureFact?.findMany !== 'function'
      || typeof prisma?.normalizedNewsRecord?.findMany !== 'function'
    ) {
      return {
        gapCaseCount: 0,
        signalCount: 0,
        generatedAliasCount: 0,
        insertedAliasCount: 0,
        skippedNoExposureCount: 0,
        skippedLowConfidenceCount: 0,
      };
    }

    const gapCases = await prisma.coverageGapCase.findMany({
      where: {
        traceId: input.sourceTraceId,
        clusterKey: input.clusterKey,
        status: input.status ?? 'open',
      },
      take: input.max,
    }) as readonly Record<string, unknown>[];
    if (gapCases.length === 0) {
      return {
        gapCaseCount: 0,
        signalCount: 0,
        generatedAliasCount: 0,
        insertedAliasCount: 0,
        skippedNoExposureCount: 0,
        skippedLowConfidenceCount: 0,
      };
    }

    const symbols = [...new Set(gapCases.map(row => String(row.symbol)).filter(Boolean))];
    const [signals, exposures] = await Promise.all([
      prisma.causalSignalCandidate.findMany({
        where: {
          traceId: input.sourceTraceId,
          clusterKey: input.clusterKey,
          status: 'candidate',
          asOf: { lte: input.asOf },
        },
      }) as Promise<readonly Record<string, unknown>[]>,
      prisma.stockExposureFact.findMany({
        where: {
          clusterKey: input.clusterKey,
          status: 'active',
          symbol: { in: symbols },
          validFrom: { lte: input.asOf },
          OR: [
            { validTo: null },
            { validTo: { gte: input.asOf } },
          ],
        },
      }) as Promise<readonly Record<string, unknown>[]>,
    ]);
    const newsIds = [...new Set(signals.map(row => String(row.newsId)).filter(Boolean))];
    const newsRows = newsIds.length > 0
      ? await prisma.normalizedNewsRecord.findMany({
        where: {
          id: { in: newsIds },
          clusterKey: input.clusterKey,
          publishedAt: { lte: input.asOf },
        },
      }) as readonly Record<string, unknown>[]
      : [];
    const newsById = new Map(newsRows.map(row => [String(row.id), readNewsRecord(row)]));
    const exposuresBySymbol = new Map<string, Record<string, unknown>[]>();
    for (const exposure of exposures) {
      const list = exposuresBySymbol.get(String(exposure.symbol)) ?? [];
      list.push(exposure);
      exposuresBySymbol.set(String(exposure.symbol), list);
    }

    const aliases = new Map<string, IKeywordAliasRecord>();
    let skippedNoExposureCount = 0;
    let skippedLowConfidenceCount = 0;
    const minConfidence = input.minConfidence ?? 0.7;

    for (const gapCase of gapCases) {
      const symbol = String(gapCase.symbol);
      const symbolExposures = exposuresBySymbol.get(symbol) ?? [];
      if (symbolExposures.length === 0) {
        skippedNoExposureCount += 1;
        continue;
      }

      for (const signal of signals) {
        const sourceKeyword = String(signal.assetOrThemeKeyword ?? '').trim();
        const confidence = toNumber(signal.confidence, 0);
        if (confidence < minConfidence) {
          skippedLowConfidenceCount += 1;
          continue;
        }
        const news = newsById.get(String(signal.newsId));
        const evidenceText = String(signal.evidenceText ?? '');
        if (!news || !evidenceTextExists(news, evidenceText)) {
          continue;
        }

        for (const exposure of symbolExposures) {
          if (!isSpecificExposureForRuleAlias(exposure)) {
            continue;
          }
          const canonicalKeyword = String(exposure.keyword ?? '').trim();
          const aliasEvidenceText = findAliasEvidenceText(news, signal, sourceKeyword, canonicalKeyword);
          if (!keywordsCanMap(sourceKeyword, canonicalKeyword) && !aliasEvidenceText) {
            continue;
          }
          if (!aliasEvidenceText) {
            continue;
          }
          const key = `${input.clusterKey}|${sourceKeyword}|${canonicalKeyword}|${signal.newsId}`;
          aliases.set(key, {
            traceId: input.traceId,
            clusterKey: input.clusterKey,
            sourceKeyword,
            canonicalKeyword,
            relationType: 'rule_news_alias',
            confidence: new Prisma.Decimal(Math.min(0.9, confidence).toFixed(4)),
            source: 'rule_based_news_signal',
            sourceId: String(signal.newsId),
            evidenceText: aliasEvidenceText,
            validFrom: input.asOf,
            validTo: null,
            status: 'candidate',
            failureReason: null,
          });
        }
      }
    }

    const rows = [...aliases.values()];
    const insertedAliasCount = input.dryRun
      ? 0
      : await new CoverageInitializationRepository(prisma).writeKeywordAliases(rows);

    return {
      gapCaseCount: gapCases.length,
      signalCount: signals.length,
      generatedAliasCount: rows.length,
      insertedAliasCount,
      skippedNoExposureCount,
      skippedLowConfidenceCount,
    };
  }
}

export class KeywordAliasPromotionService {
  public async promote(prisma: any, input: IPromoteKeywordAliasCandidatesInput): Promise<IPromoteKeywordAliasCandidatesResult> {
    if (typeof prisma?.keywordAlias?.findMany !== 'function' || typeof prisma?.keywordAlias?.update !== 'function') {
      return { candidateCount: 0, promotedCount: 0, rejectedCount: 0 };
    }
    const candidates = await prisma.keywordAlias.findMany({
      where: {
        clusterKey: input.clusterKey,
        status: input.status ?? 'candidate',
      },
      take: input.max,
      orderBy: [
        { confidence: 'desc' },
        { createdAt: 'asc' },
      ],
    }) as readonly Record<string, unknown>[];

    let promotedCount = 0;
    let rejectedCount = 0;
    if (!input.dryRun) {
      for (const candidate of candidates) {
        if (typeof candidate.id !== 'string') {
          continue;
        }
        const news = await loadNewsById(prisma, String(candidate.sourceId));
        const evidenceText = String(candidate.evidenceText ?? '');
        if (!evidenceTextExists(news, evidenceText)) {
          await prisma.keywordAlias.update({
            where: { id: candidate.id },
            data: {
              status: 'rejected',
              failureReason: 'evidence_text_not_found',
            },
          });
          rejectedCount += 1;
          continue;
        }
        await prisma.keywordAlias.update({
          where: { id: candidate.id },
          data: {
            status: 'active',
            validFrom: input.validFrom,
            failureReason: null,
          },
        });
        promotedCount += 1;
      }
    }
    else {
      promotedCount = candidates.length;
    }

    return {
      candidateCount: candidates.length,
      promotedCount,
      rejectedCount,
    };
  }
}

export class ExposureCandidateValidationService {
  public async validate(prisma: any, input: IValidateExposureCandidatesInput): Promise<IValidateExposureCandidatesResult> {
    if (typeof prisma?.stockExposureCandidate?.findMany !== 'function') {
      return { candidateCount: 0, validatedCount: 0, rejectedCount: 0 };
    }

    const candidates = await prisma.stockExposureCandidate.findMany({
      where: {
        clusterKey: input.clusterKey,
        status: input.status ?? 'pending_review',
      },
      take: input.max,
      orderBy: [
        { confidence: 'desc' },
        { createdAt: 'asc' },
      ],
    }) as readonly Record<string, unknown>[];

    let validatedCount = 0;
    let rejectedCount = 0;
    for (const candidate of candidates) {
      const evidenceText = String(candidate.evidenceText ?? '');
      const news = await loadNewsById(prisma, String(candidate.sourceId));
      if (!evidenceTextExists(news, evidenceText)) {
        rejectedCount += 1;
        if (!input.dryRun) {
          await markCandidateStatus(prisma, candidate, 'rejected', 'evidence_text_not_found');
        }
        continue;
      }

      validatedCount += 1;
      if (!input.dryRun) {
        await markCandidateStatus(prisma, candidate, 'validated', null);
      }
    }

    return {
      candidateCount: candidates.length,
      validatedCount,
      rejectedCount,
    };
  }
}

export class EvidencePromotionService {
  public async promote(prisma: any, input: IPromoteValidatedEvidenceInput): Promise<IPromoteValidatedEvidenceResult> {
    if (typeof prisma?.stockExposureCandidate?.findMany !== 'function') {
      return { candidateCount: 0, promotedFactCount: 0, promotedAliasCount: 0, rejectedCount: 0 };
    }

    const candidates = await prisma.stockExposureCandidate.findMany({
      where: {
        clusterKey: input.clusterKey,
        status: input.status ?? 'validated',
      },
      take: input.max,
    }) as readonly Record<string, unknown>[];
    let promotedFactCount = 0;
    let promotedAliasCount = 0;
    let rejectedCount = 0;
    const aliases: IKeywordAliasRecord[] = [];

    for (const candidate of candidates) {
      const evidenceText = String(candidate.evidenceText ?? '');
      const news = await loadNewsById(prisma, String(candidate.sourceId));
      if (!evidenceTextExists(news, evidenceText)) {
        rejectedCount += 1;
        await markCandidateStatus(prisma, candidate, 'rejected', 'evidence_text_not_found');
        continue;
      }

      if (!input.dryRun) {
        await upsertStockExposureFact(prisma, candidate, input.validFrom);
        await markCandidateStatus(prisma, candidate, 'promoted', null);
      }
      promotedFactCount += 1;

      for (const alias of parseAliasSuggestions(candidate.evidenceJson)) {
        aliases.push({
          traceId: typeof candidate.traceId === 'string' ? candidate.traceId : null,
          clusterKey: input.clusterKey,
          sourceKeyword: alias.sourceKeyword,
          canonicalKeyword: alias.canonicalKeyword,
          relationType: alias.relationType ?? 'historical_news_alias',
          confidence: new Prisma.Decimal((alias.confidence ?? 0.7).toFixed(4)),
          source: 'historical_limitup_news',
          sourceId: String(candidate.sourceId),
          evidenceText: alias.evidenceText ?? evidenceText,
          validFrom: input.validFrom,
          validTo: null,
          status: 'active',
          failureReason: null,
        });
      }
    }

    if (!input.dryRun) {
      promotedAliasCount = await new CoverageInitializationRepository(prisma).writeKeywordAliases(aliases);
    }
    else {
      promotedAliasCount = aliases.length;
    }

    return {
      candidateCount: candidates.length,
      promotedFactCount,
      promotedAliasCount,
      rejectedCount,
    };
  }
}

async function markCandidateStatus(
  prisma: any,
  candidate: Record<string, unknown>,
  status: string,
  failureReason: string | null,
): Promise<void> {
  if (typeof prisma?.stockExposureCandidate?.update !== 'function' || typeof candidate.id !== 'string') {
    return;
  }
  await prisma.stockExposureCandidate.update({
    where: { id: candidate.id },
    data: {
      status,
      failureReason,
    },
  });
}

async function upsertStockExposureFact(
  prisma: any,
  candidate: Record<string, unknown>,
  validFrom: Date,
): Promise<void> {
  const data = {
    traceId: candidate.traceId ?? null,
    clusterKey: String(candidate.clusterKey),
    symbol: String(candidate.symbol),
    stockName: String(candidate.stockName),
    keyword: String(candidate.keyword),
    exposureType: String(candidate.exposureType),
    taxonomyLevel: candidate.taxonomyLevel ?? null,
    source: String(candidate.source),
    sourceId: String(candidate.sourceId),
    sourceName: String(candidate.sourceName),
    confidence: candidate.confidence,
    evidenceJson: {
      ...(isRecord(candidate.evidenceJson) ? candidate.evidenceJson : {}),
      promotedAt: validFrom.toISOString(),
      promotionRule: 'source_evidence_located',
    },
    memberCount: candidate.memberCount ?? null,
    validFrom,
    validTo: null,
    status: 'active',
  };
  if (typeof prisma?.stockExposureFact?.upsert === 'function') {
    await prisma.stockExposureFact.upsert({
      where: {
        clusterKey_symbol_keyword_exposureType_source_sourceId: {
          clusterKey: data.clusterKey,
          symbol: data.symbol,
          keyword: data.keyword,
          exposureType: data.exposureType,
          source: data.source,
          sourceId: data.sourceId,
        },
      },
      create: data,
      update: {
        traceId: data.traceId,
        stockName: data.stockName,
        sourceName: data.sourceName,
        confidence: data.confidence,
        evidenceJson: data.evidenceJson,
        memberCount: data.memberCount,
        validFrom,
        validTo: null,
        status: 'active',
      },
    });
    return;
  }
  if (typeof prisma?.stockExposureFact?.createMany === 'function') {
    await prisma.stockExposureFact.createMany({
      data: [data],
      skipDuplicates: true,
    });
  }
}

export class FactSnapshotService {
  public async ensure(prisma: any, input: { readonly traceId: string; readonly clusterKey: string; readonly asOf: Date }): Promise<IFactSnapshotResult> {
    const repository = new CoverageInitializationRepository(prisma);
    const [exposures, aliases] = await Promise.all([
      repository.listActiveExposureFacts(input.clusterKey, input.asOf),
      repository.listActiveKeywordAliases(input.clusterKey, input.asOf),
    ]);
    const canonicalExposures = sortByStableJson(exposures.map(row => ({
      symbol: row.symbol,
      keyword: row.keyword,
      exposureType: row.exposureType,
      source: row.source,
      sourceId: row.sourceId,
      validFrom: row.validFrom instanceof Date ? row.validFrom.toISOString() : String(row.validFrom),
      validTo: row.validTo instanceof Date ? row.validTo.toISOString() : row.validTo ?? null,
    })));
    const canonicalAliases = sortByStableJson(aliases.map(row => ({
      sourceKeyword: row.sourceKeyword,
      canonicalKeyword: row.canonicalKeyword,
      relationType: row.relationType,
      source: row.source,
      sourceId: row.sourceId,
      validFrom: row.validFrom instanceof Date ? row.validFrom.toISOString() : String(row.validFrom),
      validTo: row.validTo instanceof Date ? row.validTo.toISOString() : row.validTo ?? null,
    })));
    const factHash = stableHash({
      exposures: canonicalExposures,
      aliases: canonicalAliases,
    });
    const sourceSummaryJson = {
      exposureSources: summarizeBy(exposures, 'source'),
      aliasSources: summarizeBy(aliases, 'source'),
      exposureCount: exposures.length,
      aliasCount: aliases.length,
    };
    await repository.upsertFactSnapshot({
      traceId: input.traceId,
      clusterKey: input.clusterKey,
      asOf: input.asOf,
      factHash,
      activeExposureCount: exposures.length,
      activeAliasCount: aliases.length,
      sourceSummaryJson,
    });
    return {
      traceId: input.traceId,
      clusterKey: input.clusterKey,
      asOf: input.asOf,
      factHash,
      activeExposureCount: exposures.length,
      activeAliasCount: aliases.length,
    };
  }
}

function summarizeBy(rows: readonly Record<string, unknown>[], field: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows) {
    const key = String(row[field] ?? 'unknown');
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

class NoopExposureCandidateExtractor implements IExposureCandidateExtractor {
  public readonly modelVersion = 'dry-run';
  public readonly promptVersion = 'dry-run';

  public extract(): Promise<readonly IExposureCandidateDraft[]> {
    return Promise.resolve([]);
  }
}

export class CoverageGapLoopService {
  public async run(prisma: any, input: ICoverageGapLoopInput): Promise<ICoverageGapLoopResult> {
    const rebuild = await new HistoricalLimitUpCaseRebuilder().rebuild(prisma, {
      traceId: `${input.traceId}-limitup-${toBeijingDate(input.tradeDate)}`,
      clusterKey: input.clusterKey,
      asOf: nextUtcDate(input.tradeDate),
      days: 1,
      mode: 'sealed',
    });
    const gapAnalysis = await new CoverageGapAnalyzer().analyze(prisma, {
      traceId: input.traceId,
      clusterKey: input.clusterKey,
      asOf: input.asOf,
      targetDate: input.tradeDate,
      mode: 'sealed',
    });
    const candidateGeneration = await new HistoricalExposureCandidateGenerator(
      input.extractor ?? new NoopExposureCandidateExtractor(),
    ).generate(prisma, {
      traceId: input.traceId,
      clusterKey: input.clusterKey,
      asOf: input.asOf,
      dryRun: input.dryRun ?? !input.extractor,
      limitCases: gapAnalysis.unselectedCount,
      concurrency: input.concurrency,
      maxNewsPerCase: input.maxNewsPerCase,
      source: 'daily_coverage_gap_loop',
    });
    return {
      rebuild,
      gapAnalysis,
      candidateGeneration,
    };
  }
}

export class CoverageLoopReportService {
  public async report(prisma: any, input: { readonly clusterKey: string; readonly from: Date; readonly to: Date }): Promise<Record<string, unknown>> {
    const fromStart = startOfUtcDate(input.from);
    const toEnd = nextUtcDate(input.to);
    const gaps = await queryRows(prisma, [
      'SELECT * FROM "CoverageGapCase"',
      'WHERE "clusterKey" = $1 AND "tradeDate" >= $2 AND "tradeDate" < $3',
    ].join(' '), input.clusterKey, fromStart, toEnd);
    const limitUpCases = await queryRows(prisma, [
      'SELECT * FROM "HistoricalLimitUpCase"',
      'WHERE "clusterKey" = $1 AND "tradeDate" >= $2 AND "tradeDate" < $3 AND "sealedLimit" = true',
    ].join(' '), input.clusterKey, fromStart, toEnd);
    const recommendations = await queryRows(prisma, [
      'SELECT * FROM "RecommendationSnapshot"',
      'WHERE "clusterKey" = $1 AND "asOf" >= $2 AND "asOf" < $3',
    ].join(' '), input.clusterKey, fromStart, toEnd);
    const candidates = await queryRows(prisma, [
      'SELECT * FROM "StockExposureCandidate"',
      'WHERE "clusterKey" = $1 AND "asOf" >= $2 AND "asOf" < $3',
    ].join(' '), input.clusterKey, fromStart, toEnd);
    const promotedFacts = await queryRows(prisma, [
      'SELECT * FROM "StockExposureFact"',
      'WHERE "clusterKey" = $1 AND "validFrom" >= $2 AND "validFrom" < $3 AND status = $4',
    ].join(' '), input.clusterKey, fromStart, toEnd, 'active');
    const promotedAliases = await queryRows(prisma, [
      'SELECT * FROM "KeywordAlias"',
      'WHERE "clusterKey" = $1 AND "validFrom" >= $2 AND "validFrom" < $3 AND status = $4',
    ].join(' '), input.clusterKey, fromStart, toEnd, 'active');
    const postReviewAliases = await queryRows(prisma, [
      'SELECT status, source, count(*)::int AS count FROM "KeywordAlias"',
      'WHERE "clusterKey" = $1',
      'GROUP BY status, source',
      'ORDER BY status ASC, source ASC',
    ].join(' '), input.clusterKey);
    const factSnapshots = await queryRows(prisma, [
      'SELECT "traceId", "asOf", "activeExposureCount", "activeAliasCount", "factHash"',
      'FROM "FactSnapshot"',
      'WHERE "clusterKey" = $1',
      'ORDER BY "createdAt" DESC',
      'LIMIT 5',
    ].join(' '), input.clusterKey);

    const reasonCounts: Record<string, number> = {};
    for (const gap of gaps) {
      incrementReason(reasonCounts, String(gap.missReason));
    }
    const hitSymbols = new Set(limitUpCases.map(row => String(row.symbol)));
    const selectedHits = recommendations.filter(row => hitSymbols.has(String(row.symbol))).length;
    const recommendationScores = recommendations.map(row => Number(row.finalScore ?? 0)).filter(score => Number.isFinite(score));
    const averageRecommendationScore = recommendationScores.length > 0
      ? recommendationScores.reduce((sum, score) => sum + score, 0) / recommendationScores.length
      : 0;

    return {
      clusterKey: input.clusterKey,
      from: input.from.toISOString(),
      to: input.to.toISOString(),
      limitUpCaseCount: limitUpCases.length,
      selectedHitCount: selectedHits,
      missedCases: gaps.length,
      candidateCount: candidates.length,
      promotedFactCount: promotedFacts.length,
      promotedAliasCount: promotedAliases.length,
      postReviewAliasStatusCounts: postReviewAliases,
      latestFactSnapshots: factSnapshots,
      noEvidenceGaps: reasonCounts.no_evidence_chain ?? 0,
      scoreTooLowGaps: reasonCounts.score_too_low ?? 0,
      filteredOutGaps: reasonCounts.filtered_out ?? 0,
      notInStockPoolGaps: reasonCounts.not_in_stock_pool ?? 0,
      nextDayScoringImpact: {
        recommendationCount: recommendations.length,
        averageRecommendationScore: Number(averageRecommendationScore.toFixed(4)),
        selectedHitCount: selectedHits,
      },
      reasonCounts,
    };
  }
}

async function queryRows(
  prisma: any,
  sql: string,
  ...params: readonly unknown[]
): Promise<readonly Record<string, unknown>[]> {
  if (typeof prisma?.$queryRawUnsafe === 'function') {
    return await prisma.$queryRawUnsafe(sql, ...params) as readonly Record<string, unknown>[];
  }
  return [];
}
