import { Prisma } from '@prisma/client';
import { DataRefreshLedgerService } from './data-refresh-ledger-service.js';

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
  extract: (input: ICausalSignalExtractionInput) => Promise<readonly ICausalSignalCandidateRecord[]>;
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

interface IOpenAiCompatibleMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

interface IOpenAiCompatibleChoice {
  readonly message?: {
    readonly content?: string;
  };
}

interface IOpenAiCompatibleResponse {
  readonly choices?: readonly IOpenAiCompatibleChoice[];
}

interface ILlmSignalEnvelope {
  readonly signals?: readonly Partial<ICausalSignalCandidateRecord>[];
}

interface IOpenAiCompatibleCausalSignalExtractorOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly maxRequestChars?: number;
  readonly requestTimeoutMs?: number;
  readonly maxTokens?: number;
}

const extractJsonObject = (content: string): string => {
  const fenced = content.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return content.slice(firstBrace, lastBrace + 1);
  }

  return content.trim();
};

const normalizeBaseUrl = (value: string): string => value.endsWith('/') ? value.slice(0, -1) : value;

const isDirection = (value: unknown): value is CausalSignalDirection => {
  return value === 'positive' || value === 'negative' || value === 'mixed' || value === 'neutral';
};

const isRetryableAiStatus = (status: number): boolean => {
  return status === 429 || status === 502 || status === 503 || status === 504;
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const DEFAULT_MAX_LLM_REQUEST_CHARS = 240_000;
const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LLM_MAX_TOKENS = 4096;
const DEFAULT_LLM_NEWS_CONTENT_CHARS = 240;
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

const validateCausalSignalCandidate = (
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

const truncateNewsContentForPrompt = (value: string): string => {
  return value.length > DEFAULT_LLM_NEWS_CONTENT_CHARS
    ? value.slice(0, DEFAULT_LLM_NEWS_CONTENT_CHARS)
    : value;
};

const buildLlmPrompt = (input: ICausalSignalExtractionInput): string => {
  return [
    '你是股票弱信号结构化抽取器，只输出 JSON。',
    '任务：从新闻中抽取 event -> businessVariable -> assetOrThemeKeyword -> direction。',
    '只抽取原文可支持的经营变量，不要写股票推荐，不要生成股票分数。',
    'direction 只能是 positive, negative, mixed, neutral。',
    '每条 signal 必须包含 newsId,event,businessVariable,assetOrThemeKeyword,direction,confidence,evidenceText,evidenceOffsetStart,evidenceOffsetEnd。',
    'evidenceText 必须是原文片段，offset 是在 title + "。" + content 去空白后的字符区间。',
    '返回格式：{"signals":[...]}。',
    JSON.stringify(input.news.map(news => ({
      newsId: news.id,
      title: news.title,
      content: truncateNewsContentForPrompt(news.content),
      source: news.source,
    })), null, 2),
  ].join('\n');
};

export class OpenAiCompatibleCausalSignalExtractor implements ICausalSignalExtractor {
  public readonly extractorType = 'llm' as const;
  public readonly modelVersion: string;
  public readonly promptVersion = 'causal-signal-extraction-v1';
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRequestChars: number;
  private readonly requestTimeoutMs: number;
  private readonly maxTokens: number;

  public constructor(private readonly options: IOpenAiCompatibleCausalSignalExtractorOptions) {
    this.modelVersion = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = Math.max(0, Math.min(options.maxRetries ?? 2, 5));
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 800);
    this.maxRequestChars = Math.max(1, options.maxRequestChars ?? DEFAULT_MAX_LLM_REQUEST_CHARS);
    this.requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    this.maxTokens = Math.max(256, options.maxTokens ?? DEFAULT_LLM_MAX_TOKENS);
  }

  public async extract(input: ICausalSignalExtractionInput): Promise<readonly ICausalSignalCandidateRecord[]> {
    if (input.news.length === 0) {
      return [];
    }

    const userPrompt = buildLlmPrompt(input);
    const requestBody = JSON.stringify({
      model: this.options.model,
      temperature: 0,
      max_tokens: this.maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: '你只返回合法 JSON，不做股票推荐，不编造原文不存在的证据。',
        } satisfies IOpenAiCompatibleMessage,
        {
          role: 'user',
          content: userPrompt,
        } satisfies IOpenAiCompatibleMessage,
      ],
    });

    if (userPrompt.length > this.maxRequestChars || requestBody.length > this.maxRequestChars) {
      throw new Error(
        `Causal signal AI request too large: promptChars=${userPrompt.length}, bodyChars=${requestBody.length}, maxRequestChars=${this.maxRequestChars}`,
      );
    }

    let response: Response | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        response = await this.fetchImpl(`${normalizeBaseUrl(this.options.baseUrl)}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.options.apiKey}`,
          },
          signal: controller.signal,
          body: requestBody,
        });
      }
      catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          if (attempt === this.maxRetries) {
            throw new Error(`Causal signal AI request timed out after ${this.requestTimeoutMs}ms`);
          }
          await sleep(this.retryDelayMs * 2 ** attempt);
          continue;
        }
        throw error;
      }
      finally {
        clearTimeout(timeout);
      }

      if (response.ok || !isRetryableAiStatus(response.status) || attempt === this.maxRetries) {
        break;
      }

      await sleep(this.retryDelayMs * 2 ** attempt);
    }

    if (!response?.ok) {
      throw new Error(`Causal signal AI request failed with HTTP ${response?.status ?? 'unknown'}`);
    }

    const payload = await response.json() as IOpenAiCompatibleResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Causal signal AI response missing message content');
    }

    const parsed = JSON.parse(extractJsonObject(content)) as ILlmSignalEnvelope;
    const signals = parsed.signals ?? [];
    const newsIds = new Set(input.news.map(news => news.id));

    return signals.flatMap((signal) => {
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
        modelVersion: this.modelVersion,
        promptVersion: this.promptVersion,
        status: 'candidate',
        failureReason: null,
      } satisfies ICausalSignalCandidateRecord];
    });
  }
}

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
      for (let index = 0; index < input.news.length; index += batchSize) {
        const batchNews = input.news.slice(index, index + batchSize);
        const startedAt = Date.now();
        const cachedBatch = await this.loadCachedCandidates(prisma, input, batchNews, newsById);
        cacheHitCount += cachedBatch.cacheHitCount;
        const newsToExtract = batchNews.filter(news => !cachedBatch.completedNewsIds.has(news.id));
        const freshBatch = newsToExtract.length === 0
          ? []
          : await this.extractor.extract({
              ...input,
              news: newsToExtract,
            });
        const batch = [...cachedBatch.candidates, ...freshBatch]
          .map(candidate => validateCausalSignalCandidate(candidate, newsById));
        await this.recordExtractionCache(prisma, input, newsToExtract, batch);
        input.onBatchComplete?.({
          batchIndex: Math.floor(index / batchSize) + 1,
          batchCount,
          batchSize: batchNews.length,
          elapsedMs: Date.now() - startedAt,
          signalCount: batch.length,
        });
        if (batch.length > 0) {
          const result = await prisma.causalSignalCandidate.createMany({
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
              status: candidate.status,
              failureReason: candidate.failureReason,
            })),
            skipDuplicates: true,
          });
          insertedCount += result.count;
        }
        extracted.push(...batch);
      }
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
    const ledgerCompletedNewsIds = await this.loadCompletedNewsIdsFromLedger(prisma, input, news);
    if (!prisma.causalSignalCandidate?.findMany || news.length === 0) {
      return {
        candidates: [],
        cacheHitCount: ledgerCompletedNewsIds.size,
        completedNewsIds: ledgerCompletedNewsIds,
      };
    }

    const newsIds = news.map(item => item.id);
    const rows = await prisma.causalSignalCandidate.findMany({
      where: {
        clusterKey: input.clusterKey,
        newsId: { in: newsIds },
        extractorType: this.extractor.extractorType,
        modelVersion: this.extractor.modelVersion,
        promptVersion: this.extractor.promptVersion,
      },
    });
    if (!Array.isArray(rows) || rows.length === 0) {
      return {
        candidates: [],
        cacheHitCount: ledgerCompletedNewsIds.size,
        completedNewsIds: ledgerCompletedNewsIds,
      };
    }

    const candidatesByKey = new Map<string, ICausalSignalCandidateRecord>();
    for (const row of rows) {
      const candidate = {
        traceId: input.traceId,
        asOf: input.asOf,
        clusterKey: input.clusterKey,
        newsId: String(row.newsId),
        event: String(row.event),
        businessVariable: String(row.businessVariable),
        assetOrThemeKeyword: String(row.assetOrThemeKeyword),
        direction: isDirection(row.direction) ? row.direction : 'neutral',
        confidence: Number(row.confidence),
        evidenceText: String(row.evidenceText),
        evidenceOffsetStart: row.evidenceOffsetStart ?? null,
        evidenceOffsetEnd: row.evidenceOffsetEnd ?? null,
        extractorType: this.extractor.extractorType,
        modelVersion: this.extractor.modelVersion,
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
    const candidates = [...candidatesByKey.values()];
    const completedNewsIds = new Set([
      ...ledgerCompletedNewsIds,
      ...candidates.map(candidate => candidate.newsId),
    ]);

    return {
      candidates,
      cacheHitCount: completedNewsIds.size,
      completedNewsIds,
    };
  }

  private async loadCompletedNewsIdsFromLedger(
    prisma: any,
    input: ICausalSignalExtractionInput,
    news: readonly ICausalSignalExtractionNews[],
  ): Promise<ReadonlySet<string>> {
    if (!supportsLedgerCache(prisma) || news.length === 0) {
      return new Set();
    }

    const ledger = new DataRefreshLedgerService();
    const completed = new Set<string>();
    for (const item of news) {
      const cached = await ledger.getValid(prisma, {
        dataKind: 'causal_signal_extraction',
        source: this.cacheSourceKey,
        clusterKey: input.clusterKey,
        bucketKey: item.id,
      }, input.asOf);
      if (cached) {
        completed.add(item.id);
      }
    }
    return completed;
  }

  private async recordExtractionCache(
    prisma: any,
    input: ICausalSignalExtractionInput,
    extractedNews: readonly ICausalSignalExtractionNews[],
    batchCandidates: readonly ICausalSignalCandidateRecord[],
  ): Promise<void> {
    if (!supportsLedgerCache(prisma) || extractedNews.length === 0) {
      return;
    }

    const ledger = new DataRefreshLedgerService();
    for (const news of extractedNews) {
      const candidatesForNews = batchCandidates.filter(candidate => candidate.newsId === news.id);
      await ledger.recordSuccess(prisma, {
        dataKind: 'causal_signal_extraction',
        source: this.cacheSourceKey,
        clusterKey: input.clusterKey,
        bucketKey: news.id,
        fetchedAt: input.asOf,
        expiresAt: LLM_CACHE_EXPIRES_AT,
        traceId: input.traceId,
        summary: {
          signalCount: candidatesForNews.length,
          acceptedCount: candidatesForNews.filter(candidate => candidate.status === 'candidate').length,
          rejectedCount: candidatesForNews.filter(candidate => candidate.status === 'rejected').length,
          modelVersion: this.extractor.modelVersion,
          promptVersion: this.extractor.promptVersion,
        },
      });
    }
  }

  private get cacheSourceKey(): string {
    return [
      this.extractor.extractorType,
      this.extractor.modelVersion,
      this.extractor.promptVersion,
    ].join(':');
  }
}

export const createCausalSignalExtractorFromEnv = (
  environment: NodeJS.ProcessEnv = process.env,
): ICausalSignalExtractor => {
  if (environment.CAUSAL_SIGNAL_EXTRACTOR === 'llm') {
    const baseUrl = environment.LLM_SMART_BASE_URL;
    const apiKey = environment.LLM_SMART_API_KEY;
    const model = environment.LLM_SMART_MODEL;
    if (!baseUrl || !apiKey || !model) {
      throw new Error('CAUSAL_SIGNAL_EXTRACTOR=llm requires LLM_SMART_BASE_URL, LLM_SMART_API_KEY and LLM_SMART_MODEL');
    }
    const maxRetries = Number(environment.CAUSAL_SIGNAL_LLM_MAX_RETRIES ?? 2);
    const retryDelayMs = Number(environment.CAUSAL_SIGNAL_LLM_RETRY_DELAY_MS ?? 800);
    const maxRequestChars = Number(environment.CAUSAL_SIGNAL_LLM_MAX_REQUEST_CHARS ?? DEFAULT_MAX_LLM_REQUEST_CHARS);
    const requestTimeoutMs = Number(environment.CAUSAL_SIGNAL_LLM_REQUEST_TIMEOUT_MS ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    const maxTokens = Number(environment.CAUSAL_SIGNAL_LLM_MAX_TOKENS ?? DEFAULT_LLM_MAX_TOKENS);
    return new OpenAiCompatibleCausalSignalExtractor({
      baseUrl,
      apiKey,
      model,
      maxRetries: Number.isFinite(maxRetries) ? maxRetries : 2,
      retryDelayMs: Number.isFinite(retryDelayMs) ? retryDelayMs : 800,
      maxRequestChars: Number.isFinite(maxRequestChars) ? maxRequestChars : DEFAULT_MAX_LLM_REQUEST_CHARS,
      requestTimeoutMs: Number.isFinite(requestTimeoutMs) ? requestTimeoutMs : DEFAULT_LLM_REQUEST_TIMEOUT_MS,
      maxTokens: Number.isFinite(maxTokens) ? maxTokens : DEFAULT_LLM_MAX_TOKENS,
    });
  }

  if (environment.CAUSAL_SIGNAL_EXTRACTOR === 'rule') {
    return new RuleCausalSignalExtractor();
  }

  throw new Error('Missing CAUSAL_SIGNAL_EXTRACTOR. Set it to llm for AI extraction or rule for explicit non-LLM tests; no implicit fallback is allowed.');
};
