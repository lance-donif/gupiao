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
  return normalizeTitleForMatch(value).replace(/\s+/gu, '').toLowerCase();
};

/** 全角转半角（FF01–FF5E）；U+3000 已被 \s 覆盖。 */
const toHalfwidth = (value: string): string => {
  return value.replace(/[\uFF01-\uFF5E]/gu, char =>
    String.fromCharCode(char.charCodeAt(0) - 0xFEE0),
  );
};

/** 转载站点后缀：分隔符 + 站点/频道词结尾，命中则截断。 */
const SITE_SUFFIX_PATTERN = /[-_—–|｜:：·\s]+((新浪|腾讯|网易|搜狐|凤凰|东方财富|同花顺|雪球|财联社|第一财经|证券时报|上海证券报|中国证券报|证券日报|每日经济新闻|界面|澎湃)(网|版|端|频道|专区|\.com|\.cn)?(财经|证券)?|财经|证券|股票|基金|期货|外汇|理财|股吧|论坛|博客|视频|直播|评论(网|版)?)$/u;

/**
 * 匹配用标题归一化：全角转半角 + 去转载站点后缀。
 * 同时用于 dedupKey（经 normalizeForDedup）、blocking 前缀桶与 bigram 相似度输入。
 */
export const normalizeTitleForMatch = (value: string): string => {
  return toHalfwidth(value).replace(SITE_SUFFIX_PATTERN, '');
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

const titlePrefixBucket = (title: string): string => normalizeBucketText(normalizeTitleForMatch(title)).slice(0, 12);

const dateBucket = (date: Date): string => date.toISOString().slice(0, 10);

/* keywordBucketTerms 已外置到 DB KeywordDictionary（category='blocking'），经构造函数注入。 */

const businessVariablePattern = /(需求|订单|销量|销售|消费|装机|采购|交付|出口|中标|库存|产量|产能|供应|供给|不足|下降|减少|紧张|短缺|瓶颈|受限|价格|报价|现货|期货|上涨|涨价|大涨|突破|新高|资金|成交|融资|增持|回购|政策|补贴|支持|推进|促进|审批|准入|许可)/u;

const stockNameMentionPattern = /(?:^|[^\u4E00-\u9FA5])(?:ST|[*＊]ST|[\u4E00-\u9FA5]{2,6}(?:股份|科技|集团|银行|证券|有色|能源|药业|医药|电子|化工|电力|汽车|材料))(?:$|[^\u4E00-\u9FA5])/u;

const createBlockingKeys = (
  candidate: INormalizedNewsCandidate,
  blockingTerms: readonly string[],
): readonly string[] => {
  const keys = new Set<string>();
  const source = candidate.source || 'unknown';
  const date = dateBucket(candidate.publishedAt);
  const prefix = titlePrefixBucket(candidate.title);
  if (prefix.length >= 6) {
    keys.add(`title:${date}:${prefix}`);
  }
  keys.add(`source:${source}:${date}`);

  const keywordText = `${candidate.title} ${candidate.content}`.toLocaleLowerCase('zh-CN');
  const keywords = new Set(blockingTerms
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

export const REPRINT_TITLE_SIMILARITY_THRESHOLD = 0.60;
export const REPRINT_CONTENT_SIMILARITY_THRESHOLD = 0.85;

export const calculateCosineSimilarity = (textA: string, textB: string): number => {
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

const isLeaderWeight = (candidate: INormalizedNewsCandidate): boolean => {
  return (candidate.reprintWeight ?? 1.0) === 1.0;
};

const isBetterLeader = (
  next: INormalizedNewsCandidate,
  current: INormalizedNewsCandidate,
): boolean => {
  if (isLeaderWeight(next) !== isLeaderWeight(current)) {
    return isLeaderWeight(next);
  }
  const nextTime = next.publishedAt instanceof Date ? next.publishedAt.getTime() : NaN;
  const currentTime = current.publishedAt instanceof Date ? current.publishedAt.getTime() : NaN;
  if (Number.isNaN(nextTime) || Number.isNaN(currentTime)) {
    return false;
  }
  return nextTime < currentTime;
};

/**
 * 转载组仅首条进 LLM：组内保留 reprintWeight==1.0 且 publishedAt 最早者
 * （组内无权重 1.0 则退回最早者）；其余保留分组/权重但不进入抽取输入。
 * 未分组行原样通过，原有相对顺序不变。
 */
export const selectExtractionLeaders = (
  candidates: readonly INormalizedNewsCandidate[],
): INormalizedNewsCandidate[] => {
  const bestByGroup = new Map<string, INormalizedNewsCandidate>();
  for (const candidate of candidates) {
    const groupId = candidate.reprintGroupId;
    if (!groupId) {
      continue;
    }
    const current = bestByGroup.get(groupId);
    if (!current || isBetterLeader(candidate, current)) {
      bestByGroup.set(groupId, candidate);
    }
  }
  const leaders = new Set<INormalizedNewsCandidate>(bestByGroup.values());
  return candidates.filter(candidate => !candidate.reprintGroupId || leaders.has(candidate));
};

export interface INewsIngestDeduplicationPipelineOptions {
  /**
   * 转载分桶词（DB KeywordDictionary category='blocking'）。缺失时退化为空：
   * 分桶只是候选对预筛（召回优化），标题/来源桶仍工作，不影响正确性。
   * DB 加载失败仍由 getKeywordDictionary 启动期抛错，配置错误不会静默。
   */
  readonly blockingTerms?: readonly string[];
}

export class NewsIngestDeduplicationPipeline {
  public constructor(private readonly options: INewsIngestDeduplicationPipelineOptions = {}) {}

  private resolveBlockingTerms(): readonly string[] {
    return this.options.blockingTerms ?? [];
  }

  public process(
    input: readonly INormalizedNewsCandidate[],
  ): IServicePipelineReport<readonly INormalizedNewsCandidate[], readonly INormalizedNewsCandidate[]> {
    const blockingTerms = this.resolveBlockingTerms();
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
      const keys = createBlockingKeys(uniqueCandidates[i], blockingTerms);
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
      for (const key of createBlockingKeys(current, blockingTerms)) {
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

        const titleSim = calculateCosineSimilarity(
          normalizeTitleForMatch(current.title),
          normalizeTitleForMatch(other.title),
        );
        const contentSim = calculateCosineSimilarity(
          normalizeTitleForMatch(current.content),
          normalizeTitleForMatch(other.content),
        );

        if (titleSim > REPRINT_TITLE_SIMILARITY_THRESHOLD || contentSim > REPRINT_CONTENT_SIMILARITY_THRESHOLD) {
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
