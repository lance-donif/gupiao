import type { IProviderNewsArticlePayload } from '../sources/contracts.js';

export interface INewsCleanerOptions {
  readonly similarityThreshold?: number;
  readonly shingleSize?: number;
}

export interface INewsCleanerResult {
  readonly items: readonly IProviderNewsArticlePayload[];
  readonly diagnostics: {
    readonly rawCount: number;
    readonly exactDedupCount: number;
    readonly semanticDedupCount: number;
    readonly duplicateCount: number;
  };
}

interface ITextShingle {
  readonly text: string;
  readonly shingles: Set<string>;
}

const createShingles = (text: string, size: number): Set<string> => {
  const normalized = text.replace(/\s+/g, '');
  if (normalized.length < size) {
    return new Set(normalized.length > 0 ? [normalized] : []);
  }
  const shingles = new Set<string>();
  for (let i = 0; i <= normalized.length - size; i++) {
    shingles.add(normalized.slice(i, i + size));
  }
  return shingles;
};

const jaccardSimilarity = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) {
      intersection++;
    }
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
};

const createExactKey = (item: IProviderNewsArticlePayload): string => {
  // 只用 URL 做精确去重（如果有 URL 的话）
  const url = (item.url || '').trim();
  if (url) {
    return url;
  }
  // 没有 URL 时用 title 作为 key
  return (item.title || '').trim();
};

const createTextForSimilarity = (item: IProviderNewsArticlePayload): string => {
  // 用完整 title + summary 做语义相似度
  return `${item.title}\n${item.summary || ''}`;
};

export class NewsCleaner {
  private readonly similarityThreshold: number;
  private readonly shingleSize: number;

  public constructor(options: INewsCleanerOptions = {}) {
    this.similarityThreshold = options.similarityThreshold ?? 0.85;
    this.shingleSize = options.shingleSize ?? 3;
  }

  public clean(items: readonly IProviderNewsArticlePayload[]): INewsCleanerResult {
    const rawCount = items.length;

    if (rawCount <= 1) {
      return {
        items,
        diagnostics: {
          rawCount,
          exactDedupCount: rawCount,
          semanticDedupCount: rawCount,
          duplicateCount: 0,
        },
      };
    }

    // Step 1: Exact deduplication
    const seenKeys = new Set<string>();
    const exactDeduped: IProviderNewsArticlePayload[] = [];

    for (const item of items) {
      const key = createExactKey(item);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        exactDeduped.push(item);
      }
    }

    const exactDedupCount = exactDeduped.length;

    if (exactDedupCount <= 1) {
      return {
        items: exactDeduped,
        diagnostics: {
          rawCount,
          exactDedupCount,
          semanticDedupCount: exactDedupCount,
          duplicateCount: rawCount - exactDedupCount,
        },
      };
    }

    // Step 2: Semantic deduplication using Jaccard similarity
    const textShingles: ITextShingle[] = exactDeduped.map(item => ({
      text: createTextForSimilarity(item),
      shingles: createShingles(createTextForSimilarity(item), this.shingleSize),
    }));

    const skipIndices = new Set<number>();

    for (let i = 0; i < textShingles.length; i++) {
      if (skipIndices.has(i)) {
        continue;
      }
      for (let j = i + 1; j < textShingles.length; j++) {
        if (skipIndices.has(j)) {
          continue;
        }
        const sim = jaccardSimilarity(textShingles[i].shingles, textShingles[j].shingles);
        if (sim >= this.similarityThreshold) {
          skipIndices.add(j);
        }
      }
    }

    const semanticDeduped = exactDeduped.filter((_, idx) => !skipIndices.has(idx));
    const semanticDedupCount = semanticDeduped.length;

    return {
      items: semanticDeduped,
      diagnostics: {
        rawCount,
        exactDedupCount,
        semanticDedupCount,
        duplicateCount: rawCount - semanticDedupCount,
      },
    };
  }
}
