import type { INewsSourceArticle } from '../sources/contracts.js';
import { NewsItem } from '../types/entities/news-item.js';

import { Timestamp } from '../types/value-objects/timestamp.js';

export interface INormalizedNewsCandidate {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly source: string;
  readonly url: string;
  readonly publishedAt: Date;
  readonly dedupKey: string;
  reprintGroupId?: string;
  reprintWeight?: number;
  sameTopicCount?: number;
  quality?: INewsQualitySignal;
}

export interface INewsQualitySignal {
  readonly titleQuality: 'empty' | 'short' | 'normal';
  readonly contentQuality: 'empty' | 'title_only' | 'summary' | 'content';
  readonly hasBusinessVariable: boolean;
  readonly hasDirectStockName: boolean;
  readonly qualityScore: number;
  readonly failureReason?: string | null;
}

export interface IServicePipelineReport<TInput, TOutput> {
  readonly input: TInput;
  readonly processed: TOutput;
  readonly steps: readonly string[];
}

const normalizeWhitespace = (value: string): string => {
  return value.trim().replace(/\s+/gu, ' ');
};

const normalizeForDedup = (value: string): string => {
  return normalizeWhitespace(value).replace(/\s+/gu, '').toLowerCase();
};

const resolveCandidateId = (article: INewsSourceArticle): string => {
  const metadata = article.metadata as Record<string, unknown>;
  const recordId = metadata.recordId;

  if (typeof recordId === 'string' && recordId.length > 0) {
    return recordId;
  }

  return article.url;
};

export class NewsIngestNormalizationPipeline {
  public process(
    input: readonly INewsSourceArticle[],
  ): IServicePipelineReport<readonly INewsSourceArticle[], readonly INormalizedNewsCandidate[]> {
    const steps = ['normalize:begin', 'normalize:trim-fields'];
    const processed = input.map((article) => {
      const normalizedTitle = normalizeWhitespace(article.title);
      const normalizedContent = normalizeWhitespace(article.summary);
      const dedupKey = `${normalizeForDedup(normalizedTitle)}::${normalizeForDedup(normalizedContent)}::${article.url}`;

      return {
        id: resolveCandidateId(article),
        title: normalizedTitle,
        content: normalizedContent,
        source: article.metadata.provider,
        url: article.url,
        publishedAt: article.publishedAt,
        dedupKey,
      } satisfies INormalizedNewsCandidate;
    });

    steps.push('normalize:complete');

    return {
      input,
      processed,
      steps,
    };
  }
}

const getBiGrams = (text: string): string[] => {
  const normalized = text.toLowerCase().replace(/[^\u4E00-\u9FA5a-z0-9]/gi, '');
  const biGrams: string[] = [];
  for (let i = 0; i < normalized.length - 1; i++) {
    biGrams.push(normalized.substring(i, i + 2));
  }
  return biGrams;
};

const normalizeBucketText = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^\u4E00-\u9FA5a-z0-9]/gi, '');
};

const titlePrefixBucket = (title: string): string => normalizeBucketText(title).slice(0, 12);

const dateBucket = (date: Date): string => date.toISOString().slice(0, 10);

const keywordBucketTerms = [
  '白银',
  '黄金',
  '铜',
  '铝',
  '锂',
  '镍',
  '稀土',
  '煤炭',
  '石油',
  '天然气',
  '电力',
  '光伏',
  '新能源',
  '储能',
  '电池',
  '芯片',
  '半导体',
  '机器人',
  '算力',
  '医药',
  '创新药',
  '化工',
  '航运',
  '航空',
  '军工',
  '原奶',
  '玻纤',
  '氢氟酸',
  '化肥',
  'LNG',
  '油轮',
  '原油',
  'DRAM',
  'MLCC',
  '白酒',
  '证券',
  '铁矿',
] as const;

const businessVariablePattern = /(需求|订单|销量|销售|消费|装机|采购|交付|出口|中标|库存|产量|产能|供应|供给|不足|下降|减少|紧张|短缺|瓶颈|受限|价格|报价|现货|期货|上涨|涨价|大涨|突破|新高|资金|成交|融资|增持|回购|政策|补贴|支持|推进|促进|审批|准入|许可)/u;

const stockNameMentionPattern = /(?:^|[^\u4E00-\u9FA5])(?:ST|[*＊]ST|[\u4E00-\u9FA5]{2,6}(?:股份|科技|集团|银行|证券|有色|能源|药业|医药|电子|化工|电力|汽车|材料))(?:$|[^\u4E00-\u9FA5])/u;

const createBlockingKeys = (candidate: INormalizedNewsCandidate): readonly string[] => {
  const keys = new Set<string>();
  const source = candidate.source || 'unknown';
  const date = dateBucket(candidate.publishedAt);
  const prefix = titlePrefixBucket(candidate.title);
  if (prefix.length >= 6) {
    keys.add(`title:${date}:${prefix}`);
  }
  keys.add(`source:${source}:${date}`);

  const keywordText = `${candidate.title} ${candidate.content}`.toLocaleLowerCase('zh-CN');
  const keywords = new Set(keywordBucketTerms
    .filter(term => keywordText.includes(term.toLocaleLowerCase('zh-CN')))
    .map(term => term.toLocaleLowerCase('zh-CN')));
  for (const keyword of keywords) {
    keys.add(`kw:${date}:${keyword}`);
  }

  return [...keys];
};

const calculateNewsQualitySignal = (candidate: INormalizedNewsCandidate): INewsQualitySignal => {
  const titleLength = normalizeBucketText(candidate.title).length;
  const contentLength = normalizeBucketText(candidate.content).length;
  const titleQuality = titleLength === 0 ? 'empty' : (titleLength < 8 ? 'short' : 'normal');
  const contentQuality = contentLength === 0
    ? 'empty'
    : (contentLength <= titleLength + 4 ? 'title_only' : (contentLength >= 80 ? 'content' : 'summary'));
  const hasBusinessVariable = businessVariablePattern.test(`${candidate.title} ${candidate.content}`);
  const hasDirectStockName = stockNameMentionPattern.test(` ${candidate.title} ${candidate.content} `);
  const titleScore = titleQuality === 'normal' ? 0.3 : titleQuality === 'short' ? 0.15 : 0;
  const contentScore = contentQuality === 'content'
    ? 0.35
    : contentQuality === 'summary'
      ? 0.25
      : contentQuality === 'title_only' ? 0.1 : 0;
  const qualityScore = Math.max(
    0,
    Math.min(
      1,
      titleScore
      + contentScore
      + (hasBusinessVariable ? 0.25 : 0)
      + (hasDirectStockName ? 0.05 : 0.1),
    ),
  );
  const failureReason = qualityScore < 0.3
    ? 'low_news_quality'
    : (!hasBusinessVariable ? 'missing_business_variable' : null);
  return {
    titleQuality,
    contentQuality,
    hasBusinessVariable,
    hasDirectStockName,
    qualityScore: Number(qualityScore.toFixed(4)),
    failureReason,
  };
};

const calculateCosineSimilarity = (textA: string, textB: string): number => {
  const gramsA = getBiGrams(textA);
  const gramsB = getBiGrams(textB);
  if (gramsA.length === 0 || gramsB.length === 0) { return 0; }

  const freqMapA = new Map<string, number>();
  const freqMapB = new Map<string, number>();

  for (const gram of gramsA) freqMapA.set(gram, (freqMapA.get(gram) ?? 0) + 1);
  for (const gram of gramsB) freqMapB.set(gram, (freqMapB.get(gram) ?? 0) + 1);

  const allGrams = new Set([...freqMapA.keys(), ...freqMapB.keys()]);

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (const gram of allGrams) {
    const valA = freqMapA.get(gram) ?? 0;
    const valB = freqMapB.get(gram) ?? 0;
    dotProduct += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }

  if (normA === 0 || normB === 0) { return 0; }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

export class NewsIngestDeduplicationPipeline {
  public process(
    input: readonly INormalizedNewsCandidate[],
  ): IServicePipelineReport<readonly INormalizedNewsCandidate[], readonly INormalizedNewsCandidate[]> {
    const steps = ['deduplicate:begin', 'deduplicate:drop-duplicates'];
    const seenKeys = new Set<string>();
    const uniqueCandidates: INormalizedNewsCandidate[] = [];

    for (const candidate of input) {
      if (seenKeys.has(candidate.dedupKey)) {
        continue;
      }

      seenKeys.add(candidate.dedupKey);
      uniqueCandidates.push({ ...candidate });
    }

    steps.push('deduplicate:reprint-similarity-detection');

    const blockIndex = new Map<string, number[]>();
    for (let i = 0; i < uniqueCandidates.length; i++) {
      const keys = createBlockingKeys(uniqueCandidates[i]);
      for (const key of keys) {
        const list = blockIndex.get(key) ?? [];
        list.push(i);
        blockIndex.set(key, list);
      }
    }

    steps.push('deduplicate:blocking-index');

    for (let i = 0; i < uniqueCandidates.length; i++) {
      const current = uniqueCandidates[i];
      if (current.reprintGroupId !== undefined) {
        continue;
      }

      current.reprintGroupId = current.id;
      current.reprintWeight = 1.0;

      const candidateIndexes = new Set<number>();
      for (const key of createBlockingKeys(current)) {
        for (const index of blockIndex.get(key) ?? []) {
          if (index > i) {
            candidateIndexes.add(index);
          }
        }
      }

      for (const j of [...candidateIndexes].sort((left, right) => left - right)) {
        const other = uniqueCandidates[j];
        if (other.reprintGroupId !== undefined) {
          continue;
        }

        const titleSim = calculateCosineSimilarity(current.title, other.title);
        const contentSim = calculateCosineSimilarity(current.content, other.content);

        if (titleSim > 0.60 || contentSim > 0.85) {
          other.reprintGroupId = current.reprintGroupId;
          other.reprintWeight = 0.15;
        }
      }
    }

    const sameTopicCounts = new Map<string, number>();
    for (const candidate of uniqueCandidates) {
      const groupId = candidate.reprintGroupId ?? candidate.id;
      sameTopicCounts.set(groupId, (sameTopicCounts.get(groupId) ?? 0) + 1);
    }
    for (const candidate of uniqueCandidates) {
      const groupId = candidate.reprintGroupId ?? candidate.id;
      candidate.sameTopicCount = sameTopicCounts.get(groupId) ?? 1;
      candidate.quality = calculateNewsQualitySignal(candidate);
    }

    steps.push('deduplicate:complete');

    return {
      input,
      processed: uniqueCandidates,
      steps,
    };
  }
}

export const toNewsItems = (candidates: readonly INormalizedNewsCandidate[]): readonly NewsItem[] => {
  return candidates.map((candidate) => {
    return new NewsItem(
      candidate.id,
      candidate.title,
      candidate.content,
      candidate.source,
      Timestamp.from(candidate.publishedAt),
    );
  });
};

export type NewsNormalizationReport = IServicePipelineReport<
  readonly INewsSourceArticle[],
  readonly INormalizedNewsCandidate[]
>;

export type NewsDeduplicationReport = IServicePipelineReport<
  readonly INormalizedNewsCandidate[],
  readonly INormalizedNewsCandidate[]
>;
