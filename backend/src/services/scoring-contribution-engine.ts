import crypto from 'node:crypto';

import { Prisma } from '@prisma/client';
import { CoverageInitializationRepository } from '../repositories/coverage-initialization-repository.js';
import { FactSnapshotService } from './limitup-evidence-initialization.js';
import { IStrategyExperimentConfig } from './strategy-experiment-core.js';
import {
  normalizeDecimalNumber,
  normalizeDirectionWeight,
  normalizeKeyword,
  longestCommonSubstringLength,
  calculateTimeDecay,
  calculateExposureBreadthWeight,
} from './scoring-utils.js';
import { clamp, toNumber } from '../lib/number-utils.js';



export interface IScoringEngineInput {
  readonly traceId: string;
  readonly asOf: Date;
  readonly clusterKey: string;
  readonly newsWindowDays?: number;
  // 动态打分配置 Profile 参数
  readonly scoringProfile?: 'short_news' | 'industry_cycle' | 'fundamental_theme' | 'custom';
  readonly halfLifeDays?: number;
  readonly maxWindowDays?: number;
  readonly strategyConfig?: IStrategyExperimentConfig;
}

export interface IScoringEngineOutput {
  readonly traceId: string;
  readonly asOf: Date;
  readonly clusterKey: string;
  readonly contributionCount: number;
  readonly snapshotCount: number;
  readonly profileUsed: string;
  readonly halfLifeDaysUsed: number;
  readonly maxWindowDaysUsed: number;
  readonly metrics?: Record<string, unknown>;
}

interface IScoringGraphNodeSnapshot {
  readonly keyword: string;
  readonly frequency?: number;
  readonly temperature?: string;
  readonly weakSignal?: boolean;
  readonly category?: string;
}

interface IScoringGraphEdgeSnapshot {
  readonly sourceKeyword: string;
  readonly targetKeyword: string;
  readonly confidence: number;
  readonly weakSignal?: boolean;
  readonly relationType?: string;
  readonly evidence?: readonly string[];
  readonly reasoning?: string;
}

interface IScoringGraphSignal {
  readonly nodes: readonly IScoringGraphNodeSnapshot[];
  readonly edges: readonly IScoringGraphEdgeSnapshot[];
}

interface IMarketSignalScore {
  readonly score: number;
  readonly latestTradingDay: string | null;
  readonly latestTradingDayDate?: Date | null;
  readonly latestMarketTradingDay?: string | null;
  readonly staleTradingDays?: number;
  readonly isFresh?: boolean;
  readonly momentum5dPct: number | null;
  readonly momentum20dPct: number | null;
  readonly longTermMomentumPct: number | null;
  readonly volumeRatio20d: number | null;
  readonly breakout20d: boolean;
  readonly volatilityCompression: boolean;
  readonly recentWeekGainExceeded: boolean;
  // 当日涨跌（最新 close vs 前一日 close），不足 2 条 Candle 记 null
  readonly todayChangePct?: number | null;
  readonly reasons: readonly string[];
}

interface IStockMovementEvidence {
  readonly symbol: string;
  readonly keyword: string;
  readonly source: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly confidence: number;
  readonly direction: 'positive' | 'negative' | 'neutral';
  readonly scoreAdjustment: number;
  readonly evidenceText: string;
  readonly observedAt: string | null;
}

interface IInternalContributionMetadata {
  readonly exposurePrecisionScore: number;
  readonly exposureFactId: string | null;
  readonly exposureType: string;
  readonly taxonomyLevel: string | null;
}

interface IExposureKeywordMatch {
  readonly sourceKeyword: string;
  readonly exposureKeyword: string;
  readonly method: string;
  readonly confidence: number;
  readonly reason: string;
}

interface IActiveKeywordAlias {
  readonly sourceKeyword: string;
  readonly canonicalKeyword: string;
  readonly relationType: string;
  readonly confidence: number;
  readonly source: string;
  readonly sourceId: string;
}

interface IActiveKeywordPerformancePenalty {
  readonly keyword: string;
  readonly factor: number;
  readonly lossPct: number;
  readonly triggerSymbol: string;
  readonly validTo: Date | null;
  readonly reason: string;
}

interface IExposureKeywordEntry {
  readonly keyword: string;
  readonly norm: string;
}

interface IExposureKeywordIndex {
  readonly entries: readonly IExposureKeywordEntry[];
  readonly exactByNorm: ReadonlyMap<string, readonly IExposureKeywordEntry[]>;
  readonly twoGramByNorm: ReadonlyMap<string, readonly IExposureKeywordEntry[]>;
  readonly threeGramByNorm: ReadonlyMap<string, readonly IExposureKeywordEntry[]>;
}

const GRAPH_RELATION_CONFIDENCE_CAP = 2.0;
const GRAPH_WEAK_SIGNAL_CAP = 1.0;
const GRAPH_WEAK_NODE_BONUS = 0.5;
const GRAPH_WEAK_EDGE_BONUS = 0.25;
const BROAD_EXPOSURE_MIN_WEIGHT = 0.08;
const EVIDENCE_SCORE_MAX = 45;
const GRAPH_SCORE_MAX = 20;
const EXPOSURE_PRECISION_SCORE_MAX = 15;
const MARKET_SIGNAL_SCORE_MAX = 20;
const GRAPH_RELATION_SCORE_MAX = 12;
const GRAPH_WEAK_SIGNAL_SCORE_MAX = 8;
const EVIDENCE_KEYWORD_CONTRIB_CAP = 1.5;
const EVIDENCE_DIVERSITY_MIN_CONTRIB = 0.2;
const MOVEMENT_CONFIRMATION_SCORE_CAP = 2;
const MOVEMENT_CONFIRMATION_UNIT_SCORE = 0.8;
const MAX_MOVEMENT_EVIDENCE_PER_SYMBOL = 3;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const asArray = (value: unknown): readonly unknown[] => {
  return Array.isArray(value) ? value : [];
};

const parseGraphNodes = (nodesJson: unknown): readonly IScoringGraphNodeSnapshot[] => {
  return asArray(nodesJson)
    .filter(isRecord)
    .filter(node => typeof node.keyword === 'string' && node.keyword.trim().length > 0)
    .map(node => ({
      keyword: String(node.keyword),
      frequency: typeof node.frequency === 'number' ? node.frequency : undefined,
      temperature: typeof node.temperature === 'string' ? node.temperature : undefined,
      weakSignal: node.weakSignal === true,
      category: typeof node.category === 'string' ? node.category : undefined,
    }));
};

const parseGraphEdges = (edgesJson: unknown): readonly IScoringGraphEdgeSnapshot[] => {
  return asArray(edgesJson)
    .filter(isRecord)
    .filter(edge => (
      typeof edge.sourceKeyword === 'string'
      && edge.sourceKeyword.trim().length > 0
      && typeof edge.targetKeyword === 'string'
      && edge.targetKeyword.trim().length > 0
    ))
    .map(edge => ({
      sourceKeyword: String(edge.sourceKeyword),
      targetKeyword: String(edge.targetKeyword),
      confidence: typeof edge.confidence === 'number' ? edge.confidence : Number(edge.confidence ?? 0),
      weakSignal: edge.weakSignal === true,
      relationType: typeof edge.relationType === 'string' ? edge.relationType : undefined,
      evidence: Array.isArray(edge.evidence) ? edge.evidence.filter(item => typeof item === 'string') : undefined,
      reasoning: typeof edge.reasoning === 'string' ? edge.reasoning : undefined,
    }))
    .filter(edge => Number.isFinite(edge.confidence) && edge.confidence > 0);
};

const loadGraphSignal = async (prisma: any, traceId: string, clusterKey: string): Promise<IScoringGraphSignal> => {
  if (!prisma.graphSnapshot?.findUnique) {
    return { nodes: [], edges: [] };
  }

  const graphSnapshot = await prisma.graphSnapshot.findUnique({
    where: { traceId },
  });

  if (!graphSnapshot || graphSnapshot.clusterKey !== clusterKey) {
    return { nodes: [], edges: [] };
  }

  return {
    nodes: parseGraphNodes(graphSnapshot.nodesJson),
    edges: parseGraphEdges(graphSnapshot.edgesJson),
  };
};

const hasDelegate = (prisma: any, delegateName: string, methodName: string): boolean => {
  return typeof prisma?.[delegateName]?.[methodName] === 'function';
};



const toRecordOrEmpty = (value: unknown): Record<string, unknown> => {
  return isRecord(value) && !Array.isArray(value) ? value : {};
};

const readStringField = (record: Readonly<Record<string, unknown>>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const raw = record[key];
    if (raw === null || raw === undefined) {
      continue;
    }
    const text = String(raw).trim();
    if (text.length > 0) {
      return text;
    }
  }
  return null;
};



const DIRECT_STOCK_NAME_MATCH_MIN_LENGTH = 4;

const addExposureKeywordEntry = (
  map: Map<string, IExposureKeywordEntry[]>,
  key: string,
  entry: IExposureKeywordEntry,
): void => {
  const list = map.get(key) ?? [];
  list.push(entry);
  map.set(key, list);
};

const extractUniqueGrams = (value: string, size: number): readonly string[] => {
  if (value.length < size) {
    return [];
  }
  const grams = new Set<string>();
  for (let index = 0; index <= value.length - size; index += 1) {
    grams.add(value.slice(index, index + size));
  }
  return [...grams];
};

const buildExposureKeywordIndex = (exposureKeywords: readonly string[]): IExposureKeywordIndex => {
  const entries: IExposureKeywordEntry[] = [];
  const exactByNorm = new Map<string, IExposureKeywordEntry[]>();
  const twoGramByNorm = new Map<string, IExposureKeywordEntry[]>();
  const threeGramByNorm = new Map<string, IExposureKeywordEntry[]>();

  for (const rawKeyword of exposureKeywords) {
    const keyword = String(rawKeyword ?? '').trim();
    const norm = normalizeKeyword(keyword);
    if (!norm) {
      continue;
    }

    const entry = { keyword, norm };
    entries.push(entry);
    addExposureKeywordEntry(exactByNorm, norm, entry);

    for (const gram of extractUniqueGrams(norm, 2)) {
      addExposureKeywordEntry(twoGramByNorm, gram, entry);
    }
    for (const gram of extractUniqueGrams(norm, 3)) {
      addExposureKeywordEntry(threeGramByNorm, gram, entry);
    }
  }

  return {
    entries,
    exactByNorm,
    twoGramByNorm,
    threeGramByNorm,
  };
};

const addCandidateEntries = (
  candidates: Map<string, IExposureKeywordEntry>,
  entries: readonly IExposureKeywordEntry[] | undefined,
): void => {
  for (const entry of entries ?? []) {
    candidates.set(entry.keyword, entry);
  }
};

const getRarestGramCandidates = (
  gramIndex: ReadonlyMap<string, readonly IExposureKeywordEntry[]>,
  grams: readonly string[],
): readonly IExposureKeywordEntry[] => {
  let rarest: readonly IExposureKeywordEntry[] | null = null;
  for (const gram of grams) {
    const entries = gramIndex.get(gram) ?? [];
    if (entries.length === 0) {
      return [];
    }
    if (!rarest || entries.length < rarest.length) {
      rarest = entries;
    }
  }
  return rarest ?? [];
};

const getExposureEntriesContainingNorm = (
  exposureKeywordIndex: IExposureKeywordIndex,
  targetNorm: string,
): readonly IExposureKeywordEntry[] => {
  if (!targetNorm) {
    return [];
  }

  if (targetNorm.length < 2) {
    return exposureKeywordIndex.entries.filter(entry => entry.norm.includes(targetNorm));
  }

  const candidateEntries = getRarestGramCandidates(
    exposureKeywordIndex.twoGramByNorm,
    extractUniqueGrams(targetNorm, 2),
  );
  return candidateEntries.filter(entry => entry.norm.includes(targetNorm));
};

const getExposureEntriesContainedByNorm = (
  exposureKeywordIndex: IExposureKeywordIndex,
  sourceNorm: string,
): readonly IExposureKeywordEntry[] => {
  const candidates = new Map<string, IExposureKeywordEntry>();
  for (let start = 0; start < sourceNorm.length; start += 1) {
    for (let end = start + 2; end <= sourceNorm.length; end += 1) {
      addCandidateEntries(candidates, exposureKeywordIndex.exactByNorm.get(sourceNorm.slice(start, end)));
    }
  }
  return [...candidates.values()].filter(entry => sourceNorm.includes(entry.norm));
};

const getFuzzyOverlapCandidates = (
  exposureKeywordIndex: IExposureKeywordIndex,
  sourceNorm: string,
): readonly IExposureKeywordEntry[] => {
  const candidates = new Map<string, IExposureKeywordEntry>();
  for (const gram of extractUniqueGrams(sourceNorm, 3)) {
    addCandidateEntries(candidates, exposureKeywordIndex.threeGramByNorm.get(gram));
  }
  return [...candidates.values()];
};

const taxonomyRank = (value: unknown): number => {
  if (value === 'SW3') {
    return 3;
  }
  if (value === 'SW2') {
    return 2;
  }
  if (value === 'SW1') {
    return 1;
  }
  return 0;
};

const exposureSpecificityScore = (exposure: any): number => {
  const memberCount = Number(exposure.memberCount);
  const breadthPenalty = Number.isFinite(memberCount) && memberCount > 0
    ? Math.min(0.3, 1 / Math.sqrt(memberCount))
    : 0.15;
  return taxonomyRank(exposure.taxonomyLevel) + breadthPenalty;
};

const scoringExposureSources = new Set([
  'tickflow_sw_universe',
  'akshare_industry_board_em',
  'akshare_concept_board_em',
  'akshare_individual_info_em',
  'manual_verified',
  'test_exposure',
]);

const movementExposureSources = new Set([
  'akshare_stock_changes_em',
  'akshare_board_change_em',
]);

const isScoringExposureFact = (exposure: any): boolean => {
  const source = String(exposure.source ?? '');
  const exposureType = String(exposure.exposureType ?? '');
  if (source === 'historical_limitup_news' || exposureType === 'movement_evidence') {
    return false;
  }
  return scoringExposureSources.has(source);
};

const buildExposureKeywordMatches = (
  signal: any,
  exposureKeywordIndex: IExposureKeywordIndex,
  stockNames: ReadonlySet<string>,
  activeAliases: readonly IActiveKeywordAlias[],
): readonly IExposureKeywordMatch[] => {
  const sourceKeyword = String(signal.assetOrThemeKeyword ?? '').trim();
  const sourceNorm = normalizeKeyword(sourceKeyword);
  if (!sourceNorm) {
    return [];
  }
  if (stockNames.has(sourceKeyword) && sourceKeyword.length >= DIRECT_STOCK_NAME_MATCH_MIN_LENGTH) {
    return [];
  }

  const signalText = normalizeKeyword([
    sourceKeyword,
    signal.event,
    signal.businessVariable,
    signal.evidenceText,
  ].join(' '));
  const matches = new Map<string, IExposureKeywordMatch>();

  const addMatch = (
    exposureKeyword: string,
    method: string,
    confidence: number,
    reason: string,
  ): void => {
    const existing = matches.get(exposureKeyword);
    if (existing && existing.confidence >= confidence) {
      return;
    }
    matches.set(exposureKeyword, {
      sourceKeyword,
      exposureKeyword,
      method,
      confidence: Number(clamp(confidence, 0, 1).toFixed(4)),
      reason,
    });
  };

  for (const entry of exposureKeywordIndex.exactByNorm.get(sourceNorm) ?? []) {
    addMatch(entry.keyword, 'exact_keyword', 1, '因果关键词与暴露词精确一致');
  }

  if (sourceNorm.length >= 2) {
    for (const entry of getExposureEntriesContainingNorm(exposureKeywordIndex, sourceNorm)) {
      addMatch(entry.keyword, 'exposure_contains_signal', 0.9, '暴露词包含因果关键词');
    }

    for (const entry of getExposureEntriesContainedByNorm(exposureKeywordIndex, sourceNorm)) {
      addMatch(entry.keyword, 'signal_contains_exposure', 0.86, '因果关键词包含暴露词');
    }
  }

  if (sourceNorm.length >= 4) {
    for (const entry of getFuzzyOverlapCandidates(exposureKeywordIndex, sourceNorm)) {
      if (entry.norm.length < 4) {
        continue;
      }

      const commonLength = longestCommonSubstringLength(sourceNorm, entry.norm);
      if (
        commonLength >= 3
        && commonLength / Math.min(sourceNorm.length, entry.norm.length) >= 0.6
      ) {
        addMatch(entry.keyword, 'keyword_substring_overlap', 0.72 + Math.min(0.12, commonLength * 0.02), '因果关键词与暴露词存在稳定子串重叠');
      }
    }
  }

  for (const alias of activeAliases) {
    const sourceNormForAlias = normalizeKeyword(alias.sourceKeyword);
    const canonicalNormForAlias = normalizeKeyword(alias.canonicalKeyword);
    if (!sourceNormForAlias || !canonicalNormForAlias || !signalText.includes(sourceNormForAlias)) {
      continue;
    }

    for (const entry of getExposureEntriesContainingNorm(exposureKeywordIndex, canonicalNormForAlias)) {
      addMatch(
        entry.keyword,
        alias.relationType,
        alias.confidence,
        `因果词通过活跃 KeywordAlias 映射到 StockExposureFact 词表，aliasSource=${alias.source}:${alias.sourceId}`,
      );
    }
  }

  return [...matches.values()]
    .sort((left, right) => right.confidence - left.confidence || left.exposureKeyword.localeCompare(right.exposureKeyword))
    .slice(0, 6);
};

const calculateExposurePrecisionScore = (exposure: any, breadthWeight: number): number => {
  const exposureType = String(exposure.exposureType ?? '');
  const taxonomyLevel = String(exposure.taxonomyLevel ?? '').toUpperCase();
  let baseScore = 6;

  if (exposureType === 'business_exposure') {
    baseScore = 15;
  }
  else if (exposureType === 'concept_exposure') {
    baseScore = 12;
  }
  else if (taxonomyLevel === 'SW3') {
    baseScore = 10;
  }
  else if (taxonomyLevel === 'SW2') {
    baseScore = 7;
  }
  else if (taxonomyLevel === 'SW1') {
    baseScore = 4;
  }

  const confidence = normalizeDecimalNumber(exposure.confidence, 1);
  const breadthAdjusted = 0.5 + 0.5 * clamp(breadthWeight, BROAD_EXPOSURE_MIN_WEIGHT, 1);
  return Number(clamp(baseScore * confidence * breadthAdjusted, 0, EXPOSURE_PRECISION_SCORE_MAX).toFixed(4));
};

const getBestExposureByKeyword = (exposures: readonly any[]): Map<string, any> => {
  const best = new Map<string, any>();
  for (const exposure of exposures) {
    const existing = best.get(exposure.keyword);
    if (!existing || exposureSpecificityScore(exposure) > exposureSpecificityScore(existing)) {
      best.set(exposure.keyword, exposure);
    }
  }
  return best;
};

const extractInternalMetadata = (contribution: any): IInternalContributionMetadata => ({
  exposurePrecisionScore: normalizeDecimalNumber(contribution.__exposurePrecisionScore, 0),
  exposureFactId: typeof contribution.__exposureFactId === 'string' ? contribution.__exposureFactId : null,
  exposureType: typeof contribution.__exposureType === 'string' ? contribution.__exposureType : 'unknown',
  taxonomyLevel: typeof contribution.__taxonomyLevel === 'string' ? contribution.__taxonomyLevel : null,
});

const toEvidenceContributionCreateRow = (contribution: any): any => {
  const {
    __exposurePrecisionScore: _exposurePrecisionScore,
    __exposureFactId: _exposureFactId,
    __exposureType: _exposureType,
    __taxonomyLevel: _taxonomyLevel,
    ...row
  } = contribution;
  void _exposurePrecisionScore;
  void _exposureFactId;
  void _exposureType;
  void _taxonomyLevel;
  return row;
};

const stableEvidenceContributionId = (row: any): string => {
  const digest = crypto
    .createHash('sha256')
    .update([
      row.traceId,
      row.newsId,
      row.symbol,
      row.keyword,
    ].join('|'))
    .digest('hex')
    .slice(0, 24);
  return `ec_${digest}`;
};

const toSqlTimestamp = (value: unknown): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(String(value)).toISOString();
};

const toSqlDecimal = (value: unknown, fallback = '0'): string => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : fallback;
};

const toEvidenceContributionSqlRow = (contribution: any): Record<string, unknown> => {
  const row = toEvidenceContributionCreateRow(contribution);
  return {
    id: stableEvidenceContributionId(row),
    traceId: String(row.traceId),
    newsId: String(row.newsId),
    symbol: String(row.symbol),
    keyword: String(row.keyword),
    sourceKeyword: typeof row.sourceKeyword === 'string' ? row.sourceKeyword : null,
    matchedExposureKeyword: typeof row.matchedExposureKeyword === 'string' ? row.matchedExposureKeyword : null,
    exposureFactId: typeof row.exposureFactId === 'string' ? row.exposureFactId : null,
    matchMethod: typeof row.matchMethod === 'string' ? row.matchMethod : null,
    matchConfidence: row.matchConfidence === null || row.matchConfidence === undefined ? null : toSqlDecimal(row.matchConfidence),
    baseFrequencyScore: toSqlDecimal(row.baseFrequencyScore),
    timeDecayedScore: toSqlDecimal(row.timeDecayedScore),
    reprintPenaltyScore: toSqlDecimal(row.reprintPenaltyScore),
    finalContribScore: toSqlDecimal(row.finalContribScore),
    reasons: Array.isArray(row.reasons) ? row.reasons.map(String) : [],
    asOf: toSqlTimestamp(row.asOf),
    clusterKey: String(row.clusterKey),
  };
};

const chunkArray = <T>(items: readonly T[], chunkSize: number): readonly T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
};

const persistEvidenceContributions = async (prisma: any, contributions: readonly any[]): Promise<void> => {
  if (contributions.length === 0) {
    return;
  }

  if (typeof prisma?.$executeRawUnsafe === 'function') {
    for (const chunk of chunkArray(contributions, 1000)) {
      const rowsJson = JSON.stringify(chunk.map(toEvidenceContributionSqlRow));
      await prisma.$executeRawUnsafe(
        [
          'INSERT INTO "EvidenceContribution" (',
          '  id, "traceId", "newsId", symbol, keyword, "sourceKeyword", "matchedExposureKeyword", "exposureFactId",',
          '  "matchMethod", "matchConfidence", "baseFrequencyScore", "timeDecayedScore", "reprintPenaltyScore",',
          '  "finalContribScore", reasons, "asOf", "clusterKey"',
          ')',
          'SELECT',
          '  row.id, row."traceId", row."newsId", row.symbol, row.keyword, row."sourceKeyword", row."matchedExposureKeyword", row."exposureFactId",',
          '  row."matchMethod", row."matchConfidence"::decimal(5,4), row."baseFrequencyScore"::decimal(10,4),',
          '  row."timeDecayedScore"::decimal(10,4), row."reprintPenaltyScore"::decimal(10,4),',
          '  row."finalContribScore"::decimal(10,4),',
          '  ARRAY(SELECT jsonb_array_elements_text(row.reasons)),',
          '  row."asOf"::timestamp(3), row."clusterKey"',
          'FROM jsonb_to_recordset($1::jsonb) AS row(',
          '  id text, "traceId" text, "newsId" text, symbol text, keyword text, "sourceKeyword" text,',
          '  "matchedExposureKeyword" text, "exposureFactId" text, "matchMethod" text, "matchConfidence" text,',
          '  "baseFrequencyScore" text, "timeDecayedScore" text, "reprintPenaltyScore" text, "finalContribScore" text,',
          '  reasons jsonb, "asOf" text, "clusterKey" text',
          ')',
          'ON CONFLICT ("traceId", "newsId", symbol, keyword) DO NOTHING',
        ].join(' '),
        rowsJson,
      );
    }
    return;
  }

  await prisma.evidenceContribution.createMany({
    data: contributions.map(toEvidenceContributionCreateRow),
    skipDuplicates: true,
  });
};

const persistExposureMatchCache = async (
  prisma: any,
  input: {
    readonly contributions: readonly any[];
    readonly clusterKey: string;
    readonly asOf: Date;
  },
): Promise<number> => {
  if (input.contributions.length === 0 || typeof prisma?.$executeRawUnsafe !== 'function') {
    return 0;
  }

  const cacheRowsByKey = new Map<string, Record<string, unknown>>();
  for (const contribution of input.contributions) {
    const sourceKeyword = typeof contribution.sourceKeyword === 'string' ? contribution.sourceKeyword.trim() : '';
    const exposureKeyword = typeof contribution.matchedExposureKeyword === 'string'
      ? contribution.matchedExposureKeyword.trim()
      : String(contribution.keyword ?? '').trim();
    const matchMethod = typeof contribution.matchMethod === 'string' ? contribution.matchMethod.trim() : 'unknown';
    if (!sourceKeyword || !exposureKeyword) {
      continue;
    }
    const key = `${input.clusterKey}|${sourceKeyword}|${exposureKeyword}|${matchMethod}`;
    if (cacheRowsByKey.has(key)) {
      continue;
    }
    cacheRowsByKey.set(key, {
      clusterKey: input.clusterKey,
      sourceKeyword,
      exposureKeyword,
      exposureFactId: typeof contribution.exposureFactId === 'string' ? contribution.exposureFactId : null,
      matchMethod,
      matchConfidence: toSqlDecimal(contribution.matchConfidence, '0'),
      reason: Array.isArray(contribution.reasons)
        ? String(contribution.reasons.find((reason: unknown) => String(reason).includes('匹配暴露词')) ?? '由 EvidenceContribution 反推的可复用暴露匹配')
        : '由 EvidenceContribution 反推的可复用暴露匹配',
      validFrom: toSqlTimestamp(input.asOf),
    });
  }

  const cacheRows = [...cacheRowsByKey.values()];
  if (cacheRows.length === 0) {
    return 0;
  }

  for (const chunk of chunkArray(cacheRows, 1000)) {
    await prisma.$executeRawUnsafe(
      [
        'INSERT INTO "ExposureMatchCache" (',
        '  id, "clusterKey", "sourceKeyword", "exposureKeyword", "exposureFactId",',
        '  "matchMethod", "matchConfidence", reason, "validFrom", "hitCount", "updatedAt"',
        ')',
        'SELECT',
        '  concat(\'emc_\', substr(md5(row."clusterKey" || \'|\' || row."sourceKeyword" || \'|\' || row."exposureKeyword" || \'|\' || row."matchMethod"), 1, 24)),',
        '  row."clusterKey", row."sourceKeyword", row."exposureKeyword", row."exposureFactId",',
        '  row."matchMethod", row."matchConfidence"::decimal(5,4), row.reason, row."validFrom"::timestamp(3), 1, CURRENT_TIMESTAMP',
        'FROM jsonb_to_recordset($1::jsonb) AS row(',
        '  "clusterKey" text, "sourceKeyword" text, "exposureKeyword" text, "exposureFactId" text,',
        '  "matchMethod" text, "matchConfidence" text, reason text, "validFrom" text',
        ')',
        'ON CONFLICT ("clusterKey", "sourceKeyword", "exposureKeyword", "matchMethod") DO UPDATE SET',
        '  "exposureFactId" = COALESCE("ExposureMatchCache"."exposureFactId", EXCLUDED."exposureFactId"),',
        '  "matchConfidence" = GREATEST("ExposureMatchCache"."matchConfidence", EXCLUDED."matchConfidence"),',
        '  reason = EXCLUDED.reason,',
        '  "validTo" = NULL,',
        '  "hitCount" = "ExposureMatchCache"."hitCount" + 1,',
        '  "updatedAt" = CURRENT_TIMESTAMP',
      ].join(' '),
      JSON.stringify(chunk),
    );
  }

  return cacheRows.length;
};

const readContributionKeyword = (contribution: any): string => {
  return String(contribution.matchedExposureKeyword ?? contribution.keyword);
};

const calculateEvidenceComponentScore = (keywordContribSums: ReadonlyMap<string, number>): number => {
  let evidencePower = 0;
  for (const sumFinalContrib of keywordContribSums.values()) {
    const effectiveContrib = Math.min(EVIDENCE_KEYWORD_CONTRIB_CAP, Math.max(0, sumFinalContrib));
    evidencePower += Math.log1p(effectiveContrib) * 1.8;
  }
  const baseScore = EVIDENCE_SCORE_MAX * (1 - Math.exp(-evidencePower / 1.8));
  const diverseKeywordCount = [...keywordContribSums.values()]
    .filter(value => Math.min(EVIDENCE_KEYWORD_CONTRIB_CAP, Math.max(0, value)) >= EVIDENCE_DIVERSITY_MIN_CONTRIB)
    .length;
  const diversityBonus = Math.min(5, Math.max(0, diverseKeywordCount - 1) * 1.5);
  return Number(clamp(baseScore + diversityBonus, 0, EVIDENCE_SCORE_MAX).toFixed(4));
};

const calculateGraphComponentScores = (
  rawRelationConfidenceScore: number,
  rawWeakSignalBonus: number,
): { relationScore: number; weakSignalScore: number; total: number } => {
  const relationScore = GRAPH_RELATION_CONFIDENCE_CAP <= 0
    ? 0
    : (Math.min(rawRelationConfidenceScore, GRAPH_RELATION_CONFIDENCE_CAP) / GRAPH_RELATION_CONFIDENCE_CAP) * GRAPH_RELATION_SCORE_MAX;
  const weakSignalScore = GRAPH_WEAK_SIGNAL_CAP <= 0
    ? 0
    : (Math.min(rawWeakSignalBonus, GRAPH_WEAK_SIGNAL_CAP) / GRAPH_WEAK_SIGNAL_CAP) * GRAPH_WEAK_SIGNAL_SCORE_MAX;
  const total = Number(clamp(relationScore + weakSignalScore, 0, GRAPH_SCORE_MAX).toFixed(4));
  return {
    relationScore: Number(relationScore.toFixed(4)),
    weakSignalScore: Number(weakSignalScore.toFixed(4)),
    total,
  };
};

const average = (values: readonly number[]): number | null => {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

export const calculateMarketSignalScore = (
  candlesDesc: readonly any[],
  strategyConfig?: IStrategyExperimentConfig,
): IMarketSignalScore => {
  const candles = [...candlesDesc].sort((left, right) => left.tradingDay.getTime() - right.tradingDay.getTime());
  if (candles.length < 6) {
    return {
      score: 0,
      latestTradingDay: candles.at(-1)?.tradingDay?.toISOString?.().slice(0, 10) ?? null,
      latestTradingDayDate: candles.at(-1)?.tradingDay ?? null,
      latestMarketTradingDay: candles.at(-1)?.tradingDay?.toISOString?.().slice(0, 10) ?? null,
      staleTradingDays: 0,
      isFresh: true,
      momentum5dPct: null,
      momentum20dPct: null,
      longTermMomentumPct: null,
      volumeRatio20d: null,
      breakout20d: false,
      volatilityCompression: false,
      recentWeekGainExceeded: false,
      reasons: ['市场确认信号：asOf 前可见 Candle 少于 6 条，记 0 分'],
    };
  }

  const latest = candles[candles.length - 1];
  const latestClose = toNumber(latest.close);
  const latestVolume = toNumber(latest.volume);
  // 当日涨跌：最新 close vs 前一日 close，不足 2 条 Candle 记 null
  const prevClose = candles.length >= 2 ? toNumber(candles[candles.length - 2]?.close) : null;
  const todayChangePct = prevClose && prevClose > 0 ? (latestClose - prevClose) / prevClose : null;
  const close5 = toNumber(candles[Math.max(0, candles.length - 6)]?.close);
  const close20 = candles.length >= 21 ? toNumber(candles[candles.length - 21]?.close) : null;
  const close120 = candles.length >= 121 ? toNumber(candles[candles.length - 121]?.close) : null;
  const momentum5dPct = close5 > 0 ? (latestClose - close5) / close5 : null;
  const momentum20dPct = close20 && close20 > 0 ? (latestClose - close20) / close20 : null;
  const longTermMomentumPct = close120 && close120 > 0 ? (latestClose - close120) / close120 : null;
  const previous20 = candles.slice(Math.max(0, candles.length - 21), -1);
  const avgVolume20 = average(previous20.map(candle => toNumber(candle.volume)).filter(value => value > 0));
  const volumeRatio20d = avgVolume20 && avgVolume20 > 0 ? latestVolume / avgVolume20 : null;
  const previous20High = previous20.length > 0
    ? Math.max(...previous20.map(candle => toNumber(candle.high)))
    : 0;
  const breakout20d = previous20High > 0 && latestClose >= previous20High;

  const recent5Ranges = candles.slice(Math.max(0, candles.length - 6)).map((candle) => {
    const close = toNumber(candle.close);
    return close > 0 ? (toNumber(candle.high) - toNumber(candle.low)) / close : 0;
  }).filter(value => value > 0);
  const previous20Ranges = previous20.map((candle) => {
    const close = toNumber(candle.close);
    return close > 0 ? (toNumber(candle.high) - toNumber(candle.low)) / close : 0;
  }).filter(value => value > 0);
  const recentRangeAvg = average(recent5Ranges);
  const previousRangeAvg = average(previous20Ranges);
  const avgClose20 = average(previous20.map(candle => toNumber(candle.close)).filter(value => value > 0));
  const volatilityCompression = Boolean(
    recentRangeAvg !== null
    && previousRangeAvg !== null
    && avgClose20 !== null
    && previousRangeAvg > 0
    && recentRangeAvg / previousRangeAvg <= 0.75
    && latestClose >= avgClose20,
  );

  // 低位区判定：最新收盘价低于 20 日均价的 95% 视为庄家吸筹区
  const isLowZone = avgClose20 !== null && latestClose < avgClose20 * 0.95;
  // 低位放量吸筹：低位区 + 量比 > 1.2
  const isAccumulation = isLowZone && volumeRatio20d !== null && volumeRatio20d > 1.2;
  const isLowVolumeRebound = isLowZone && (volumeRatio20d ?? 0) < 0.8;

  // 映射基本组件原始得分 (0 到 1)
  // S_m5：庄家吸筹验证（替代旧追涨逻辑：旧公式 (momentum5dPct+0.02)/0.1 涨越多分越高，与"发现弱信号"目标背离）
  let S_m5: number;
  let m5Reason: string;
  if (momentum5dPct === null) {
    S_m5 = 0;
    m5Reason = '5日动量NA';
  } else if (momentum5dPct > 0.1) {
    // 5日已涨超10%，追涨风险高，降权避免追涨
    S_m5 = 0.2;
    m5Reason = `5日涨幅 ${(momentum5dPct * 100).toFixed(2)}% > 10%，触发追涨降权 S_m5=0.2`;
  } else if (isAccumulation) {
    // 低位区+放量，庄家吸筹，最高分
    S_m5 = 1.0;
    m5Reason = '低位放量，庄家吸筹验证 S_m5=1.0';
  } else if (isLowVolumeRebound) {
    S_m5 = 0.1;
    m5Reason = '低位区但量能不足，弱反弹降权 S_m5=0.1';
  } else if (isLowZone) {
    // 低位区但量能不足
    S_m5 = 0.6;
    m5Reason = '低位区量能不足 S_m5=0.6';
  } else {
    // 中性区间：横盘整理得中等分，大起大落降分
    S_m5 = clamp((0.05 - Math.abs(momentum5dPct)) / 0.05, 0, 0.5);
    m5Reason = `中性区间横盘整理 S_m5=${S_m5.toFixed(4)}`;
  }

  // S_m20：20日动量分量，保持类似的低位吸筹偏好但更宽松
  let S_m20: number;
  if (momentum20dPct === null) {
    S_m20 = 0;
  } else if (momentum20dPct > 0.15) {
    // 20日已大涨，避免追高
    S_m20 = 0.3;
  } else if (momentum20dPct < -0.05 && isLowZone) {
    // 20日下跌且处于低位区，可能超跌反弹机会
    S_m20 = isLowVolumeRebound ? 0.2 : 0.9;
  } else {
    // 横盘整理得中等分
    S_m20 = clamp((0.1 - Math.abs(momentum20dPct)) / 0.1, 0, 0.6);
  }

  const S_vol = volumeRatio20d === null ? 0 : clamp((volumeRatio20d - 1) / 1.5, 0, 1);
  const S_br = breakout20d
    ? 1
    : (previous20High > 0 && latestClose >= previous20High * 0.97 ? 0.5 : 0);
  const S_cmp = volatilityCompression ? 1 : 0;

  // 新增指标 1：斐波那契回调计算与打分
  const fibLookback = strategyConfig?.fibonacciLookbackDays ?? 60;
  const fibThreshold = strategyConfig?.fibonacciThresholdPct ?? 0.015;
  const fibCandles = candles.slice(-fibLookback);
  let fibHit = false;
  let matchedFibLevel: number | null = null;
  if (fibCandles.length >= 10) {
    const fibHigh = Math.max(...fibCandles.map(c => toNumber(c.high)));
    const fibLow = Math.min(...fibCandles.map(c => toNumber(c.low)));
    const diff = fibHigh - fibLow;
    if (diff > 0) {
      const targetLevels = [0.382, 0.500, 0.618];
      for (const r of targetLevels) {
        const levelVal = fibHigh - r * diff;
        if (Math.abs(latestClose - levelVal) / latestClose <= fibThreshold) {
          fibHit = true;
          matchedFibLevel = r;
          break;
        }
      }
    }
  }
  const S_fib = fibHit ? 1 : 0;

  // 新增指标 2：支撑压力检测与打分
  const srLookback = strategyConfig?.supportResistanceLookbackDays ?? 60;
  const srThreshold = strategyConfig?.supportResistanceThresholdPct ?? 0.015;
  const srCandles = candles.slice(-srLookback);
  let srHit = false;
  let srType: 'support' | 'resistance' | null = null;
  if (srCandles.length >= 10) {
    const srHigh = Math.max(...srCandles.map(c => toNumber(c.high)));
    const srLow = Math.min(...srCandles.map(c => toNumber(c.low)));
    const nearSupport = Math.abs(latestClose - srLow) / latestClose <= srThreshold;
    const nearResistance = Math.abs(latestClose - srHigh) / latestClose <= srThreshold;
    if (nearSupport) {
      srHit = true;
      srType = 'support';
    } else if (nearResistance) {
      srHit = true;
      srType = 'resistance';
    }
  }
  const S_sr = srHit ? 1 : 0;

  // 行情权重配置读取与归一化打分
  const w = strategyConfig?.marketWeights ?? {
    momentum5d: 6,
    momentum20d: 5,
    volumeRatio: 4,
    breakout: 3,
    compression: 2,
    fibonacci: 0,
    supportResistance: 0,
  };
  const totalWeight = w.momentum5d + w.momentum20d + w.volumeRatio + w.breakout + w.compression + w.fibonacci + w.supportResistance;
  const weightedSum =
    (w.momentum5d * S_m5) +
    (w.momentum20d * S_m20) +
    (w.volumeRatio * S_vol) +
    (w.breakout * S_br) +
    (w.compression * S_cmp) +
    (w.fibonacci * S_fib) +
    (w.supportResistance * S_sr);

  const score = totalWeight > 0
    ? Number(clamp((weightedSum / totalWeight) * 20, 0, 20).toFixed(4))
    : 0;

  const fibDesc = fibHit ? `斐波那契回调 ${matchedFibLevel! * 100}% 水平命中` : '斐波那契回调未命中';
  const srDesc = srHit ? `支撑压力位 [${srType!}] 触碰` : '支撑压力未触碰';

  return {
    score,
    latestTradingDay: latest.tradingDay.toISOString().slice(0, 10),
    latestTradingDayDate: latest.tradingDay,
    latestMarketTradingDay: latest.tradingDay.toISOString().slice(0, 10),
    staleTradingDays: 0,
    isFresh: true,
    momentum5dPct: momentum5dPct === null ? null : Number(momentum5dPct.toFixed(6)),
    momentum20dPct: momentum20dPct === null ? null : Number(momentum20dPct.toFixed(6)),
    longTermMomentumPct: longTermMomentumPct === null ? null : Number(longTermMomentumPct.toFixed(6)),
    volumeRatio20d: volumeRatio20d === null ? null : Number(volumeRatio20d.toFixed(4)),
    breakout20d,
    volatilityCompression,
    recentWeekGainExceeded: momentum5dPct !== null && momentum5dPct > 0.2,
    todayChangePct: todayChangePct === null ? null : Number(todayChangePct.toFixed(6)),
    reasons: [
      `市场确认信号 ${score.toFixed(4)}/20：5日涨跌 ${momentum5dPct === null ? 'NA' : (momentum5dPct * 100).toFixed(2)}%，20日涨跌 ${momentum20dPct === null ? 'NA' : (momentum20dPct * 100).toFixed(2)}%，20日量比 ${volumeRatio20d === null ? 'NA' : volumeRatio20d.toFixed(2)}`,
      `长期趋势：120日涨跌 ${longTermMomentumPct === null ? 'NA' : (longTermMomentumPct * 100).toFixed(2)}%`,
      `低位区: ${isLowZone ? '是' : '否'}, 量比 ${volumeRatio20d === null ? 'NA' : volumeRatio20d.toFixed(2)}, 吸筹信号: ${isAccumulation ? '是' : '否'}`,
      `5日动量判定: ${m5Reason}`,
      `量化指标：${fibDesc}，${srDesc}`,
      `行情可见边界 tradingDay <= asOf，最新用于评分交易日 ${latest.tradingDay.toISOString().slice(0, 10)}`,
      `20日突破 ${breakout20d ? '是' : '否'}，波动压缩/突破组合 ${volatilityCompression ? '是' : '否'}`,
    ],
  };
};

const classifyMovementDirection = (text: string): IStockMovementEvidence['direction'] => {
  if (/(加速下跌|高台跳水|大笔卖出|封跌停板|打开涨停板|有大卖盘|竞价下跌|低开5日线|向下缺口|60日新低|60日大幅下跌)/u.test(text)) {
    return 'negative';
  }
  if (/(火箭发射|快速反弹|大笔买入|封涨停板|打开跌停板|有大买盘|竞价上涨|高开5日线|向上缺口|60日新高|60日大幅上涨|拉升|净流入)/u.test(text)) {
    return 'positive';
  }
  return 'neutral';
};

const movementDirectionLabel = (direction: IStockMovementEvidence['direction']): string => {
  switch (direction) {
    case 'positive':
      return '利好确认';
    case 'negative':
      return '风险确认';
    default:
      return '中性观察';
  }
};

const movementEvidenceFromRow = (row: any): IStockMovementEvidence | null => {
  if (String(row.exposureType ?? '') !== 'movement_evidence') {
    return null;
  }
  const source = String(row.source ?? '');
  if (!movementExposureSources.has(source)) {
    return null;
  }

  const evidence = toRecordOrEmpty(row.evidenceJson);
  const rawFields = toRecordOrEmpty(evidence.rawFields);
  const keyword = String(row.keyword ?? readStringField(rawFields, ['异动类型', '板块名称', '板块']) ?? '异动').trim();
  const sourceName = String(row.sourceName ?? readStringField(evidence, ['sourceName']) ?? '异动事实').trim();
  const sourceId = String(row.sourceId ?? readStringField(evidence, ['sourceId']) ?? keyword).trim();
  const confidence = normalizeDecimalNumber(row.confidence, 0.55);
  const movementText = [
    keyword,
    sourceName,
    readStringField(rawFields, ['异动类型', '板块异动最频繁个股及所属类型-买卖方向']),
    readStringField(rawFields, ['相关信息', '板块名称', '板块具体异动类型列表及出现次数']),
  ].filter(Boolean).join(' ');
  const direction = classifyMovementDirection(movementText);
  const directionWeight = direction === 'positive' ? 1 : direction === 'negative' ? -1 : 0;
  const scoreAdjustment = Number((directionWeight * confidence * MOVEMENT_CONFIRMATION_UNIT_SCORE).toFixed(4));
  const evidenceText = readStringField(evidence, ['confidenceReason', 'description'])
    ?? readStringField(rawFields, ['相关信息', '板块具体异动类型列表及出现次数', '板块名称', '板块'])
    ?? 'AKShare 异动接口返回该股票或所属板块异动';

  return {
    symbol: String(row.symbol),
    keyword,
    source,
    sourceId,
    sourceName,
    confidence,
    direction,
    scoreAdjustment,
    evidenceText,
    observedAt: readStringField(evidence, ['observedAt']),
  };
};

const loadMovementEvidence = async (
  prisma: any,
  input: { readonly clusterKey: string; readonly asOf: Date; readonly symbols: readonly string[] },
): Promise<Map<string, readonly IStockMovementEvidence[]>> => {
  if (!hasDelegate(prisma, 'stockExposureFact', 'findMany') || input.symbols.length === 0) {
    return new Map();
  }

  const rows = await prisma.stockExposureFact.findMany({
    where: {
      clusterKey: input.clusterKey,
      status: 'active',
      symbol: { in: [...input.symbols] },
      exposureType: 'movement_evidence',
      validFrom: { lte: input.asOf },
      OR: [
        { validTo: null },
        { validTo: { gte: input.asOf } },
      ],
    },
    orderBy: [
      { validFrom: 'desc' },
      { confidence: 'desc' },
    ],
  });

  const bySymbol = new Map<string, IStockMovementEvidence[]>();
  for (const row of rows) {
    const evidence = movementEvidenceFromRow(row);
    if (!evidence) {
      continue;
    }
    const list = bySymbol.get(evidence.symbol) ?? [];
    list.push(evidence);
    bySymbol.set(evidence.symbol, list);
  }

  const result = new Map<string, readonly IStockMovementEvidence[]>();
  for (const [symbol, evidenceList] of bySymbol.entries()) {
    result.set(
      symbol,
      evidenceList
        .sort((left, right) => Math.abs(right.scoreAdjustment) - Math.abs(left.scoreAdjustment) || right.confidence - left.confidence)
        .slice(0, MAX_MOVEMENT_EVIDENCE_PER_SYMBOL),
    );
  }
  return result;
};

const emptyMarketSignal = (reason: string): IMarketSignalScore => ({
  score: 0,
  latestTradingDay: null,
  latestTradingDayDate: null,
  latestMarketTradingDay: null,
  staleTradingDays: 0,
  isFresh: true,
  momentum5dPct: null,
  momentum20dPct: null,
  longTermMomentumPct: null,
  volumeRatio20d: null,
  breakout20d: false,
  volatilityCompression: false,
  recentWeekGainExceeded: false,
  reasons: [reason],
});

const enrichMarketSignalsWithMovement = (
  marketSignals: ReadonlyMap<string, IMarketSignalScore>,
  movementEvidenceBySymbol: ReadonlyMap<string, readonly IStockMovementEvidence[]>,
): Map<string, IMarketSignalScore> => {
  const results = new Map(marketSignals);
  for (const [symbol, evidenceList] of movementEvidenceBySymbol.entries()) {
    if (evidenceList.length === 0) {
      continue;
    }

    const base = results.get(symbol) ?? emptyMarketSignal('市场确认信号：缺少 asOf 前可见 Candle，行情分 0');
    if (base.reasons.some(reason => reason.startsWith('异动确认'))) {
      results.set(symbol, base);
      continue;
    }

    const movementAdjustment = Number(clamp(
      evidenceList.reduce((sum, evidence) => sum + evidence.scoreAdjustment, 0),
      -MOVEMENT_CONFIRMATION_SCORE_CAP,
      MOVEMENT_CONFIRMATION_SCORE_CAP,
    ).toFixed(4));
    const movementReasons = evidenceList.map((evidence) => {
      const signed = evidence.scoreAdjustment >= 0 ? `+${evidence.scoreAdjustment.toFixed(4)}` : evidence.scoreAdjustment.toFixed(4);
      return `异动事实 [${evidence.sourceName}] ${evidence.keyword}，${movementDirectionLabel(evidence.direction)} ${signed}/20，来源 ${evidence.source}:${evidence.sourceId}，置信度 ${evidence.confidence.toFixed(2)}，${evidence.evidenceText}`;
    });
    const signedTotal = movementAdjustment >= 0 ? `+${movementAdjustment.toFixed(4)}` : movementAdjustment.toFixed(4);
    results.set(symbol, {
      ...base,
      score: Number(clamp(base.score + movementAdjustment, 0, MARKET_SIGNAL_SCORE_MAX).toFixed(4)),
      reasons: [
        ...base.reasons,
        `异动确认 ${signedTotal}/20：仅在已有 EvidenceContribution 候选后作为市场确认调整，不单独生成推荐`,
        ...movementReasons,
      ],
    });
  }
  return results;
};

const toDecimalOrNull = (value: number | null, scale: number): Prisma.Decimal | null => {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return new Prisma.Decimal(value.toFixed(scale));
};

const parseLongTermMomentumFromReasons = (reasons: readonly string[]): number | null => {
  const line = reasons.find(reason => reason.includes('120日涨跌'));
  const matched = line?.match(/120日涨跌\s+(-?[\d.]+)%/u);
  const parsed = matched ? Number(matched[1]) / 100 : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

interface IMarketSignalFreshness {
  readonly latestMarketTradingDay: string | null;
  readonly latestMarketTradingDayDate: Date | null;
  readonly staleTradingDays: number;
}

const toDayKey = (value: Date | null | undefined): string | null => {
  return value?.toISOString?.().slice(0, 10) ?? null;
};

const withMarketSignalFreshness = (
  signal: IMarketSignalScore,
  freshness: IMarketSignalFreshness,
): IMarketSignalScore => {
  const isFresh = freshness.staleTradingDays === 0;
  return {
    ...signal,
    latestMarketTradingDay: freshness.latestMarketTradingDay,
    staleTradingDays: freshness.staleTradingDays,
    isFresh,
    reasons: [
      ...signal.reasons,
      `行情快照新鲜度：${isFresh ? 'fresh' : 'stale'}，snapshot=${signal.latestTradingDay ?? 'NA'}，latest=${freshness.latestMarketTradingDay ?? 'NA'}，staleTradingDays=${freshness.staleTradingDays}`,
    ],
  };
};

const loadMarketSignalFreshnessBySymbol = async (
  prisma: any,
  input: {
    readonly clusterKey: string;
    readonly asOf: Date;
    readonly snapshots: readonly { readonly symbol: string; readonly latestTradingDay: Date | null }[];
  },
): Promise<Map<string, IMarketSignalFreshness>> => {
  const symbols = [...new Set(input.snapshots.map(row => row.symbol))];
  const snapshotBySymbol = new Map(input.snapshots.map(row => [row.symbol, row.latestTradingDay]));
  const results = new Map<string, IMarketSignalFreshness>();
  if (symbols.length === 0 || !hasDelegate(prisma, 'candle', 'findMany')) {
    return results;
  }

  if (typeof prisma?.$queryRawUnsafe === 'function') {
    const rows = await prisma.$queryRawUnsafe(
      [
        'WITH input_rows AS (',
        '  SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(symbol text, "latestTradingDay" timestamp)',
        ')',
        'SELECT input_rows.symbol,',
        '       max(c."tradingDay") AS "latestMarketTradingDay",',
        '       count(c."tradingDay") FILTER (',
        '         WHERE input_rows."latestTradingDay" IS NOT NULL AND c."tradingDay" > input_rows."latestTradingDay"',
        '       )::int AS "staleTradingDays"',
        'FROM input_rows',
        'LEFT JOIN "Stock" s ON s.symbol = input_rows.symbol AND s."clusterKey" = $2',
        'LEFT JOIN "Candle" c ON c."stockId" = s.id AND c."tradingDay" <= $3',
        'GROUP BY input_rows.symbol',
      ].join(' '),
      JSON.stringify(input.snapshots.map(row => ({
        symbol: row.symbol,
        latestTradingDay: row.latestTradingDay?.toISOString?.() ?? null,
      }))),
      input.clusterKey,
      input.asOf,
    ) as readonly any[];

    for (const row of rows) {
      const latest = row.latestMarketTradingDay instanceof Date
        ? row.latestMarketTradingDay
        : (row.latestMarketTradingDay ? new Date(row.latestMarketTradingDay) : null);
      results.set(String(row.symbol), {
        latestMarketTradingDay: toDayKey(latest),
        latestMarketTradingDayDate: latest,
        staleTradingDays: Number(row.staleTradingDays ?? 0),
      });
    }
    return results;
  }

  const candles = await prisma.candle.findMany({
    where: {
      stock: {
        clusterKey: input.clusterKey,
        symbol: { in: symbols },
      },
      tradingDay: { lte: input.asOf },
    },
    select: {
      tradingDay: true,
      stock: { select: { symbol: true } },
    },
    orderBy: [
      { stockId: 'asc' },
      { tradingDay: 'desc' },
    ],
  });

  for (const symbol of symbols) {
    results.set(symbol, {
      latestMarketTradingDay: null,
      latestMarketTradingDayDate: null,
      staleTradingDays: 0,
    });
  }

  for (const candle of candles) {
    const symbol = String(candle.stock?.symbol ?? '');
    if (!symbol) {
      continue;
    }
    const current = results.get(symbol);
    const tradingDay = candle.tradingDay instanceof Date ? candle.tradingDay : new Date(candle.tradingDay);
    if (!current?.latestMarketTradingDayDate || tradingDay > current.latestMarketTradingDayDate) {
      results.set(symbol, {
        latestMarketTradingDay: toDayKey(tradingDay),
        latestMarketTradingDayDate: tradingDay,
        staleTradingDays: current?.staleTradingDays ?? 0,
      });
    }
    const snapshotTradingDay = snapshotBySymbol.get(symbol);
    if (snapshotTradingDay && tradingDay > snapshotTradingDay) {
      const latest = results.get(symbol);
      results.set(symbol, {
        latestMarketTradingDay: latest?.latestMarketTradingDay ?? toDayKey(tradingDay),
        latestMarketTradingDayDate: latest?.latestMarketTradingDayDate ?? tradingDay,
        staleTradingDays: (latest?.staleTradingDays ?? 0) + 1,
      });
    }
  }

  return results;
};

const loadExistingMarketSignals = async (
  prisma: any,
  input: { readonly traceId: string; readonly clusterKey: string; readonly asOf: Date; readonly symbols: readonly string[] },
): Promise<Map<string, IMarketSignalScore>> => {
  const results = new Map<string, IMarketSignalScore>();
  if (!hasDelegate(prisma, 'marketSignalSnapshot', 'findMany') || input.symbols.length === 0) {
    return results;
  }
  const rows = await prisma.marketSignalSnapshot.findMany({
    where: {
      traceId: input.traceId,
      symbol: { in: [...input.symbols] },
    },
  });
  const foundSymbols = new Set(rows.map((row: any) => String(row.symbol)));
  if (foundSymbols.size < input.symbols.length) {
    const reusableRows = await prisma.marketSignalSnapshot.findMany({
      where: {
        clusterKey: input.clusterKey,
        asOf: input.asOf,
        symbol: { in: input.symbols.filter(symbol => !foundSymbols.has(symbol)) },
      },
      orderBy: { createdAt: 'desc' },
    });
    const seenReusable = new Set<string>();
    for (const row of reusableRows) {
      const symbol = String(row.symbol);
      if (seenReusable.has(symbol)) {
        continue;
      }
      rows.push({
        ...row,
        traceId: input.traceId,
      });
      seenReusable.add(symbol);
    }
  }
  const freshnessBySymbol = await loadMarketSignalFreshnessBySymbol(prisma, {
    clusterKey: input.clusterKey,
    asOf: input.asOf,
    snapshots: rows.map((row: any) => ({
      symbol: String(row.symbol),
      latestTradingDay: row.latestTradingDay ?? null,
    })),
  });
  for (const row of rows) {
    const symbol = String(row.symbol);
    const latestTradingDay = row.latestTradingDay ?? null;
    const rowReasons = Array.isArray(row.reasons) ? row.reasons.map(String) : ['市场确认信号：复用 MarketSignalSnapshot'];
    const longTermMomentumPct = parseLongTermMomentumFromReasons(rowReasons);
    if (longTermMomentumPct === null) {
      continue;
    }
    const freshness = freshnessBySymbol.get(symbol) ?? {
      latestMarketTradingDay: toDayKey(latestTradingDay),
      latestMarketTradingDayDate: latestTradingDay,
      staleTradingDays: 0,
    };
    if (freshness.staleTradingDays > 0) {
      continue;
    }
    results.set(symbol, withMarketSignalFreshness({
      score: normalizeDecimalNumber(row.score, 0),
      latestTradingDay: row.latestTradingDay?.toISOString?.().slice(0, 10) ?? null,
      latestTradingDayDate: row.latestTradingDay ?? null,
      momentum5dPct: row.momentum5dPct === null || row.momentum5dPct === undefined ? null : normalizeDecimalNumber(row.momentum5dPct, 0),
      momentum20dPct: row.momentum20dPct === null || row.momentum20dPct === undefined ? null : normalizeDecimalNumber(row.momentum20dPct, 0),
      longTermMomentumPct,
      volumeRatio20d: row.volumeRatio20d === null || row.volumeRatio20d === undefined ? null : normalizeDecimalNumber(row.volumeRatio20d, 0),
      breakout20d: row.breakout20d === true,
      volatilityCompression: row.volatilityCompression === true,
      recentWeekGainExceeded: row.recentWeekGainExceeded === true,
      reasons: rowReasons,
    }, freshness));
  }
  return results;
};

const loadRecentCandlesRawSql = async (
  prisma: any,
  input: {
    readonly clusterKey: string;
    readonly asOf: Date;
    readonly stockIds: readonly string[];
  },
  lookbackDays: number,
): Promise<Map<string, any[]>> => {
  const rows = await prisma.$queryRawUnsafe(
    [
      'SELECT s.id AS "stockId", c."tradingDay", c.open, c.high, c.low, c.close, c.volume',
      'FROM "Stock" s',
      'JOIN LATERAL (',
      '  SELECT "tradingDay", open, high, low, close, volume',
      '  FROM "Candle" c',
      '  WHERE c."stockId" = s.id AND c."tradingDay" <= $2',
      '  ORDER BY c."tradingDay" DESC',
      `  LIMIT ${lookbackDays}`,
      ') c ON TRUE',
      'WHERE s."clusterKey" = $1 AND s.id = ANY($3::text[])',
      'ORDER BY s.id ASC, c."tradingDay" DESC',
    ].join(' '),
    input.clusterKey,
    input.asOf,
    [...input.stockIds],
  ) as readonly any[];

  const candlesByStockId = new Map<string, any[]>();
  for (const row of rows) {
    const stockId = String(row.stockId);
    const list = candlesByStockId.get(stockId) ?? [];
    list.push(row);
    candlesByStockId.set(stockId, list);
  }
  return candlesByStockId;
};

const loadRecentCandlesPrismaFallback = async (
  prisma: any,
  input: {
    readonly stockIds: readonly string[];
    readonly asOf: Date;
  },
  lookbackDays: number,
): Promise<Map<string, any[]>> => {
  // Approximate the calendar days needed for the trading days lookback window
  const calendarDays = Math.ceil(lookbackDays * 1.6) + 15;
  const marketWindowStart = new Date(input.asOf.getTime() - calendarDays * 24 * 60 * 60 * 1000);
  
  const candles = await prisma.candle.findMany({
    where: {
      stockId: { in: [...input.stockIds] },
      tradingDay: {
        lte: input.asOf,
        gte: marketWindowStart,
      },
    },
    orderBy: [
      { stockId: 'asc' },
      { tradingDay: 'desc' },
    ],
  });

  const candlesByStockId = new Map<string, any[]>();
  for (const candle of candles) {
    const stockId = String(candle.stockId);
    const list = candlesByStockId.get(stockId) ?? [];
    if (list.length < lookbackDays) {
      list.push(candle);
      candlesByStockId.set(stockId, list);
    }
  }
  return candlesByStockId;
};

const loadRecentCandlesByStockId = async (
  prisma: any,
  input: {
    readonly clusterKey: string;
    readonly asOf: Date;
    readonly stockIds: readonly string[];
    readonly strategyConfig?: IStrategyExperimentConfig;
  },
): Promise<Map<string, any[]>> => {
  if (input.stockIds.length === 0) {
    return new Map();
  }

  const lookbackDays = Math.max(
    121,
    input.strategyConfig?.fibonacciLookbackDays ?? 60,
    input.strategyConfig?.supportResistanceLookbackDays ?? 60
  );

  if (typeof prisma?.$queryRawUnsafe === 'function') {
    return await loadRecentCandlesRawSql(prisma, input, lookbackDays);
  }

  return await loadRecentCandlesPrismaFallback(prisma, input, lookbackDays);
};

const persistMarketSignals = async (
  prisma: any,
  input: {
    readonly traceId: string;
    readonly asOf: Date;
    readonly clusterKey: string;
    readonly marketSignals: ReadonlyMap<string, IMarketSignalScore>;
  },
): Promise<void> => {
  if (input.marketSignals.size === 0) {
    return;
  }
  const rows = [...input.marketSignals.entries()].map(([symbol, signal]) => ({
    traceId: input.traceId,
    asOf: input.asOf,
    clusterKey: input.clusterKey,
    symbol,
    latestTradingDay: signal.latestTradingDayDate ?? null,
    momentum5dPct: toDecimalOrNull(signal.momentum5dPct, 6),
    momentum20dPct: toDecimalOrNull(signal.momentum20dPct, 6),
    volumeRatio20d: toDecimalOrNull(signal.volumeRatio20d, 4),
    breakout20d: signal.breakout20d,
    volatilityCompression: signal.volatilityCompression,
    recentWeekGainExceeded: signal.recentWeekGainExceeded,
    score: new Prisma.Decimal(signal.score.toFixed(4)),
    reasons: [...signal.reasons],
  }));

  if (hasDelegate(prisma, 'marketSignalSnapshot', 'upsert')) {
    await Promise.all(rows.map(row => prisma.marketSignalSnapshot.upsert({
      where: {
        traceId_symbol: {
          traceId: row.traceId,
          symbol: row.symbol,
        },
      },
      create: row,
      update: {
        asOf: row.asOf,
        clusterKey: row.clusterKey,
        latestTradingDay: row.latestTradingDay,
        momentum5dPct: row.momentum5dPct,
        momentum20dPct: row.momentum20dPct,
        volumeRatio20d: row.volumeRatio20d,
        breakout20d: row.breakout20d,
        volatilityCompression: row.volatilityCompression,
        recentWeekGainExceeded: row.recentWeekGainExceeded,
        score: row.score,
        reasons: row.reasons,
      },
    })));
    return;
  }

  if (!hasDelegate(prisma, 'marketSignalSnapshot', 'createMany')) {
    return;
  }
  await prisma.marketSignalSnapshot.createMany({
    data: rows,
    skipDuplicates: true,
  });
};

const loadMarketSignals = async (
  prisma: any,
  input: {
    readonly traceId: string;
    readonly clusterKey: string;
    readonly asOf: Date;
    readonly symbols: readonly string[];
    readonly strategyConfig?: IStrategyExperimentConfig;
  },
): Promise<Map<string, IMarketSignalScore>> => {
  const requestedSymbols = [...new Set(input.symbols)];
  const results = await loadExistingMarketSignals(prisma, {
    traceId: input.traceId,
    clusterKey: input.clusterKey,
    asOf: input.asOf,
    symbols: requestedSymbols,
  });
  const missingSymbols = requestedSymbols.filter(symbol => !results.has(symbol));
  if (missingSymbols.length === 0) {
    const enrichedResults = enrichMarketSignalsWithMovement(
      results,
      await loadMovementEvidence(prisma, {
        clusterKey: input.clusterKey,
        asOf: input.asOf,
        symbols: requestedSymbols,
      }),
    );
    await persistMarketSignals(prisma, {
      traceId: input.traceId,
      asOf: input.asOf,
      clusterKey: input.clusterKey,
      marketSignals: enrichedResults,
    });
    return enrichedResults;
  }
  if (!hasDelegate(prisma, 'stock', 'findMany') || !hasDelegate(prisma, 'candle', 'findMany')) {
    return enrichMarketSignalsWithMovement(
      results,
      await loadMovementEvidence(prisma, {
        clusterKey: input.clusterKey,
        asOf: input.asOf,
        symbols: requestedSymbols,
      }),
    );
  }

  const stocks = await prisma.stock.findMany({
    where: {
      clusterKey: input.clusterKey,
      symbol: { in: missingSymbols },
    },
    select: {
      id: true,
      symbol: true,
    },
  });
  const stockIdToSymbol = new Map<string, string>(
    stocks.map((stock: any) => [String(stock.id), String(stock.symbol)]),
  );
  const candlesByStockId = await loadRecentCandlesByStockId(prisma, {
    clusterKey: input.clusterKey,
    asOf: input.asOf,
    stockIds: [...stockIdToSymbol.keys()],
    strategyConfig: input.strategyConfig,
  });

  for (const [stockId, symbol] of stockIdToSymbol.entries()) {
    const marketSignal = calculateMarketSignalScore(candlesByStockId.get(stockId) ?? [], input.strategyConfig);
    results.set(symbol, marketSignal);
  }

  const enrichedResults = enrichMarketSignalsWithMovement(
    results,
    await loadMovementEvidence(prisma, {
      clusterKey: input.clusterKey,
      asOf: input.asOf,
      symbols: requestedSymbols,
    }),
  );

  await persistMarketSignals(prisma, {
    traceId: input.traceId,
    asOf: input.asOf,
    clusterKey: input.clusterKey,
    marketSignals: enrichedResults,
  });

  return enrichedResults;
};

const loadActiveKeywordAliases = async (
  prisma: any,
  input: { readonly clusterKey: string; readonly asOf: Date },
): Promise<readonly IActiveKeywordAlias[]> => {
  const rows = await new CoverageInitializationRepository(prisma)
    .listActiveKeywordAliases(input.clusterKey, input.asOf);
  return rows.flatMap((row) => {
    if (typeof row.sourceKeyword !== 'string' || typeof row.canonicalKeyword !== 'string') {
      return [];
    }
    return [{
      sourceKeyword: row.sourceKeyword,
      canonicalKeyword: row.canonicalKeyword,
      relationType: typeof row.relationType === 'string' ? row.relationType : 'keyword_alias',
      confidence: normalizeDecimalNumber(row.confidence, 0.7),
      source: typeof row.source === 'string' ? row.source : 'unknown',
      sourceId: typeof row.sourceId === 'string' ? row.sourceId : 'unknown',
    } satisfies IActiveKeywordAlias];
  });
};

const loadActiveKeywordPerformancePenalties = async (
  prisma: any,
  input: { readonly clusterKey: string; readonly asOf: Date },
): Promise<ReadonlyMap<string, IActiveKeywordPerformancePenalty>> => {
  if (!hasDelegate(prisma, 'keywordPerformancePenalty', 'findMany')) {
    return new Map();
  }

  const rows = await prisma.keywordPerformancePenalty.findMany({
    where: {
      clusterKey: input.clusterKey,
      validFrom: { lte: input.asOf },
      validTo: { gte: input.asOf },
    },
  });

  const penalties = new Map<string, IActiveKeywordPerformancePenalty>();
  for (const row of rows) {
    const normalized = normalizeKeyword(row.keyword);
    const factor = clamp(normalizeDecimalNumber(row.factor, 1), 0, 1);
    if (!normalized || factor >= 1) {
      continue;
    }
    const current = penalties.get(normalized);
    if (current && current.factor <= factor) {
      continue;
    }
    penalties.set(normalized, {
      keyword: String(row.keyword),
      factor,
      lossPct: normalizeDecimalNumber(row.lossPct, 0),
      triggerSymbol: String(row.triggerSymbol ?? 'unknown'),
      validTo: row.validTo instanceof Date ? row.validTo : (row.validTo ? new Date(String(row.validTo)) : null),
      reason: String(row.reason ?? '关键词历史表现降权'),
    });
  }
  return penalties;
};

const resolveKeywordPerformancePenalty = (
  match: IExposureKeywordMatch,
  penalties: ReadonlyMap<string, IActiveKeywordPerformancePenalty>,
): { readonly factor: number; readonly reasons: readonly string[] } => {
  const matchedPenalties = [...new Set([
    normalizeKeyword(match.sourceKeyword),
    normalizeKeyword(match.exposureKeyword),
  ])]
    .flatMap((keyword) => {
      const penalty = penalties.get(keyword);
      return penalty ? [penalty] : [];
    })
    .sort((left, right) => left.factor - right.factor);

  const strongestPenalty = matchedPenalties[0];
  if (!strongestPenalty) {
    return { factor: 1, reasons: [] };
  }

  const validTo = strongestPenalty.validTo?.toISOString() ?? 'unknown';
  return {
    factor: strongestPenalty.factor,
    reasons: [
      `关键词表现惩罚 ${strongestPenalty.factor.toFixed(4)}，命中关键词 [${strongestPenalty.keyword}]，触发股票 ${strongestPenalty.triggerSymbol}，亏损 ${(strongestPenalty.lossPct * 100).toFixed(2)}%，有效至 ${validTo}`,
      `关键词表现惩罚原因：${strongestPenalty.reason}`,
    ],
  };
};

const buildExposureReasons = (
  match: IExposureKeywordMatch,
  signal: any,
  exposure: any,
  breadthWeight: number,
  causalScore: number,
  reprintWeight: number,
  decayFactor: number,
  profile: string,
  halfLifeDays: number,
  t: number,
  keywordPerformancePenaltyReasons: readonly string[],
): readonly string[] => [
  `因果关键词 [${match.sourceKeyword}] 来源于结构化候选`,
  `匹配暴露词 [${match.exposureKeyword}]，匹配方法 ${match.method}，匹配置信度 ${match.confidence.toFixed(4)}，${match.reason}`,
  `经营变量 [${signal.businessVariable}]，方向 ${signal.direction}`,
  `股票暴露事实 [${exposure.sourceName}] (${exposure.taxonomyLevel ?? exposure.exposureType})`,
  `暴露来源 ${exposure.source}:${exposure.sourceId}`,
  `行业/主题成员数 ${exposure.memberCount ?? '未知'}，宽度惩罚系数 ${breadthWeight.toFixed(4)}`,
  `因果候选置信度 ${normalizeDecimalNumber(signal.confidence, 0).toFixed(4)}，暴露置信度 ${normalizeDecimalNumber(exposure.confidence, 1).toFixed(4)}`,
  `转载权重 ${reprintWeight.toFixed(2)}`,
  `时效衰减因子 ${decayFactor.toFixed(4)} (距发布已过去 ${t.toFixed(2)} 天; 衰减Profile: ${profile}, 半衰期: ${halfLifeDays}天)`,
  ...keywordPerformancePenaltyReasons,
  `结构化因果净分数贡献 ${causalScore.toFixed(4)} (封顶上限 1.0)`,
];

const createExposureContributions = async (
  prisma: any,
  newsRecords: readonly any[],
  input: {
    readonly traceId: string;
    readonly asOf: Date;
    readonly clusterKey: string;
    readonly lambda: number;
    readonly maxWindowDays: number;
    readonly profile: string;
    readonly halfLifeDays: number;
    readonly activeAliases: readonly IActiveKeywordAlias[];
    readonly activeKeywordPerformancePenalties: ReadonlyMap<string, IActiveKeywordPerformancePenalty>;
  },
): Promise<readonly any[]> => {
  if (!hasDelegate(prisma, 'causalSignalCandidate', 'findMany') || !hasDelegate(prisma, 'stockExposureFact', 'findMany')) {
    return [];
  }

  const causalSignals = await prisma.causalSignalCandidate.findMany({
    where: {
      traceId: input.traceId,
      clusterKey: input.clusterKey,
      asOf: { lte: input.asOf },
      status: 'candidate',
    },
  });
  if (causalSignals.length === 0) {
    return [];
  }

  const positiveSignals = causalSignals.filter((signal: any) => normalizeDirectionWeight(signal.direction) > 0);
  if (positiveSignals.length === 0) {
    return [];
  }

  const newsById = new Map(newsRecords.map(news => [news.id, news]));
  const exposureFacts = (await prisma.stockExposureFact.findMany({
    where: {
      clusterKey: input.clusterKey,
      status: 'active',
      validFrom: { lte: input.asOf },
      OR: [
        { validTo: null },
        { validTo: { gte: input.asOf } },
      ],
    },
  })).filter(isScoringExposureFact);
  if (exposureFacts.length === 0) {
    return [];
  }

  const exposuresByKeyword = new Map<string, any[]>();
  for (const exposure of exposureFacts) {
    const list = exposuresByKeyword.get(exposure.keyword) ?? [];
    list.push(exposure);
    exposuresByKeyword.set(exposure.keyword, list);
  }
  const exposureKeywordIndex = buildExposureKeywordIndex([...exposuresByKeyword.keys()]);
  const bestExposureByKeyword = getBestExposureByKeyword(exposureFacts);
  const stockNames = new Set<string>(
    exposureFacts
      .map((exposure: any) => String(exposure.stockName ?? '').trim())
      .filter((value: string) => value.length >= DIRECT_STOCK_NAME_MATCH_MIN_LENGTH),
  );

  const contributions: any[] = [];
  const seen = new Set<string>();
  for (const signal of positiveSignals) {
    const news = newsById.get(signal.newsId);
    if (!news) {
      continue;
    }

    const matches = buildExposureKeywordMatches(signal, exposureKeywordIndex, stockNames, input.activeAliases);
    if (matches.length === 0) {
      continue;
    }

    const { decayFactor, t } = calculateTimeDecay(news.publishedAt, input.asOf, input.lambda, input.maxWindowDays);
    if (decayFactor === 0) {
      continue;
    }

    const reprintWeight = normalizeDecimalNumber(news.reprintWeight, 1);
    const directionWeight = normalizeDirectionWeight(signal.direction);
    const signalConfidence = normalizeDecimalNumber(signal.confidence, 0);

    for (const match of matches) {
      const exposures = exposuresByKeyword.get(match.exposureKeyword) ?? [];
      for (const exposure of exposures) {
        const dedupeKey = `${signal.newsId}:${exposure.symbol}:${match.exposureKeyword}`;
        if (seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);

        const exposureConfidence = normalizeDecimalNumber(exposure.confidence, 1);
        const breadthWeight = calculateExposureBreadthWeight(exposure.memberCount);
        const exposurePrecisionScore = calculateExposurePrecisionScore(exposure, breadthWeight);
        const baseFrequencyScore = Math.min(1, directionWeight * signalConfidence * exposureConfidence * match.confidence);
        const timeDecayedScore = baseFrequencyScore * decayFactor;
        const reprintPenaltyScore = timeDecayedScore * reprintWeight;
        const keywordPerformancePenalty = resolveKeywordPerformancePenalty(match, input.activeKeywordPerformancePenalties);
        const finalContribScore = Math.min(reprintPenaltyScore * breadthWeight * keywordPerformancePenalty.factor, 1.0);
        if (finalContribScore <= 0) {
          continue;
        }

        contributions.push({
          traceId: input.traceId,
          newsId: signal.newsId,
          symbol: exposure.symbol,
          keyword: match.exposureKeyword,
          sourceKeyword: match.sourceKeyword,
          matchedExposureKeyword: match.exposureKeyword,
          exposureFactId: typeof exposure.id === 'string' ? exposure.id : null,
          matchMethod: match.method,
          matchConfidence: new Prisma.Decimal(match.confidence),
          baseFrequencyScore: new Prisma.Decimal(baseFrequencyScore),
          timeDecayedScore: new Prisma.Decimal(timeDecayedScore),
          reprintPenaltyScore: new Prisma.Decimal(reprintPenaltyScore),
          finalContribScore: new Prisma.Decimal(finalContribScore),
          reasons: buildExposureReasons(
            match,
            signal,
            exposure,
            breadthWeight,
            finalContribScore,
            reprintWeight,
            decayFactor,
            input.profile,
            input.halfLifeDays,
            t,
            keywordPerformancePenalty.reasons,
          ),
          asOf: input.asOf,
          clusterKey: input.clusterKey,
          __exposurePrecisionScore: exposurePrecisionScore,
          __exposureFactId: typeof exposure.id === 'string' ? exposure.id : null,
          __exposureType: String(exposure.exposureType ?? 'unknown'),
          __taxonomyLevel: typeof exposure.taxonomyLevel === 'string' ? exposure.taxonomyLevel : null,
        });
      }
    }
  }

  return contributions.sort((left, right) => {
    const leftBest = bestExposureByKeyword.get(left.keyword);
    const rightBest = bestExposureByKeyword.get(right.keyword);
    return exposureSpecificityScore(rightBest) - exposureSpecificityScore(leftBest)
      || Number(right.finalContribScore) - Number(left.finalContribScore)
      || String(left.symbol).localeCompare(String(right.symbol));
  });
};

const deduplicateContributions = (contributions: readonly any[]): readonly any[] => {
  const byKey = new Map<string, any>();
  for (const contribution of contributions) {
    const key = `${contribution.traceId}:${contribution.newsId}:${contribution.symbol}:${contribution.keyword}`;
    const existing = byKey.get(key);
    if (!existing || Number(contribution.finalContribScore) > Number(existing.finalContribScore)) {
      byKey.set(key, contribution);
    }
  }
  return [...byKey.values()];
};

export class ScoringContributionEngine {
  /**
   * 执行完整的防垄断评分并将明细和特征快照持久化到物理表
   */
  public async execute(prisma: any, input: IScoringEngineInput): Promise<IScoringEngineOutput> {
    const { traceId, asOf, clusterKey } = input;
    const timings: Record<string, number> = {};
    const startedAt = Date.now();

    // 1. 解析动态评分配置 profile 参数
    let profile = input.scoringProfile ?? 'short_news';
    let halfLifeDays = input.halfLifeDays;
    let maxWindowDays = input.maxWindowDays;

    if (!halfLifeDays || !maxWindowDays) {
      switch (profile) {
        case 'industry_cycle':
          halfLifeDays = halfLifeDays ?? 10;
          maxWindowDays = maxWindowDays ?? 30;
          break;
        case 'fundamental_theme':
          halfLifeDays = halfLifeDays ?? 30;
          maxWindowDays = maxWindowDays ?? 90;
          break;
        case 'short_news':
        default:
          profile = 'short_news';
          halfLifeDays = halfLifeDays ?? 2;
          maxWindowDays = maxWindowDays ?? 7;
          break;
      }
    }
    const lambda = Math.log(2) / halfLifeDays;
    const windowStart = new Date(asOf.getTime() - maxWindowDays * 24 * 60 * 60 * 1000);
    const factSnapshot = await new FactSnapshotService().ensure(prisma, {
      traceId,
      clusterKey,
      asOf,
    });
    const activeAliases = await loadActiveKeywordAliases(prisma, { clusterKey, asOf });
    const activeKeywordPerformancePenalties = await loadActiveKeywordPerformancePenalties(prisma, { clusterKey, asOf });

    // 2. 读取截止 asOf 时刻指定时间窗口内的 Normalized 事实层新闻 (严格按 clusterKey 隔离)
    const newsRecords = await prisma.normalizedNewsRecord.findMany({
      where: {
        clusterKey,
        publishedAt: {
          lte: asOf,
          gte: windowStart,
        },
      },
    });
    timings.loadNewsMs = Date.now() - startedAt;

    if (newsRecords.length === 0) {
      return {
        traceId,
        asOf,
        clusterKey,
        contributionCount: 0,
        snapshotCount: 0,
        profileUsed: profile,
        halfLifeDaysUsed: halfLifeDays,
        maxWindowDaysUsed: maxWindowDays,
        metrics: {
          newsRecords: 0,
          activeAliases: activeAliases.length,
          activeKeywordPerformancePenalties: activeKeywordPerformancePenalties.size,
          factSnapshot,
          timings,
        },
      };
    }

    const contributionStartedAt = Date.now();
    const exposureContribs = await createExposureContributions(prisma, newsRecords, {
      traceId,
      asOf,
      clusterKey,
      lambda,
      maxWindowDays,
      profile,
      halfLifeDays,
      activeAliases,
      activeKeywordPerformancePenalties,
    });
    timings.createExposureContributionsMs = Date.now() - contributionStartedAt;

    if (exposureContribs.length === 0) {
      return {
        traceId,
        asOf,
        clusterKey,
        contributionCount: 0,
        snapshotCount: 0,
        profileUsed: profile,
        halfLifeDaysUsed: halfLifeDays,
        maxWindowDaysUsed: maxWindowDays,
        metrics: {
          newsRecords: newsRecords.length,
          exposureContributions: 0,
          activeAliases: activeAliases.length,
          activeKeywordPerformancePenalties: activeKeywordPerformancePenalties.size,
          factSnapshot,
          timings,
        },
      };
    }

    const graphStartedAt = Date.now();
    const graphSignal = await loadGraphSignal(prisma, traceId, clusterKey);
    timings.loadGraphMs = Date.now() - graphStartedAt;
    const graphNodesByKeyword = new Map(graphSignal.nodes.map(node => [node.keyword, node]));
    const rawContribs: any[] = [...exposureContribs];

    const contribs = deduplicateContributions(rawContribs);

    // 6. 批量写入 EvidenceContribution 表（Append-Only）
    const persistContributionStartedAt = Date.now();
    await persistEvidenceContributions(prisma, contribs);
    timings.persistEvidenceContributionsMs = Date.now() - persistContributionStartedAt;

    const persistExposureMatchCacheStartedAt = Date.now();
    const exposureMatchCacheRows = await persistExposureMatchCache(prisma, {
      contributions: contribs,
      clusterKey,
      asOf,
    });
    timings.persistExposureMatchCacheMs = Date.now() - persistExposureMatchCacheStartedAt;

    // 7. 进行特征归并：汇总 symbol 得分并生成 StockFeatureSnapshot
    const contribsBySymbol = new Map<string, typeof rawContribs>();
    for (const contrib of contribs) {
      const list = contribsBySymbol.get(contrib.symbol) ?? [];
      list.push(contrib);
      contribsBySymbol.set(contrib.symbol, list);
    }

    const featureSnapshots: any[] = [];

    const marketSignalStartedAt = Date.now();
    const marketSignals = await loadMarketSignals(prisma, {
      traceId,
      clusterKey,
      asOf,
      symbols: [...contribsBySymbol.keys()],
      strategyConfig: input.strategyConfig,
    });
    timings.loadMarketSignalsMs = Date.now() - marketSignalStartedAt;

    for (const [symbol, symbolContribs] of contribsBySymbol.entries()) {
      const contribsByKeyword = new Map<string, number>();
      const reasons: string[] = [];
      const exposurePrecisionScores: number[] = [];
      const exposureFactIds = new Set<string>();
      const exposureTypes = new Set<string>();
      const taxonomyLevels = new Set<string>();

      for (const contrib of symbolContribs) {
        const keyword = readContributionKeyword(contrib);
        const currentScore = contribsByKeyword.get(keyword) ?? 0;
        contribsByKeyword.set(keyword, currentScore + Number(contrib.finalContribScore));
        const metadata = extractInternalMetadata(contrib);
        exposurePrecisionScores.push(metadata.exposurePrecisionScore);
        if (metadata.exposureFactId) {
          exposureFactIds.add(metadata.exposureFactId);
        }
        exposureTypes.add(metadata.exposureType);
        if (metadata.taxonomyLevel) {
          taxonomyLevels.add(metadata.taxonomyLevel);
        }
      }

      const newsFrequencyScore = calculateEvidenceComponentScore(contribsByKeyword);
      for (const [keyword, sumFinalContrib] of contribsByKeyword.entries()) {
        const capReason = sumFinalContrib > EVIDENCE_KEYWORD_CONTRIB_CAP
          ? `，单关键词有效贡献按 ${EVIDENCE_KEYWORD_CONTRIB_CAP.toFixed(1)} 封顶`
          : '';
        reasons.push(
          `关键词 [${keyword}] 累计净贡献值 ${sumFinalContrib.toFixed(4)}${capReason}，证据贡献组件累计后映射为 ${newsFrequencyScore.toFixed(4)}/${EVIDENCE_SCORE_MAX} (基于 ${profile} 衰减)`,
        );
      }

      const symbolKeywords = new Set<string>();
      for (const contrib of symbolContribs) {
        symbolKeywords.add(readContributionKeyword(contrib));
        if (typeof contrib.sourceKeyword === 'string' && contrib.sourceKeyword.trim().length > 0) {
          symbolKeywords.add(contrib.sourceKeyword);
        }
      }
      const boardMatchScore = exposurePrecisionScores.length > 0
        ? Number(Math.max(...exposurePrecisionScores).toFixed(4))
        : 0;
      reasons.push(`股票暴露来自 StockExposureFact，暴露精确度组件 ${boardMatchScore.toFixed(4)}/15，exposureFactId=${[...exposureFactIds].join(',') || 'unknown'}，taxonomy=${[...taxonomyLevels].join(',') || [...exposureTypes].join(',') || 'unknown'}`);

      let rawRelationConfidenceScore = 0;
      let rawWeakSignalBonus = 0;
      const graphReasonSet = new Set<string>();
      for (const keyword of symbolKeywords) {
        const node = graphNodesByKeyword.get(keyword);
        if (node?.weakSignal) {
          rawWeakSignalBonus += GRAPH_WEAK_NODE_BONUS;
          graphReasonSet.add(`图谱弱信号 [${keyword}] 节点升温，弱信号加分 ${GRAPH_WEAK_NODE_BONUS.toFixed(2)}`);
        }
      }

      for (const edge of graphSignal.edges) {
        const sourceMatched = symbolKeywords.has(edge.sourceKeyword);
        const targetMatched = symbolKeywords.has(edge.targetKeyword);
        if (!sourceMatched && !targetMatched) {
          continue;
        }

        rawRelationConfidenceScore += edge.confidence;
        graphReasonSet.add(
          `图谱关系 [${edge.sourceKeyword} -> ${edge.targetKeyword}] 置信度 ${edge.confidence.toFixed(2)}${edge.weakSignal ? '，标记弱信号' : ''}`,
        );

        if (edge.weakSignal) {
          rawWeakSignalBonus += GRAPH_WEAK_EDGE_BONUS;
          const matchedKeyword = sourceMatched ? edge.sourceKeyword : edge.targetKeyword;
          graphReasonSet.add(`图谱弱信号 [${matchedKeyword}] 来自关系链路，弱信号加分 ${GRAPH_WEAK_EDGE_BONUS.toFixed(2)}`);
        }
      }

      const graphScores = calculateGraphComponentScores(rawRelationConfidenceScore, rawWeakSignalBonus);
      const relationConfidenceScore = graphScores.relationScore;
      const weakSignalBonus = graphScores.weakSignalScore;

      if (relationConfidenceScore > 0) {
        reasons.push(...graphReasonSet);
        if (rawRelationConfidenceScore > GRAPH_RELATION_CONFIDENCE_CAP) {
          reasons.push(`图谱关系置信度封顶 ${GRAPH_RELATION_CONFIDENCE_CAP.toFixed(2)}，原始关系置信度累计 ${rawRelationConfidenceScore.toFixed(2)}`);
        }
      }

      if (weakSignalBonus > 0 && rawWeakSignalBonus > GRAPH_WEAK_SIGNAL_CAP) {
        reasons.push(`图谱弱信号封顶 ${GRAPH_WEAK_SIGNAL_CAP.toFixed(2)}，原始弱信号累计 ${rawWeakSignalBonus.toFixed(2)}`);
      }

      const marketSignal = marketSignals.get(symbol) ?? {
        score: 0,
        latestTradingDay: null,
        momentum5dPct: null,
        momentum20dPct: null,
        longTermMomentumPct: null,
        volumeRatio20d: null,
        breakout20d: false,
        volatilityCompression: false,
        recentWeekGainExceeded: false,
        todayChangePct: null,
        reasons: ['市场确认信号：未找到 asOf 前可见 Candle，记 0 分'],
      } satisfies IMarketSignalScore;
      reasons.push(...marketSignal.reasons);

      // 汇总为 0-100 总分：证据 45 + 图谱 20 + 暴露精确度 15 + 市场确认 20
      const aggregatedScore = Number(clamp(
        newsFrequencyScore + graphScores.total + boardMatchScore + marketSignal.score,
        0,
        100,
      ).toFixed(4));

      featureSnapshots.push({
        traceId,
        symbol,
        asOf,
        clusterKey,
        newsFrequencyScore: new Prisma.Decimal(newsFrequencyScore),
        relationConfidenceScore: new Prisma.Decimal(relationConfidenceScore),
        boardMatchScore: new Prisma.Decimal(boardMatchScore),
        weakSignalBonus: new Prisma.Decimal(weakSignalBonus),
        aggregatedScore: new Prisma.Decimal(aggregatedScore),
        reasons: [
          `评分组件：证据 ${newsFrequencyScore.toFixed(4)}/${EVIDENCE_SCORE_MAX}，图谱 ${graphScores.total.toFixed(4)}/${GRAPH_SCORE_MAX}，暴露 ${boardMatchScore.toFixed(4)}/${EXPOSURE_PRECISION_SCORE_MAX}，市场 ${marketSignal.score.toFixed(4)}/${MARKET_SIGNAL_SCORE_MAX}，总分 ${aggregatedScore.toFixed(4)}/100`,
          ...reasons,
          `marketSignal=${JSON.stringify({
            score: marketSignal.score,
            latestTradingDay: marketSignal.latestTradingDay,
            latestMarketTradingDay: marketSignal.latestMarketTradingDay ?? marketSignal.latestTradingDay,
            staleTradingDays: marketSignal.staleTradingDays ?? 0,
            isFresh: marketSignal.isFresh ?? true,
            momentum5dPct: marketSignal.momentum5dPct,
            momentum20dPct: marketSignal.momentum20dPct,
            longTermMomentumPct: marketSignal.longTermMomentumPct,
            volumeRatio20d: marketSignal.volumeRatio20d,
            breakout20d: marketSignal.breakout20d,
            volatilityCompression: marketSignal.volatilityCompression,
            recentWeekGainExceeded: marketSignal.recentWeekGainExceeded,
          })}`,
        ],
      });
    }

    const persistFeatureStartedAt = Date.now();
    if (featureSnapshots.length > 0) {
      await prisma.stockFeatureSnapshot.createMany({
        data: featureSnapshots,
        skipDuplicates: true,
      });
    }
    timings.persistFeatureSnapshotsMs = Date.now() - persistFeatureStartedAt;
    timings.totalMs = Date.now() - startedAt;

    return {
      traceId,
      asOf,
      clusterKey,
      contributionCount: contribs.length,
      snapshotCount: featureSnapshots.length,
      profileUsed: profile,
      halfLifeDaysUsed: halfLifeDays,
      maxWindowDaysUsed: maxWindowDays,
      metrics: {
        newsRecords: newsRecords.length,
        exposureContributions: exposureContribs.length,
        deduplicatedContributions: contribs.length,
        symbolsScored: contribsBySymbol.size,
        marketSignals: marketSignals.size,
        featureSnapshots: featureSnapshots.length,
        exposureMatchCacheRows,
        activeAliases: activeAliases.length,
        activeKeywordPerformancePenalties: activeKeywordPerformancePenalties.size,
        factSnapshot,
        timings,
      },
    };
  }
}
