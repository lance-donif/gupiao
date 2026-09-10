/**
 * 因果抽取结果协议（纯函数，无 DB）。
 *
 * - v3「逐条结果协议」：`{ items: [{ newsId, status, signals }] }`。
 * - v2 旧协议：`{ signals, noSignalNewsIds }`，由 `parseLegacyProtocol` 归一化成
 *   与 v3 相同的 `ParsedCausalItem[]`，使新旧协议在下游收敛到同一结构。
 *
 * 协议版本号一律从 `version.ts` 读取，本模块不另造常量。
 * 解析失败一律 throw，绝不返回部分结果或把失败当作「无信号」。
 */

import { CAUSAL_PROTOCOL_VERSION, CAUSAL_PROTOCOL_VERSION_ITEMS } from '../version.js';

export type CausalSignalDirection = 'positive' | 'negative' | 'mixed' | 'neutral';

/** 逐条抽取结果协议版本对应的模式。 */
export type CausalProtocolMode = 'items' | 'legacy';

/** 单条 signal 载荷（不含 newsId，新闻身份由所在 item 决定）。 */
export interface CausalSignalPayload {
  readonly event: string;
  readonly businessVariable: string;
  readonly assetOrThemeKeyword: string;
  readonly direction: CausalSignalDirection;
  readonly confidence: number;
  readonly evidenceText: string;
  readonly evidenceOffsetStart?: number | null;
  readonly evidenceOffsetEnd?: number | null;
  readonly status?: 'candidate' | 'rejected';
  readonly failureReason?: string | null;
}

/** 归一化后的逐条抽取结果：每条输入新闻恰好一项。 */
export interface ParsedCausalItem {
  readonly newsId: string;
  readonly status: 'signals' | 'no_signal';
  readonly signals: readonly CausalSignalPayload[];
}

/** 定位证据所需的新闻字段（title + content 参与定位）。 */
export interface CausalProtocolNews {
  readonly id: string;
  readonly title: string;
  readonly content: string;
}

/** 允许直接传新闻数组，或 `id -> {title,content}` 的索引。 */
export type CausalProtocolNewsSource =
  | readonly CausalProtocolNews[]
  | ReadonlyMap<string, { readonly title: string; readonly content: string }>;

export type CausalProtocolErrorCode =
  | 'invalid_json'
  | 'invalid_structure'
  | 'missing_news'
  | 'duplicate_news'
  | 'unknown_news'
  | 'empty_signals'
  | 'unexpected_signals'
  | 'invalid_signal'
  | 'evidence_not_locatable';

export class CausalProtocolError extends Error {
  public readonly code: CausalProtocolErrorCode;
  public constructor(code: CausalProtocolErrorCode, message: string) {
    super(message);
    this.name = 'CausalProtocolError';
    this.code = code;
  }
}

/** 返回当前模式应使用的协议版本号（2 或 3），供调用方写入缓存键与持久化列。 */
export const toProtocolVersion = (mode: CausalProtocolMode): number =>
  mode === 'items' ? CAUSAL_PROTOCOL_VERSION_ITEMS : CAUSAL_PROTOCOL_VERSION;

/** 反向映射：已知协议版本号时推断模式；未知版本抛错，不静默回退。 */
export const protocolModeForVersion = (version: number): CausalProtocolMode => {
  if (version === CAUSAL_PROTOCOL_VERSION_ITEMS) return 'items';
  if (version === CAUSAL_PROTOCOL_VERSION) return 'legacy';
  throw new CausalProtocolError('invalid_structure', `unknown causal protocol version: ${String(version)}`);
};

/** v3 逐条抽取的 system/user prompt 片段。 */
export const buildItemsProtocolInstruction = (): string => [
  '你是股票弱信号结构化抽取器，只输出 JSON。',
  '逐条独立抽取：一次只依据当前这一条新闻的原文判断，禁止把另一篇新闻的事实、主体、数字或结论拼入当前新闻。',
  '输入新闻必须逐条出现且只出现一次：每条输入新闻恰好返回一个 item，不允许遗漏、重复或新增 newsId。',
  '有信号时返回 {"newsId":"...","status":"signals","signals":[...]}，signals 至少一个元素。',
  '无信号时返回 {"newsId":"...","status":"no_signal","signals":[]}，signals 必须为空数组。',
  'status 只能是 signals 或 no_signal。',
  'direction 只能是 positive, negative, mixed, neutral。',
  '每条 signal 必须包含 event,businessVariable,assetOrThemeKeyword,direction,confidence,evidenceText,evidenceOffsetStart,evidenceOffsetEnd。',
  'evidenceText 必须是当前新闻原文片段，offset 是在 title + "。" + content 去空白后的字符区间。',
  '不要写股票推荐，不要生成股票分数。',
  '返回格式：{"items":[{"newsId":"...","status":"signals","signals":[...]}]}。',
].join('\n');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isDirection = (value: unknown): value is CausalSignalDirection =>
  value === 'positive' || value === 'negative' || value === 'mixed' || value === 'neutral';

const normalizeForLocation = (value: string): string =>
  value.replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');

const locateEvidence = (
  news: { readonly title: string; readonly content: string } | undefined,
  evidenceText: string,
): { readonly start: number; readonly end: number } | null => {
  if (!news || evidenceText.trim().length === 0) return null;
  const sourceText = normalizeForLocation(`${news.title}。${news.content}`);
  const evidence = normalizeForLocation(evidenceText);
  if (evidence.length === 0) return null;
  const start = sourceText.indexOf(evidence);
  if (start < 0) return null;
  return { start, end: start + evidence.length };
};

const buildNewsIndex = (
  expected: CausalProtocolNewsSource,
): Map<string, { readonly title: string; readonly content: string }> => {
  const index = new Map<string, { readonly title: string; readonly content: string }>();
  if (Array.isArray(expected)) {
    for (const news of expected as readonly CausalProtocolNews[]) {
      index.set(news.id, { title: news.title, content: news.content });
    }
    return index;
  }
  for (const [id, news] of (expected as ReadonlyMap<string, { readonly title: string; readonly content: string }>)) {
    index.set(id, { title: news.title, content: news.content });
  }
  return index;
};

const parseJsonIfString = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new CausalProtocolError('invalid_json', 'causal protocol payload is not valid JSON');
  }
};

const parseFiniteOffset = (value: unknown, field: string, newsId: string): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CausalProtocolError('invalid_signal', `invalid ${field} for news ${newsId}`);
  }
  return value;
};

const parseSignalPayload = (
  signal: unknown,
  newsId: string,
  newsIndex: ReadonlyMap<string, { readonly title: string; readonly content: string }>,
): CausalSignalPayload => {
  if (!isRecord(signal)) {
    throw new CausalProtocolError('invalid_signal', `signal must be an object for news ${newsId}`);
  }
  if (signal.newsId !== undefined && signal.newsId !== newsId) {
    throw new CausalProtocolError('invalid_signal', `signal newsId does not match its item for news ${newsId}`);
  }
  if (typeof signal.event !== 'string'
    || typeof signal.businessVariable !== 'string'
    || typeof signal.assetOrThemeKeyword !== 'string'
    || !isDirection(signal.direction)
    || typeof signal.confidence !== 'number'
    || !Number.isFinite(signal.confidence)
    || typeof signal.evidenceText !== 'string') {
    throw new CausalProtocolError('invalid_signal', `invalid signal payload for news ${newsId}`);
  }

  const located = locateEvidence(newsIndex.get(newsId), signal.evidenceText);
  if (!located) {
    throw new CausalProtocolError('evidence_not_locatable', `evidence text cannot be located for news ${newsId}`);
  }

  return {
    event: signal.event,
    businessVariable: signal.businessVariable,
    assetOrThemeKeyword: signal.assetOrThemeKeyword,
    direction: signal.direction,
    confidence: signal.confidence,
    evidenceText: signal.evidenceText,
    evidenceOffsetStart: parseFiniteOffset(signal.evidenceOffsetStart, 'evidenceOffsetStart', newsId) ?? located.start,
    evidenceOffsetEnd: parseFiniteOffset(signal.evidenceOffsetEnd, 'evidenceOffsetEnd', newsId) ?? located.end,
    status: signal.status === 'rejected' ? 'rejected' : 'candidate',
    failureReason: typeof signal.failureReason === 'string' ? signal.failureReason : null,
  };
};

/**
 * 解析 v3 逐条结果协议。任何不满足项都整次失败（throw），不产生部分提交。
 */
export function parseItemsProtocol(
  raw: unknown,
  expectedNewsIds: CausalProtocolNewsSource,
): ParsedCausalItem[] {
  const newsIndex = buildNewsIndex(expectedNewsIds);
  const value = parseJsonIfString(raw);
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new CausalProtocolError('invalid_structure', 'items protocol requires an object with an items array');
  }

  const seen = new Set<string>();
  const parsed: ParsedCausalItem[] = [];
  for (const entry of value.items) {
    if (!isRecord(entry)) {
      throw new CausalProtocolError('invalid_structure', 'each item must be an object');
    }
    const newsId = entry.newsId;
    if (typeof newsId !== 'string') {
      throw new CausalProtocolError('invalid_structure', 'each item requires a string newsId');
    }
    if (!newsIndex.has(newsId)) {
      throw new CausalProtocolError('unknown_news', `unknown news id: ${newsId}`);
    }
    if (seen.has(newsId)) {
      throw new CausalProtocolError('duplicate_news', `duplicate news id: ${newsId}`);
    }
    seen.add(newsId);

    const status = entry.status;
    if (status !== 'signals' && status !== 'no_signal') {
      throw new CausalProtocolError('invalid_structure', `invalid item status for news ${newsId}`);
    }
    if (!Array.isArray(entry.signals)) {
      throw new CausalProtocolError('invalid_structure', `item requires a signals array for news ${newsId}`);
    }
    if (status === 'signals' && entry.signals.length === 0) {
      throw new CausalProtocolError('empty_signals', `signals status requires at least one signal for news ${newsId}`);
    }
    if (status === 'no_signal' && entry.signals.length > 0) {
      throw new CausalProtocolError('unexpected_signals', `no_signal status must not carry signals for news ${newsId}`);
    }

    const signals = entry.signals.map(signal => parseSignalPayload(signal, newsId, newsIndex));
    parsed.push({ newsId, status, signals });
  }

  const missing = [...newsIndex.keys()].filter(id => !seen.has(id));
  if (missing.length > 0) {
    throw new CausalProtocolError('missing_news', `missing news outcome: ${missing.join(',')}`);
  }
  return parsed;
}

/**
 * 解析 v2 旧协议 `{signals, noSignalNewsIds}`，归一化为 `ParsedCausalItem[]`。
 * 覆盖性、重复、未知 newsId、非法结构、证据无法定位均 throw。
 */
export function parseLegacyProtocol(
  raw: unknown,
  expectedNewsIds: CausalProtocolNewsSource,
): ParsedCausalItem[] {
  const newsIndex = buildNewsIndex(expectedNewsIds);
  const value = parseJsonIfString(raw);
  if (!isRecord(value) || !Array.isArray(value.signals) || !Array.isArray(value.noSignalNewsIds)) {
    throw new CausalProtocolError('invalid_structure', 'legacy protocol requires signals and noSignalNewsIds arrays');
  }

  const grouped = new Map<string, CausalSignalPayload[]>();
  for (const signal of value.signals) {
    if (!isRecord(signal) || typeof signal.newsId !== 'string') {
      throw new CausalProtocolError('invalid_structure', 'each legacy signal requires a string newsId');
    }
    const newsId = signal.newsId;
    if (!newsIndex.has(newsId)) {
      throw new CausalProtocolError('unknown_news', `unknown news id: ${newsId}`);
    }
    const payload = parseSignalPayload(signal, newsId, newsIndex);
    const list = grouped.get(newsId) ?? [];
    list.push(payload);
    grouped.set(newsId, list);
  }

  const noSignal = new Set<string>();
  for (const newsId of value.noSignalNewsIds) {
    if (typeof newsId !== 'string' || !newsIndex.has(newsId)) {
      throw new CausalProtocolError('unknown_news', `unknown news id: ${String(newsId)}`);
    }
    if (noSignal.has(newsId)) {
      throw new CausalProtocolError('duplicate_news', `duplicate no_signal news id: ${newsId}`);
    }
    noSignal.add(newsId);
  }

  const items: ParsedCausalItem[] = [];
  for (const newsId of newsIndex.keys()) {
    const signals = grouped.get(newsId);
    if (signals && noSignal.has(newsId)) {
      throw new CausalProtocolError('duplicate_news', `news id has both signals and no_signal: ${newsId}`);
    }
    if (signals) items.push({ newsId, status: 'signals', signals });
    else if (noSignal.has(newsId)) items.push({ newsId, status: 'no_signal', signals: [] });
    else throw new CausalProtocolError('missing_news', `missing news outcome: ${newsId}`);
  }
  return items;
}
