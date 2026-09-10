/**
 * 评分通用纯函数（无副作用、不依赖类实例状态、不查数据库）。
 * 由 scoring-contribution-engine.ts 原样搬迁而来，函数体逐字符不变。
 */

import { clamp } from '../../lib/number-utils.js';
import { normalizeKeyword, longestCommonSubstringLength } from '../scoring-utils.js';
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
