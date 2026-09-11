/**
 * 亲友网络实体抽取：纯算法 + 注入词典（IKeywordDictionarySnapshot）。
 * 词表唯一来源是 DB KeywordDictionary，本文件不再保留任何硬编码词。
 */
import type { IKeywordDictionarySnapshot } from './keyword-dictionary.js';

export interface IFriendNetworkEntityExtractionInput {
  readonly title: string;
  readonly summary: string;
}

const normalizeText = (text: string): string => {
  return text.replace(/[\s，。；：、“”‘’（）()【】《》,.;:!?]/g, '');
};

const isHighSignalPhrase = (phrase: string, dict: IKeywordDictionarySnapshot): boolean => {
  if (phrase.length < 2 || phrase.length > 12) {
    return false;
  }

  if (dict.stopwords.has(phrase)) {
    return false;
  }

  return dict.highSignalTerms.some(suffix => phrase.endsWith(suffix) || phrase.includes(suffix));
};

const collectCanonicalEntities = (
  text: string,
  target: Set<string>,
  dict: IKeywordDictionarySnapshot,
): void => {
  for (const group of dict.canonicalGroups) {
    if (group.patterns.some(pattern => text.includes(pattern))) {
      target.add(group.canonical);
    }
  }
};

const collectDynamicCandidates = (
  text: string,
  target: Set<string>,
  dict: IKeywordDictionarySnapshot,
): void => {
  const candidates = text.match(/[\u4E00-\u9FA5]{2,12}/g) ?? [];

  for (const candidate of candidates) {
    if (isHighSignalPhrase(candidate, dict)) {
      target.add(candidate);
    }
  }
};

const deduplicateEntities = (
  entities: readonly string[],
  dict: IKeywordDictionarySnapshot,
): string[] => {
  const canonicalTerms = new Set<string>(dict.highSignalTerms);
  const sorted = [...new Set(entities)].sort((left, right) => {
    const leftPriority = canonicalTerms.has(left) ? 1 : 0;
    const rightPriority = canonicalTerms.has(right) ? 1 : 0;
    if (leftPriority !== rightPriority) {
      return rightPriority - leftPriority;
    }
    return right.length - left.length;
  });
  const result: string[] = [];

  for (const entity of sorted) {
    if (result.some(existing => existing.includes(entity) || entity.includes(existing))) {
      if (!result.includes(entity) && !result.includes(entity)) {
        continue;
      }
    }

    if (!result.includes(entity)) {
      result.push(entity);
    }
  }

  return result.slice(0, 6);
};

const expandCanonicalEntities = (
  text: string,
  target: Set<string>,
  dict: IKeywordDictionarySnapshot,
): void => {
  for (const term of dict.highSignalTerms) {
    if (text.includes(term)) {
      target.add(term);
    }
  }
};

export const extractSignalEntities = (
  inputs: readonly IFriendNetworkEntityExtractionInput[],
  dict: IKeywordDictionarySnapshot,
): string[] => {
  const entities = new Set<string>();

  for (const input of inputs) {
    const title = normalizeText(input.title);
    const summary = normalizeText(input.summary);
    collectCanonicalEntities(title, entities, dict);
    collectCanonicalEntities(summary, entities, dict);
    expandCanonicalEntities(title, entities, dict);
    expandCanonicalEntities(summary, entities, dict);
    collectDynamicCandidates(title, entities, dict);
    collectDynamicCandidates(summary, entities, dict);
  }

  return deduplicateEntities([...entities], dict);
};
