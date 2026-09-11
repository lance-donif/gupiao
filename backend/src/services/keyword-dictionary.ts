/**
 * 全局关键词词典：DB（KeywordDictionary）是唯一来源，内存快照只做缓存。
 * 加载失败/词表为空一律抛 KeywordDictionaryError，调用方不得静默回退硬编码。
 */
import { hasDelegate } from './scoring/scoring-helpers.js';

export const KEYWORD_DICTIONARY_ACTIVE_STATUS = 'active';
export const DEFAULT_KEYWORD_DICTIONARY_TTL_MS = 5 * 60 * 1000;

export class KeywordDictionaryError extends Error {
  public constructor(message: string) {
    super(`[keyword-dictionary] ${message}`);
    this.name = 'KeywordDictionaryError';
  }
}

export interface IKeywordDictionaryRow {
  readonly term: unknown;
  readonly category: unknown;
  readonly canonicalTerm?: unknown;
  readonly weight?: unknown;
  readonly status?: unknown;
}

export interface ICanonicalTermGroup {
  readonly canonical: string;
  readonly patterns: readonly string[];
}

export interface IKeywordDictionarySnapshot {
  readonly stopwords: ReadonlySet<string>;
  readonly highSignalTerms: readonly string[];
  readonly canonicalGroups: readonly ICanonicalTermGroup[];
  readonly buzzPositive: readonly string[];
  readonly buzzNegative: readonly string[];
  readonly blockingTerms: readonly string[];
  readonly entryCount: number;
  readonly loadedAt: Date;
}

const toTerm = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : null;
};

const dedupeOrdered = (values: readonly string[]): string[] => [...new Set(values)];

/** 纯函数：行 -> 快照（只收 active；排序语义与原硬编码一致：高信号词按长度降序）。 */
export const buildKeywordDictionarySnapshot = (
  rows: readonly IKeywordDictionaryRow[],
  loadedAt: Date = new Date(),
): IKeywordDictionarySnapshot => {
  const active = rows.filter(row => String(row.status ?? KEYWORD_DICTIONARY_ACTIVE_STATUS) === KEYWORD_DICTIONARY_ACTIVE_STATUS);
  const byCategory = (category: string): string[] => {
    const terms: string[] = [];
    for (const row of active) {
      if (String(row.category ?? '') !== category) {
        continue;
      }
      const term = toTerm(row.term);
      if (term !== null) {
        terms.push(term);
      }
    }
    return dedupeOrdered(terms);
  };

  const canonicalGroups = new Map<string, string[]>();
  for (const row of active) {
    if (String(row.category ?? '') !== 'canonical') {
      continue;
    }
    const pattern = toTerm(row.term);
    const canonical = toTerm(row.canonicalTerm) ?? pattern;
    if (pattern === null || canonical === null) {
      continue;
    }
    const list = canonicalGroups.get(canonical) ?? [];
    if (!list.includes(pattern)) {
      list.push(pattern);
    }
    canonicalGroups.set(canonical, list);
  }

  const highSignalTerms = byCategory('high_signal').sort((left, right) => right.length - left.length);
  const entryCount = active.filter(row => toTerm(row.term) !== null).length;

  return {
    stopwords: new Set(byCategory('stopword')),
    highSignalTerms,
    canonicalGroups: [...canonicalGroups.entries()].map(([canonical, patterns]) => ({ canonical, patterns })),
    buzzPositive: byCategory('buzz_positive'),
    buzzNegative: byCategory('buzz_negative'),
    blockingTerms: byCategory('blocking'),
    entryCount,
    loadedAt,
  };
};

export const loadKeywordDictionary = async (prisma: any): Promise<IKeywordDictionarySnapshot> => {
  if (!hasDelegate(prisma, 'keywordDictionary', 'findMany')) {
    throw new KeywordDictionaryError(
      'prisma.keywordDictionary.findMany 不可用：请先在服务器执行 migrate 20260911000000_add_keyword_dictionary',
    );
  }
  let rows: unknown;
  try {
    rows = await prisma.keywordDictionary.findMany({ where: { status: KEYWORD_DICTIONARY_ACTIVE_STATUS } });
  }
  catch (error) {
    throw new KeywordDictionaryError(`词典查询失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new KeywordDictionaryError('词典为空：请先运行 scripts/seed-keyword-dictionary.ts 灌入 seed');
  }
  return buildKeywordDictionarySnapshot(rows as readonly IKeywordDictionaryRow[]);
};

let cachedSnapshot: { readonly snapshot: IKeywordDictionarySnapshot; readonly loadedAtMs: number } | null = null;

/** 带 TTL 的进程级缓存；过期/强制刷新时重载（失败直接抛，不返回过期快照）。 */
export const getKeywordDictionary = async (
  prisma: any,
  options: { readonly ttlMs?: number; readonly forceReload?: boolean } = {},
): Promise<IKeywordDictionarySnapshot> => {
  const ttlMs = options.ttlMs ?? DEFAULT_KEYWORD_DICTIONARY_TTL_MS;
  if (!options.forceReload && cachedSnapshot !== null && Date.now() - cachedSnapshot.loadedAtMs < ttlMs) {
    return cachedSnapshot.snapshot;
  }
  const snapshot = await loadKeywordDictionary(prisma);
  cachedSnapshot = { snapshot, loadedAtMs: Date.now() };
  return snapshot;
};

export const invalidateKeywordDictionary = (): void => {
  cachedSnapshot = null;
};
