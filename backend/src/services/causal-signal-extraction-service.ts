import { createHash } from 'node:crypto';
import { AiChatClient, AiInputError, AiCandidatesExhaustedError, createAiOptionsFromEnv, withAiSource, type AiSourcedArray, type IAiSource } from './ai-chat-client.js';
import { isAiRecord } from './ai-provider-config.js';
import { Prisma } from '@prisma/client';
import { DataRefreshLedgerService } from './data-refresh-ledger-service.js';
import { buildItemsProtocolInstruction, parseItemsProtocol, toProtocolVersion, type CausalProtocolMode, type ParsedCausalItem } from './causal-protocol.js';
import { CAUSAL_PROTOCOL_VERSION, CAUSAL_PROTOCOL_VERSION_ITEMS } from '../version.js';

export type CausalSignalDirection = 'positive' | 'negative' | 'mixed' | 'neutral';

export interface ICausalSignalExtractionNews {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly source: string;
  readonly publishedAt: Date;
  readonly reprintWeight?: number | string | null;
}

export interface ICausalSignalCandidateRecord {
  readonly traceId: string;
  readonly asOf: Date;
  readonly clusterKey: string;
  readonly newsId: string;
  readonly event: string;
  readonly businessVariable: string;
  readonly assetOrThemeKeyword: string;
  readonly direction: CausalSignalDirection;
  readonly confidence: number;
  readonly evidenceText: string;
  readonly evidenceOffsetStart?: number | null;
  readonly evidenceOffsetEnd?: number | null;
  readonly extractorType: 'rule' | 'llm';
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly status: 'candidate' | 'rejected';
  readonly failureReason?: string | null;
}

export interface ICausalSignalExtractionInput {
  readonly traceId: string;
  readonly asOf: Date;
  readonly clusterKey: string;
  readonly news: readonly ICausalSignalExtractionNews[];
  readonly batchSize?: number;
  readonly concurrency?: number;
  readonly onBatchComplete?: (event: {
    readonly batchIndex: number;
    readonly batchCount: number;
    readonly batchSize: number;
    readonly elapsedMs: number;
    readonly signalCount: number;
  }) => void;
}

export interface ICausalSignalExtractionResult {
  readonly candidateCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly cacheHitCount: number;
  readonly insertedCount: number;
  readonly extractorType: 'rule' | 'llm';
  readonly failures: readonly string[];
  readonly sample: readonly Record<string, unknown>[];
}

export interface ICausalSignalExtractor {
  readonly extractorType: 'rule' | 'llm';
  readonly modelVersion: string;
  readonly promptVersion: string;
  /**
   * 抽取结果协议版本。旧实现未声明时按 v2（`CAUSAL_PROTOCOL_VERSION`）处理，
   * 缓存键/持久化列据此区分新旧协议，避免跨协议复用。
   */
  readonly protocolVersion?: number;
  readonly cacheModelVersions?: readonly string[];
  extract: (input: ICausalSignalExtractionInput) => Promise<AiSourcedArray<ICausalSignalCandidateRecord>>;
}

interface IVariablePattern {
  readonly variable: string;
  readonly direction: CausalSignalDirection;
  readonly pattern: RegExp;
}

const ASSET_KEYWORDS = [
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
] as const;

const BUSINESS_VARIABLE_PATTERNS: readonly IVariablePattern[] = [
  { variable: '需求增加', direction: 'positive', pattern: /(需求|订单|销量|销售|消费|装机|采购|交付|出口|中标).{0,8}(增加|增长|提升|回暖|旺盛|放量|改善|大增)/u },
  { variable: '供给不足', direction: 'positive', pattern: /(库存|产量|产能|供应|供给).{0,8}(不足|下降|减少|紧张|短缺|瓶颈|受限)/u },
  { variable: '价格上涨', direction: 'positive', pattern: /(价格|报价|现货|期货).{0,8}(上涨|涨价|大涨|突破|新高|走高)/u },
  { variable: '资金流入', direction: 'positive', pattern: /(资金|成交|融资|增持|回购).{0,8}(流入|放量|增加|活跃|升温)/u },
  { variable: '政策支持', direction: 'positive', pattern: /(政策|补贴|支持|推进|促进|审批|准入|许可).{0,12}(落地|加码|推进|扩大|提速|支持)/u },
  { variable: '需求下降', direction: 'negative', pattern: /(需求|订单|销量|销售|消费).{0,8}(下降|减少|疲软|萎缩|不及预期)/u },
  { variable: '价格下跌', direction: 'negative', pattern: /(价格|报价|现货|期货).{0,8}(下跌|走低|回落|暴跌)/u },
  { variable: '风险事件', direction: 'negative', pattern: /(处罚|罚单|立案|调查|违法|违规|事故|退市|制裁|风险)/u },
];

const normalizeText = (value: string): string => value.replace(/\s+/gu, '');

const normalizeForSupportCheck = (value: string): string => normalizeText(value).toLocaleLowerCase('zh-CN');

const findEvidenceOffset = (text: string, keyword: string, variableMatchIndex: number): { start: number; end: number; text: string } => {
  const keywordIndex = text.indexOf(keyword);
  const center = Math.max(keywordIndex, variableMatchIndex, 0);
  const start = Math.max(0, center - 48);
  const end = Math.min(text.length, center + 72);
  return {
    start,
    end,
    text: text.slice(start, end),
  };
};

const confidenceForRuleSignal = (
  keyword: string,
  variable: string,
  title: string,
  sourceCountHint: number,
): number => {
  const titleBonus = title.includes(keyword) || title.includes(variable.slice(0, 2)) ? 0.08 : 0;
  const sourceBonus = Math.min(0.08, sourceCountHint * 0.02);
  return Number(Math.min(0.86, 0.58 + titleBonus + sourceBonus).toFixed(4));
};

export class RuleCausalSignalExtractor implements ICausalSignalExtractor {
  public readonly extractorType = 'rule' as const;
  public readonly modelVersion = 'rule-causal-signal-v1';
  public readonly promptVersion = 'rule-pattern-v1';
  public readonly protocolVersion = CAUSAL_PROTOCOL_VERSION;

  public async extract(input: ICausalSignalExtractionInput): Promise<readonly ICausalSignalCandidateRecord[]> {
    const candidates = new Map<string, ICausalSignalCandidateRecord>();
    const sourceCount = new Set(input.news.map(news => news.source)).size;

    for (const news of input.news) {
      const combinedText = normalizeText(`${news.title}。${news.content}`);
      for (const keyword of ASSET_KEYWORDS) {
        if (!combinedText.includes(keyword)) {
          continue;
        }

        for (const variablePattern of BUSINESS_VARIABLE_PATTERNS) {
          const match = combinedText.match(variablePattern.pattern);
          if (!match || typeof match.index !== 'number') {
            continue;
          }

          const evidence = findEvidenceOffset(combinedText, keyword, match.index);
          const key = `${news.id}:${variablePattern.variable}:${keyword}:${this.extractorType}`;
          candidates.set(key, {
            traceId: input.traceId,
            asOf: input.asOf,
            clusterKey: input.clusterKey,
            newsId: news.id,
            event: news.title.slice(0, 120),
            businessVariable: variablePattern.variable,
            assetOrThemeKeyword: keyword,
            direction: variablePattern.direction,
            confidence: confidenceForRuleSignal(keyword, variablePattern.variable, news.title, sourceCount),
            evidenceText: evidence.text,
            evidenceOffsetStart: evidence.start,
            evidenceOffsetEnd: evidence.end,
            extractorType: this.extractorType,
            modelVersion: this.modelVersion,
            promptVersion: this.promptVersion,
            status: 'candidate',
            failureReason: null,
          });
        }
      }
    }

    return [...candidates.values()];
  }
}

interface IOpenAiCompatibleCausalSignalExtractorOptions {
  readonly client?: AiChatClient;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxRequestChars?: number;
  readonly requestTimeoutMs?: number;
  /**
   * `items` = v3 逐条结果协议；`legacy` = v2 `{signals,noSignalNewsIds}`。
   * 默认 `items`；只有调试旧报文时才显式设 `CAUSAL_PROTOCOL_MODE=legacy`。
   */
  readonly protocolMode?: CausalProtocolMode;
}

const isDirection = (value: unknown): value is CausalSignalDirection => {
  return value === 'positive' || value === 'negative' || value === 'mixed' || value === 'neutral';
};


const DEFAULT_MAX_LLM_REQUEST_CHARS = 240_000;
const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 120_000;

const LLM_CACHE_EXPIRES_AT = new Date('2099-12-31T23:59:59.999Z');

const KEYWORD_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  白银: ['银价', '银矿', '伴生银'],
  黄金: ['金价', '金矿'],
  铜: ['铜价', '铜矿', '电解铜'],
  铝: ['铝价', '电解铝', '氧化铝'],
  锂: ['锂矿', '碳酸锂', '氢氧化锂'],
  镍: ['镍矿', '硫酸镍'],
  稀土: ['稀土永磁', '钕铁硼'],
  煤炭: ['煤矿', '焦煤', '动力煤'],
  石油: ['原油', '油价'],
  天然气: ['LNG', '液化天然气'],
  电力: ['用电量', '电价'],
  光伏: ['组件', '硅料', '硅片', '电池片'],
  新能源: ['风电', '光伏', '储能', '新能源汽车'],
  储能: ['新型储能', '储能电站'],
  电池: ['动力电池', '锂电池', '电芯'],
  芯片: ['半导体', '晶圆', '集成电路'],
  半导体: ['芯片', '晶圆', '集成电路'],
  机器人: ['人形机器人', '工业机器人'],
  算力: ['智算', '数据中心', 'AI服务器'],
  医药: ['药品', '医疗', '制药'],
  创新药: ['新药', '临床试验', '药物研发'],
  化工: ['化学品', '化工品'],
  航运: ['海运', '集运', '运价', '船运', '港口吞吐'],
  航空: ['航司', '机场', '民航'],
  军工: ['国防军工', '军贸', '装备采购'],
};

const locateEvidence = (
  news: ICausalSignalExtractionNews | undefined,
  evidenceText: string,
): { readonly start: number; readonly end: number } | null => {
  if (!news || evidenceText.trim().length === 0) {
    return null;
  }

  const sourceText = normalizeForSupportCheck(`${news.title}。${news.content}`);
  const evidence = normalizeForSupportCheck(evidenceText);
  const start = sourceText.indexOf(evidence);
  if (start < 0) {
    return null;
  }
  return { start, end: start + evidence.length };
};

const isKeywordSupportedByNews = (
  news: ICausalSignalExtractionNews | undefined,
  keyword: string,
  evidenceText: string,
): boolean => {
  if (!news || keyword.trim().length === 0) {
    return false;
  }
  const normalizedKeyword = normalizeForSupportCheck(keyword);
  const supportText = normalizeForSupportCheck(`${evidenceText}。${news.title}。${news.content}`);
  if (supportText.includes(normalizedKeyword)) {
    return true;
  }
  const synonyms = KEYWORD_SYNONYMS[keyword] ?? [];
  return synonyms.some(synonym => supportText.includes(normalizeForSupportCheck(synonym)));
};

export const validateCausalSignalCandidate = (
  candidate: ICausalSignalCandidateRecord,
  newsById: ReadonlyMap<string, ICausalSignalExtractionNews>,
): ICausalSignalCandidateRecord => {
  const news = newsById.get(candidate.newsId);
  const located = locateEvidence(news, candidate.evidenceText);
  if (!located) {
    return {
      ...candidate,
      status: 'rejected',
      failureReason: 'evidence_text_not_found',
    };
  }

  if (!isKeywordSupportedByNews(news, candidate.assetOrThemeKeyword, candidate.evidenceText)) {
    return {
      ...candidate,
      status: 'rejected',
      evidenceOffsetStart: located.start,
      evidenceOffsetEnd: located.end,
      failureReason: 'keyword_not_supported_by_evidence',
    };
  }

  return {
    ...candidate,
    status: 'candidate',
    evidenceOffsetStart: located.start,
    evidenceOffsetEnd: located.end,
    failureReason: null,
  };
};

const supportsLedgerCache = (prisma: any): boolean => {
  return typeof prisma?.$queryRawUnsafe === 'function' && typeof prisma?.$executeRawUnsafe === 'function';
};

/** v2/v3 协议结果都能作为抽取产物读取；其它版本一律视为不可用缓存。 */
const isSupportedProtocolVersion = (value: unknown): boolean =>
  value === CAUSAL_PROTOCOL_VERSION || value === CAUSAL_PROTOCOL_VERSION_ITEMS;

/**
 * The original news ID is source-local and changes for syndicated copies.  A
 * cache key therefore uses the exact fields supplied to the LLM instead.
 * Prompt/schema and model-chain versions live in the cache source key.
 */
export const createCausalSignalInputFingerprint = (news: ICausalSignalExtractionNews): string => {
  return createHash('sha256').update(JSON.stringify({
    version: 'causal-input-v1',
    title: news.title,
    content: news.content,
    source: news.source,
  })).digest('hex');
};



const buildLlmPrompt = (input: ICausalSignalExtractionInput): string => {
  return [
    '你是股票弱信号结构化抽取器，只输出 JSON。',
    '任务：从新闻中抽取 event -> businessVariable -> assetOrThemeKeyword -> direction。',
    '只抽取原文可支持的经营变量，不要写股票推荐，不要生成股票分数。',
    'direction 只能是 positive, negative, mixed, neutral。',
    '每条 signal 必须包含 newsId,event,businessVariable,assetOrThemeKeyword,direction,confidence,evidenceText,evidenceOffsetStart,evidenceOffsetEnd。',
    'evidenceText 必须是原文片段，offset 是在 title + "。" + content 去空白后的字符区间。',
    '每一条输入新闻必须恰好有一个明确结果：有信号时其 newsId 出现在 signals 中；无信号时其 newsId 出现在 noSignalNewsIds 中。两者不能重叠，不能遗漏或加入未知 newsId。',
    '返回格式：{"signals":[...],"noSignalNewsIds":[...]}。',
    JSON.stringify(input.news.map(news => ({
      newsId: news.id,
      title: news.title,
      content: news.content,
      source: news.source,
    })), null, 2),
  ].join('\n');
};

export class OpenAiCompatibleCausalSignalExtractor implements ICausalSignalExtractor {
  public readonly extractorType = 'llm' as const;
  public readonly modelVersion: string;
  public readonly promptVersion: string;
  public readonly protocolVersion: number;
  public readonly cacheModelVersions?: readonly string[];
  private readonly protocolMode: CausalProtocolMode;
  private readonly client: AiChatClient;
  private readonly maxRequestChars: number;
  private readonly requestTimeoutMs: number;

  public constructor(options: IOpenAiCompatibleCausalSignalExtractorOptions) {
    this.client = AiChatClient.fromOptions(options);
    this.modelVersion = options.client ? `ai-chain:${this.client.fingerprint}` : options.model;
    this.promptVersion = `causal-signal-extraction-v2:outcome-schema-v1:${this.client.fingerprint}`;
    this.protocolMode = options.protocolMode ?? 'legacy';
    this.protocolVersion = toProtocolVersion(this.protocolMode);
    this.cacheModelVersions = options.client ? this.client.modelVersions : undefined;
    this.maxRequestChars = options.maxRequestChars ?? DEFAULT_MAX_LLM_REQUEST_CHARS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  }

  public async extract(input: ICausalSignalExtractionInput): Promise<AiSourcedArray<ICausalSignalCandidateRecord>> {
    if (input.news.length === 0) return [];
    return this.protocolMode === 'items' ? this.extractItems(input) : this.extractLegacy(input);
  }

  /** v3 逐条结果协议：结构/覆盖/证据任一不满足都 throw，绝不部分提交。 */
  private async extractItems(input: ICausalSignalExtractionInput): Promise<AiSourcedArray<ICausalSignalCandidateRecord>> {
    const newsSource = input.news.map(news => ({ id: news.id, title: news.title, content: news.content }));
    const result = await this.client.request({
      label: 'Causal signal AI',
      messages: [
        { role: 'system', content: '你只返回合法 JSON，不做股票推荐，不编造原文不存在的证据。' },
        { role: 'user', content: [buildItemsProtocolInstruction(), JSON.stringify(input.news.map(news => ({
          newsId: news.id,
          title: news.title,
          content: news.content,
          source: news.source,
        })), null, 2)].join('\n') },
      ],
      temperature: 0,
      timeoutMs: this.requestTimeoutMs,
      maxRequestChars: this.maxRequestChars,
      validate: (value): { readonly items: readonly ParsedCausalItem[] } => ({
        items: parseItemsProtocol(value, newsSource),
      }),
    });

    const candidates: ICausalSignalCandidateRecord[] = [];
    for (const item of result.value.items) {
      for (const signal of item.signals) {
        candidates.push({
          traceId: input.traceId,
          asOf: input.asOf,
          clusterKey: input.clusterKey,
          newsId: item.newsId,
          event: signal.event.slice(0, 240),
          businessVariable: signal.businessVariable.slice(0, 80),
          assetOrThemeKeyword: signal.assetOrThemeKeyword.slice(0, 80),
          direction: signal.direction,
          confidence: Math.max(0, Math.min(signal.confidence, 1)),
          evidenceText: signal.evidenceText.slice(0, 500),
          evidenceOffsetStart: signal.evidenceOffsetStart ?? null,
          evidenceOffsetEnd: signal.evidenceOffsetEnd ?? null,
          extractorType: this.extractorType,
          modelVersion: result.source.modelVersion,
          promptVersion: this.promptVersion,
          status: signal.status === 'rejected' ? 'rejected' : 'candidate',
          failureReason: signal.failureReason ?? null,
        } satisfies ICausalSignalCandidateRecord);
      }
    }
    return withAiSource(candidates, result.source, { completedNewsIds: input.news.map(news => news.id) });
  }

  private async extractLegacy(input: ICausalSignalExtractionInput): Promise<AiSourcedArray<ICausalSignalCandidateRecord>> {
    const newsIds = new Set(input.news.map(news => news.id));
    const result = await this.client.request({
      label: 'Causal signal AI',
      messages: [
        { role: 'system', content: '你只返回合法 JSON，不做股票推荐，不编造原文不存在的证据。' },
        { role: 'user', content: buildLlmPrompt(input) },
      ],
      temperature: 0,
      timeoutMs: this.requestTimeoutMs,
      maxRequestChars: this.maxRequestChars,
      validate: (value): { readonly signals: readonly Partial<ICausalSignalCandidateRecord>[]; readonly noSignalNewsIds: readonly string[] } => {
        if (!isAiRecord(value) || !Array.isArray(value.signals) || !Array.isArray(value.noSignalNewsIds)) throw new Error('Missing per-news extraction outcome');
        const signalledNewsIds = new Set<string>();
        for (const signal of value.signals) {
          if (!isAiRecord(signal) || typeof signal.newsId !== 'string' || !newsIds.has(signal.newsId) || typeof signal.event !== 'string'
            || typeof signal.businessVariable !== 'string' || typeof signal.assetOrThemeKeyword !== 'string'
            || !isDirection(signal.direction) || typeof signal.evidenceText !== 'string'
            || typeof signal.confidence !== 'number' || !Number.isFinite(signal.confidence)
            || [signal.evidenceOffsetStart, signal.evidenceOffsetEnd].some(offset => offset != null && (typeof offset !== 'number' || !Number.isFinite(offset)))) throw new Error('Invalid signal');
          signalledNewsIds.add(signal.newsId);
        }
        const noSignalNewsIds = value.noSignalNewsIds;
        if (noSignalNewsIds.some(newsId => typeof newsId !== 'string' || !newsIds.has(newsId))
          || new Set(noSignalNewsIds).size !== noSignalNewsIds.length
          || noSignalNewsIds.some(newsId => signalledNewsIds.has(newsId))
          || signalledNewsIds.size + noSignalNewsIds.length !== newsIds.size) {
          throw new Error('Incomplete per-news extraction outcome');
        }
        return { signals: value.signals, noSignalNewsIds };
      },
    });
    const signals = result.value.signals;

    return withAiSource(signals.flatMap((signal) => {
      if (
        typeof signal.newsId !== 'string'
        || !newsIds.has(signal.newsId)
        || typeof signal.event !== 'string'
        || typeof signal.businessVariable !== 'string'
        || typeof signal.assetOrThemeKeyword !== 'string'
        || !isDirection(signal.direction)
        || typeof signal.evidenceText !== 'string'
      ) {
        return [];
      }

      const confidence = typeof signal.confidence === 'number' && Number.isFinite(signal.confidence)
        ? Math.max(0, Math.min(signal.confidence, 1))
        : 0.5;

      return [{
        traceId: input.traceId,
        asOf: input.asOf,
        clusterKey: input.clusterKey,
        newsId: signal.newsId,
        event: signal.event.slice(0, 240),
        businessVariable: signal.businessVariable.slice(0, 80),
        assetOrThemeKeyword: signal.assetOrThemeKeyword.slice(0, 80),
        direction: signal.direction,
        confidence,
        evidenceText: signal.evidenceText.slice(0, 500),
        evidenceOffsetStart: typeof signal.evidenceOffsetStart === 'number' ? signal.evidenceOffsetStart : null,
        evidenceOffsetEnd: typeof signal.evidenceOffsetEnd === 'number' ? signal.evidenceOffsetEnd : null,
        extractorType: this.extractorType,
        modelVersion: result.source.modelVersion,
        promptVersion: this.promptVersion,
        status: 'candidate',
        failureReason: null,
      } satisfies ICausalSignalCandidateRecord];
    }), result.source, { completedNewsIds: [...newsIds] });
  }
}

const runTasksWithConcurrency = async (
  concurrency: number,
  tasks: (() => Promise<void>)[],
): Promise<void> => {
  let completed = 0;
  let nextIndex = 0;
  let hasFailed = false;
  let activeError: unknown = null;

  if (tasks.length === 0) {
    return;
  }

  return new Promise<void>((resolve, reject) => {
    const runNext = () => {
      if (hasFailed) {
        reject(activeError);
        return;
      }
      if (completed === tasks.length) {
        resolve();
        return;
      }

      while (nextIndex < tasks.length && nextIndex - completed < concurrency) {
        const currentIndex = nextIndex;
        nextIndex++;

        tasks[currentIndex]()
          .then(() => {
            completed++;
            runNext();
          })
          .catch((error) => {
            hasFailed = true;
            activeError = error;
            reject(error);
          });
      }
    };

    runNext();
  });
};

export class CausalSignalExtractionService {
  public constructor(private readonly extractor: ICausalSignalExtractor) {}

  public async execute(prisma: any, input: ICausalSignalExtractionInput): Promise<ICausalSignalExtractionResult> {
    const failures: string[] = [];
    let candidates: readonly ICausalSignalCandidateRecord[] = [];
    let insertedCount = 0;
    let cacheHitCount = 0;
    try {
      const batchSize = Math.max(1, Math.min(input.batchSize ?? 8, 50));
      const batchCount = Math.ceil(input.news.length / batchSize);
      const extracted: ICausalSignalCandidateRecord[] = [];
      const newsById = new Map(input.news.map(news => [news.id, news]));
      // Recursive helper for dynamic batching on failure
      const extractWithDynamicBatching = async (
        toExtract: readonly ICausalSignalExtractionNews[]
      ): Promise<AiSourcedArray<ICausalSignalCandidateRecord>> => {
        if (toExtract.length === 0) {
          return [];
        }
        try {
          return await this.extractor.extract({
            ...input,
            news: toExtract,
          });
        } catch (error) {
          if (error instanceof AiCandidatesExhaustedError || error instanceof AiInputError) throw error;
          if (toExtract.length > 1) {
            const mid = Math.floor(toExtract.length / 2);
            const left = toExtract.slice(0, mid);
            const right = toExtract.slice(mid);
            console.warn(
              `[CausalSignalExtractionService] AI extraction failed for batch size ${toExtract.length}. Splitting into sizes ${left.length} and ${right.length}. Error: ${error instanceof Error ? error.message : String(error)}`
            );
            const leftResult = await extractWithDynamicBatching(left);
            const rightResult = await extractWithDynamicBatching(right);
            const combined = [...leftResult, ...rightResult];
            const completedNewsIds = [
              ...(leftResult.completedNewsIds ?? []),
              ...(rightResult.completedNewsIds ?? []),
            ];
            if (leftResult.aiSource ?? rightResult.aiSource) {
              return withAiSource(combined, leftResult.aiSource ?? rightResult.aiSource!, { completedNewsIds });
            }
            return Object.defineProperty(combined, 'completedNewsIds', {
              value: completedNewsIds,
              enumerable: false,
            }) as AiSourcedArray<ICausalSignalCandidateRecord>;
          }
          throw error;
        }
      };

      // Load all cached candidates upfront to avoid N+1 queries in the loop
      const globalCached = await this.loadCachedCandidates(prisma, input, input.news, newsById);
      cacheHitCount += globalCached.cacheHitCount;

      const tasks: (() => Promise<void>)[] = [];
      let activeInsertedCount = 0;

      for (let index = 0; index < input.news.length; index += batchSize) {
        const batchIndex = Math.floor(index / batchSize) + 1;
        tasks.push(async () => {
          const batchNews = input.news.slice(index, index + batchSize);
          const startedAt = Date.now();
          
          const batchCachedCandidates = globalCached.candidates.filter(c => batchNews.some(n => n.id === c.newsId));
          const newsToExtract = batchNews.filter(news => !globalCached.completedNewsIds.has(news.id));
          
          const freshBatch = await extractWithDynamicBatching(newsToExtract);
          if (
            this.extractor.extractorType === 'llm'
            && newsToExtract.length > 0
            && (!freshBatch.completedNewsIds
              || freshBatch.completedNewsIds.length !== newsToExtract.length
              || new Set(freshBatch.completedNewsIds).size !== newsToExtract.length
              || newsToExtract.some(news => !freshBatch.completedNewsIds!.includes(news.id)))
          ) {
            throw new AiInputError('LLM extraction response did not provide an outcome for every input news item');
          }
          const batch = [...batchCachedCandidates, ...freshBatch]
            .map(candidate => validateCausalSignalCandidate(candidate, newsById));
          input.onBatchComplete?.({
            batchIndex,
            batchCount,
            batchSize: batchNews.length,
            elapsedMs: Date.now() - startedAt,
            signalCount: batch.length,
          });
          const persist = async (tx: any): Promise<void> => {
          if (batch.length > 0) {
            const result = await tx.causalSignalCandidate.createMany({
              data: batch.map(candidate => ({
                traceId: candidate.traceId,
                asOf: candidate.asOf,
                clusterKey: candidate.clusterKey,
                newsId: candidate.newsId,
                event: candidate.event,
                businessVariable: candidate.businessVariable,
                assetOrThemeKeyword: candidate.assetOrThemeKeyword,
                direction: candidate.direction,
                confidence: new Prisma.Decimal(candidate.confidence),
                evidenceText: candidate.evidenceText,
                evidenceOffsetStart: candidate.evidenceOffsetStart,
                evidenceOffsetEnd: candidate.evidenceOffsetEnd,
                extractorType: candidate.extractorType,
                modelVersion: candidate.modelVersion,
                promptVersion: candidate.promptVersion,
                inputFingerprint: createCausalSignalInputFingerprint(newsById.get(candidate.newsId)!),
                status: candidate.status,
                failureReason: candidate.failureReason,
              })),
              skipDuplicates: true,
            });
            activeInsertedCount += result.count;
          }
          await this.recordExtractionCache(
            tx,
            input,
            newsToExtract,
            batch,
            new Set(freshBatch.completedNewsIds ?? newsToExtract.map(news => news.id)),
            freshBatch.aiSource,
          );
          };
          if (prisma.$transaction) await prisma.$transaction(persist);
          else await persist(prisma);
          extracted.push(...batch);
        });
      }

      const concurrency = Math.max(1, Math.min(input.concurrency ?? 20, 50));
      await runTasksWithConcurrency(concurrency, tasks);
      insertedCount = activeInsertedCount;
      candidates = extracted;
    }
    catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      throw error;
    }

    const acceptedCount = candidates.filter(candidate => candidate.status === 'candidate').length;
    const rejectedCount = candidates.filter(candidate => candidate.status === 'rejected').length;

    return {
      candidateCount: candidates.length,
      acceptedCount,
      rejectedCount,
      cacheHitCount,
      insertedCount,
      extractorType: this.extractor.extractorType,
      failures,
      sample: candidates.slice(0, 10).map(candidate => ({
        newsId: candidate.newsId,
        businessVariable: candidate.businessVariable,
        assetOrThemeKeyword: candidate.assetOrThemeKeyword,
        direction: candidate.direction,
        confidence: candidate.confidence,
        evidenceText: candidate.evidenceText,
        extractorType: candidate.extractorType,
        status: candidate.status,
        failureReason: candidate.failureReason,
      })),
    };
  }

  private async loadCachedCandidates(
    prisma: any,
    input: ICausalSignalExtractionInput,
    news: readonly ICausalSignalExtractionNews[],
    newsById: ReadonlyMap<string, ICausalSignalExtractionNews>,
  ): Promise<{
    readonly candidates: readonly ICausalSignalCandidateRecord[];
    readonly cacheHitCount: number;
    readonly completedNewsIds: ReadonlySet<string>;
  }> {
    const ledgerCache = await this.loadCachedCandidatesFromLedger(prisma, input, news, newsById);
    if (supportsLedgerCache(prisma) || !prisma.causalSignalCandidate?.findMany || news.length === 0) {
      return {
        candidates: ledgerCache.candidates,
        cacheHitCount: ledgerCache.completedNewsIds.size,
        completedNewsIds: ledgerCache.completedNewsIds,
      };
    }

    const fingerprintToNews = new Map<string, ICausalSignalExtractionNews[]>();
    for (const item of news) {
      const fingerprint = createCausalSignalInputFingerprint(item);
      const matching = fingerprintToNews.get(fingerprint) ?? [];
      matching.push(item);
      fingerprintToNews.set(fingerprint, matching);
    }
    const rows = await prisma.causalSignalCandidate.findMany({
      where: {
        clusterKey: input.clusterKey,
        inputFingerprint: { in: [...fingerprintToNews.keys()] },
        extractorType: this.extractor.extractorType,
        modelVersion: this.extractor.cacheModelVersions ? { in: this.extractor.cacheModelVersions } : this.extractor.modelVersion,
        promptVersion: this.extractor.promptVersion,
        asOf: { lte: input.asOf },
      },
    });
    if (!Array.isArray(rows) || rows.length === 0) {
      return {
        candidates: ledgerCache.candidates,
        cacheHitCount: ledgerCache.completedNewsIds.size,
        completedNewsIds: ledgerCache.completedNewsIds,
      };
    }

    const candidatesByKey = new Map<string, ICausalSignalCandidateRecord>();
    for (const candidate of ledgerCache.candidates) {
      const key = [
        candidate.newsId,
        candidate.businessVariable,
        candidate.assetOrThemeKeyword,
        candidate.extractorType,
      ].join(':');
      candidatesByKey.set(key, candidate);
    }
    for (const row of rows) {
      const matchingNews = fingerprintToNews.get(String(row.inputFingerprint)) ?? [];
      for (const currentNews of matchingNews) {
        const candidate = {
          traceId: input.traceId,
          asOf: input.asOf,
          clusterKey: input.clusterKey,
          newsId: currentNews.id,
          event: String(row.event),
          businessVariable: String(row.businessVariable),
          assetOrThemeKeyword: String(row.assetOrThemeKeyword),
          direction: isDirection(row.direction) ? row.direction : 'neutral',
          confidence: Number(row.confidence),
          evidenceText: String(row.evidenceText),
          evidenceOffsetStart: row.evidenceOffsetStart ?? null,
          evidenceOffsetEnd: row.evidenceOffsetEnd ?? null,
          extractorType: this.extractor.extractorType,
          modelVersion: String(row.modelVersion),
          promptVersion: this.extractor.promptVersion,
          status: row.status === 'rejected' ? 'rejected' : 'candidate',
          failureReason: row.failureReason ?? null,
        } satisfies ICausalSignalCandidateRecord;
        const key = [
          candidate.newsId,
          candidate.businessVariable,
          candidate.assetOrThemeKeyword,
          candidate.extractorType,
        ].join(':');
        const revalidated = validateCausalSignalCandidate(candidate, newsById);
        if (!candidatesByKey.has(key)) {
          candidatesByKey.set(key, revalidated);
        }
      }
    }
    const candidates = [...candidatesByKey.values()];
    const completedNewsIds = new Set([
      ...ledgerCache.completedNewsIds,
      ...candidates.map(candidate => candidate.newsId),
    ]);

    return {
      candidates,
      cacheHitCount: completedNewsIds.size,
      completedNewsIds,
    };
  }

  private async loadCachedCandidatesFromLedger(
    prisma: any,
    input: ICausalSignalExtractionInput,
    news: readonly ICausalSignalExtractionNews[],
    newsById: ReadonlyMap<string, ICausalSignalExtractionNews>,
  ): Promise<{
    readonly candidates: readonly ICausalSignalCandidateRecord[];
    readonly completedNewsIds: ReadonlySet<string>;
  }> {
    if (!supportsLedgerCache(prisma) || news.length === 0) {
      return { candidates: [], completedNewsIds: new Set() };
    }

    const fingerprintToNews = new Map<string, ICausalSignalExtractionNews[]>();
    for (const item of news) {
      const fingerprint = createCausalSignalInputFingerprint(item);
      const matching = fingerprintToNews.get(fingerprint) ?? [];
      matching.push(item);
      fingerprintToNews.set(fingerprint, matching);
    }
    const rows = await prisma.$queryRawUnsafe(
      'SELECT "bucketKey", summary FROM "DataRefreshLedger" WHERE "dataKind" = $1 AND source = $2 AND "clusterKey" = $3 AND "bucketKey" = ANY($4::text[]) AND status = $5 AND "expiresAt" > $6 AND "fetchedAt" <= $6',
      'causal_signal_extraction', this.cacheSourceKey, input.clusterKey, [...fingerprintToNews.keys()], 'success', input.asOf,
    ) as readonly { bucketKey: string; summary: unknown }[];
    const completedNewsIds = new Set<string>();
    const candidates: ICausalSignalCandidateRecord[] = [];
    for (const row of rows) {
      const matchingNews = fingerprintToNews.get(String(row.bucketKey));
      if (!matchingNews) continue;
      let summary: unknown = row.summary;
      if (typeof summary === 'string') {
        try { summary = JSON.parse(summary); } catch { continue; }
      }
      if (!isAiRecord(summary) || !isSupportedProtocolVersion(summary.protocolVersion) || !Array.isArray(summary.signals)) continue;
      const accepted = summary.signals.every(signal => isAiRecord(signal)
        && typeof signal.event === 'string'
        && typeof signal.businessVariable === 'string'
        && typeof signal.assetOrThemeKeyword === 'string'
        && isDirection(signal.direction)
        && typeof signal.confidence === 'number'
        && Number.isFinite(signal.confidence)
        && typeof signal.evidenceText === 'string');
      if (!accepted) continue;
      for (const currentNews of matchingNews) {
        completedNewsIds.add(currentNews.id);
        for (const signal of summary.signals as readonly Record<string, unknown>[]) {
          const candidate = validateCausalSignalCandidate({
            traceId: input.traceId,
            asOf: input.asOf,
            clusterKey: input.clusterKey,
            newsId: currentNews.id,
            event: String(signal.event),
            businessVariable: String(signal.businessVariable),
            assetOrThemeKeyword: String(signal.assetOrThemeKeyword),
            direction: signal.direction as CausalSignalDirection,
            confidence: Number(signal.confidence),
            evidenceText: String(signal.evidenceText),
            evidenceOffsetStart: typeof signal.evidenceOffsetStart === 'number' ? signal.evidenceOffsetStart : null,
            evidenceOffsetEnd: typeof signal.evidenceOffsetEnd === 'number' ? signal.evidenceOffsetEnd : null,
            extractorType: this.extractor.extractorType,
            modelVersion: typeof summary.modelVersion === 'string' ? summary.modelVersion : this.extractor.modelVersion,
            promptVersion: this.extractor.promptVersion,
            status: signal.status === 'rejected' ? 'rejected' : 'candidate',
            failureReason: typeof signal.failureReason === 'string' ? signal.failureReason : null,
          }, newsById);
          candidates.push(candidate);
        }
      }
    }
    return { candidates, completedNewsIds };
  }

  private async recordExtractionCache(
    prisma: any,
    input: ICausalSignalExtractionInput,
    extractedNews: readonly ICausalSignalExtractionNews[],
    batchCandidates: readonly ICausalSignalCandidateRecord[],
    completedNewsIds: ReadonlySet<string>,
    aiSource?: IAiSource,
  ): Promise<void> {
    if (!supportsLedgerCache(prisma) || extractedNews.length === 0) {
      return;
    }

    const ledger = new DataRefreshLedgerService();
    for (const news of extractedNews) {
      if (!completedNewsIds.has(news.id)) {
        continue;
      }
      const candidatesForNews = batchCandidates.filter(candidate => candidate.newsId === news.id);
      await ledger.recordSuccess(prisma, {
        dataKind: 'causal_signal_extraction',
        source: this.cacheSourceKey,
        clusterKey: input.clusterKey,
        bucketKey: createCausalSignalInputFingerprint(news),
        fetchedAt: input.asOf,
        expiresAt: LLM_CACHE_EXPIRES_AT,
        traceId: input.traceId,
        summary: {
          protocolVersion: this.extractor.protocolVersion ?? CAUSAL_PROTOCOL_VERSION,
          outcome: candidatesForNews.length > 0 ? 'signals' : 'no_signal',
          signalCount: candidatesForNews.length,
          acceptedCount: candidatesForNews.filter(candidate => candidate.status === 'candidate').length,
          rejectedCount: candidatesForNews.filter(candidate => candidate.status === 'rejected').length,
          modelVersion: aiSource?.modelVersion ?? this.extractor.modelVersion,
          ...(aiSource ? { providerId: aiSource.providerId, model: aiSource.model } : {}),
          promptVersion: this.extractor.promptVersion,
          signals: candidatesForNews.map(candidate => ({
            event: candidate.event,
            businessVariable: candidate.businessVariable,
            assetOrThemeKeyword: candidate.assetOrThemeKeyword,
            direction: candidate.direction,
            confidence: candidate.confidence,
            evidenceText: candidate.evidenceText,
            evidenceOffsetStart: candidate.evidenceOffsetStart ?? null,
            evidenceOffsetEnd: candidate.evidenceOffsetEnd ?? null,
            status: candidate.status,
            failureReason: candidate.failureReason ?? null,
          })),
        },
      });
    }
  }

  private get cacheSourceKey(): string {
    const base = [
      this.extractor.extractorType,
      this.extractor.modelVersion,
      this.extractor.promptVersion,
    ].join(':');
    const protocol = this.extractor.protocolVersion ?? CAUSAL_PROTOCOL_VERSION;
    return protocol === CAUSAL_PROTOCOL_VERSION ? base : `${base}:protocol-${protocol}`;
  }
}

export const createCausalSignalExtractorFromEnv = (
  environment: NodeJS.ProcessEnv = process.env,
): ICausalSignalExtractor => {
  if (environment.CAUSAL_SIGNAL_EXTRACTOR === 'llm') {
    const protocolMode: CausalProtocolMode = environment.CAUSAL_PROTOCOL_MODE === 'legacy' ? 'legacy' : 'items';
    return new OpenAiCompatibleCausalSignalExtractor({
      ...createAiOptionsFromEnv(environment),
      protocolMode,
      maxRequestChars: Number(environment.CAUSAL_SIGNAL_LLM_MAX_REQUEST_CHARS ?? DEFAULT_MAX_LLM_REQUEST_CHARS),
      requestTimeoutMs: Number(environment.CAUSAL_SIGNAL_LLM_REQUEST_TIMEOUT_MS ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS),
    });
  }

  if (environment.CAUSAL_SIGNAL_EXTRACTOR === 'rule') {
    return new RuleCausalSignalExtractor();
  }

  throw new Error('Missing CAUSAL_SIGNAL_EXTRACTOR. Set it to llm for AI extraction or rule for explicit non-LLM tests; no implicit fallback is allowed.');
};
