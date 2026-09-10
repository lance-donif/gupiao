/**
 * 评分通用纯函数（无副作用、不依赖类实例状态、不查数据库）。
 * 由 scoring-contribution-engine.ts 原样搬迁而来，函数体逐字符不变。
 */

import { clamp } from '../../lib/number-utils.js';
import { normalizeKeyword, longestCommonSubstringLength } from '../scoring-utils.js';
import {
  aggregateEventEvidence,
  type EvidenceDirection,
  type EventEvidenceItem,
  type EventEvidenceSummary,
} from '../event-scoring/event-evidence.js';
import { DIRECT_STOCK_NAME_MATCH_MIN_LENGTH } from './constants.js';

export interface IExposureKeywordMatch {
  readonly sourceKeyword: string;
  readonly exposureKeyword: string;
  readonly method: string;
  readonly confidence: number;
  readonly reason: string;
}

export interface IActiveKeywordAlias {
  readonly sourceKeyword: string;
  readonly canonicalKeyword: string;
  readonly relationType: string;
  readonly confidence: number;
  readonly source: string;
  readonly sourceId: string;
}

export interface IExposureKeywordEntry {
  readonly keyword: string;
  readonly norm: string;
}

export interface IExposureKeywordIndex {
  readonly entries: readonly IExposureKeywordEntry[];
  readonly exactByNorm: ReadonlyMap<string, readonly IExposureKeywordEntry[]>;
  readonly twoGramByNorm: ReadonlyMap<string, readonly IExposureKeywordEntry[]>;
  readonly threeGramByNorm: ReadonlyMap<string, readonly IExposureKeywordEntry[]>;
}

/** event-v2 证据聚合：同一关键词只取最强的 top-K 独立事件，K 固定为 3。 */
export const EVENT_EVIDENCE_TOP_K = 3;

/** event-v2 证据特征：按关键词聚合后的 E=E+−E−（截断到 0 以上）。 */
export interface IEventEvidenceFeatures {
  readonly summaries: readonly EventEvidenceSummary[];
  /** 关键词 -> E，只包含 E>0 的关键词，直接喂给证据贡献组件曲线。 */
  readonly keywordScores: ReadonlyMap<string, number>;
  /** 全部关键词 E 的合计，用于「零正向证据不可评分」门槛。 */
  readonly aggregatedEvidence: number;
  readonly itemCount: number;
  readonly topK: number;
}

export const hasDelegate = (prisma: any, delegateName: string, methodName: string): boolean => {
  return typeof prisma?.[delegateName]?.[methodName] === 'function';
};

export const addExposureKeywordEntry = (
  map: Map<string, IExposureKeywordEntry[]>,
  key: string,
  entry: IExposureKeywordEntry,
): void => {
  const list = map.get(key) ?? [];
  list.push(entry);
  map.set(key, list);
};

export const extractUniqueGrams = (value: string, size: number): readonly string[] => {
  if (value.length < size) {
    return [];
  }
  const grams = new Set<string>();
  for (let index = 0; index <= value.length - size; index += 1) {
    grams.add(value.slice(index, index + size));
  }
  return [...grams];
};

export const buildExposureKeywordIndex = (exposureKeywords: readonly string[]): IExposureKeywordIndex => {
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

export const addCandidateEntries = (
  candidates: Map<string, IExposureKeywordEntry>,
  entries: readonly IExposureKeywordEntry[] | undefined,
): void => {
  for (const entry of entries ?? []) {
    candidates.set(entry.keyword, entry);
  }
};

export const getRarestGramCandidates = (
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

export const getExposureEntriesContainingNorm = (
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

export const getExposureEntriesContainedByNorm = (
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

export const getFuzzyOverlapCandidates = (
  exposureKeywordIndex: IExposureKeywordIndex,
  sourceNorm: string,
): readonly IExposureKeywordEntry[] => {
  const candidates = new Map<string, IExposureKeywordEntry>();
  for (const gram of extractUniqueGrams(sourceNorm, 3)) {
    addCandidateEntries(candidates, exposureKeywordIndex.threeGramByNorm.get(gram));
  }
  return [...candidates.values()];
};

export const buildExposureKeywordMatches = (
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

const KNOWN_EVIDENCE_DIRECTIONS = new Set<EvidenceDirection>([
  'positive',
  'negative',
  'mixed',
  'neutral',
]);

/** 贡献行使用的暴露关键词（与引擎 `readContributionKeyword` 保持同一口径）。 */
export const contributionExposureKeyword = (contribution: any): string =>
  String(contribution?.matchedExposureKeyword ?? contribution?.keyword ?? '').trim();

/**
 * 贡献行的确定性证据 ID。
 *
 * 由 traceId/newsId/symbol/曝光关键词/暴露事实/匹配方式拼成，不依赖输入顺序；
 * 同事件去重与并列时的 tie-break 都以它为唯一依据。
 */
export const contributionEvidenceId = (contribution: any): string => [
  String(contribution?.traceId ?? ''),
  String(contribution?.newsId ?? ''),
  String(contribution?.symbol ?? ''),
  contributionExposureKeyword(contribution),
  String(contribution?.exposureFactId ?? '-'),
  String(contribution?.matchMethod ?? '-'),
].join('|');

/**
 * 解析贡献行的极性。
 *
 * event-v2 下引擎会把 `CausalSignalCandidate.direction` 以 `__direction` 透传到贡献行；
 * 缺少该字段时，能落到暴露事实上的贡献行按正向处理（旧数据兼容），其余视为中性。
 */
export const resolveEvidenceDirection = (contribution: any): EvidenceDirection => {
  const raw = contribution?.__direction;
  if (typeof raw === 'string' && KNOWN_EVIDENCE_DIRECTIONS.has(raw as EvidenceDirection)) {
    return raw as EvidenceDirection;
  }
  const hasExposurePath = Boolean(contribution?.exposureFactId)
    || Boolean(contribution?.matchedExposureKeyword)
    || Boolean(contribution?.keyword);
  return hasExposurePath ? 'positive' : 'neutral';
};

/**
 * 贡献行 -> 事件证据项（纯函数）。
 *
 * 无有效正向暴露证据或非正有效贡献的行返回 null，不进入聚合（不做任何补位/降级）。
 */
export const toEventEvidenceItem = (contribution: any): EventEvidenceItem | null => {
  const canonicalKeyword = contributionExposureKeyword(contribution);
  const effectiveContribution = Number(contribution?.finalContribScore);
  if (!canonicalKeyword || !Number.isFinite(effectiveContribution) || effectiveContribution <= 0) {
    return null;
  }

  const direction = resolveEvidenceDirection(contribution);
  if (direction === 'neutral') {
    return null;
  }

  return {
    evidenceId: contributionEvidenceId(contribution),
    event: String(contribution?.__signalEvent ?? '').trim(),
    canonicalKeyword,
    businessVariable: String(contribution?.__businessVariable ?? '').trim(),
    direction,
    effectiveContribution,
    hasPositiveExposureEvidence: direction === 'positive' || direction === 'mixed',
  };
};

/**
 * event-v2 证据特征构建（纯函数，无副作用、不查库）。
 *
 * 规则：同（关键词/经营变量/极性/事件）取最大有效贡献并按键内证据 ID 破平；每个关键词按
 * 正负分开聚合 top-K 独立事件 E+=1-∏(1-q)、E−=1-∏(1-q)；E=max(0,E+−E−)。
 */
export const buildEventEvidenceFeatures = (
  contributions: readonly any[],
  topK: number = EVENT_EVIDENCE_TOP_K,
): IEventEvidenceFeatures => {
  const items: EventEvidenceItem[] = [];
  for (const contribution of contributions) {
    const item = toEventEvidenceItem(contribution);
    if (item) {
      items.push(item);
    }
  }

  const summaries = aggregateEventEvidence(items, topK);
  const keywordScores = new Map<string, number>();
  let aggregatedEvidence = 0;
  for (const summary of summaries) {
    if (summary.E > 0) {
      keywordScores.set(summary.keyword, summary.E);
    }
    aggregatedEvidence += summary.E;
  }

  return {
    summaries,
    keywordScores,
    aggregatedEvidence: Number(aggregatedEvidence.toFixed(6)),
    itemCount: items.length,
    topK,
  };
};
