import { fetchWithRetry } from './ai-client-utils.js';

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_REQUEST_CHARS = 240000;
const KEYWORDS_PER_STOCK = 5;
const SOURCE = 'ai_generated_stock_knowledge';
const SOURCE_NAME = 'AI 生成股票知识关键词';
const PROMPT_VERSION = 'ai-stock-keyword-generation-v1';

const EXPOSURE_TYPES = [
  'industry_exposure',
  'business_exposure',
  'product_exposure',
  'concept_exposure',
  'risk_exposure',
] as const;

type AiStockKeywordExposureType = typeof EXPOSURE_TYPES[number];

interface IStockRow {
  readonly symbol: string;
  readonly name: string;
  readonly industry?: string | null;
  readonly clusterKey?: string;
}

interface IAiKeywordDraft {
  readonly keyword?: unknown;
  readonly exposureType?: unknown;
  readonly confidence?: unknown;
  readonly reason?: unknown;
}

interface IAiStockKeywordDraft {
  readonly symbol?: unknown;
  readonly stockName?: unknown;
  readonly keywords?: readonly IAiKeywordDraft[];
}

interface IAiStockKeywordPayload {
  readonly stocks?: readonly IAiStockKeywordDraft[];
}

interface IOpenAiCompatibleMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

interface IOpenAiCompatibleChoice {
  readonly message?: {
    readonly content?: unknown;
  };
}

interface IOpenAiCompatibleResponse {
  readonly choices?: readonly IOpenAiCompatibleChoice[];
}

interface IAiStockKeywordRequestInput {
  readonly stocks: readonly IStockRow[];
  readonly prompt: string;
  readonly promptVersion: string;
  readonly model: string;
}

interface IAiStockKeywordRequester {
  readonly model: string;
  readonly requestKeywords: (input: IAiStockKeywordRequestInput) => Promise<IAiStockKeywordPayload>;
}

interface IOpenAiCompatibleStockKeywordRequesterOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
}

export interface IAiStockKeywordGenerationOptions {
  readonly clusterKey: string;
  readonly asOf: Date;
  readonly limit?: number;
  readonly skip?: number;
  readonly batchSize?: number;
  readonly symbolFilter?: readonly string[];
  readonly dryRun?: boolean;
  readonly maxRequestChars?: number;
  readonly onProgress?: (message: string) => void;
}

export interface IAiStockKeywordGenerationResult {
  readonly stockCount: number;
  readonly batchCount: number;
  readonly generatedKeywordCount: number;
  readonly insertedCount: number;
  readonly skippedInvalidKeywordCount: number;
  readonly dryRun: boolean;
  readonly source: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly exposureTypeCounts: Record<string, number>;
  readonly sample: readonly Record<string, unknown>[];
}

interface IValidatedKeywordRow {
  readonly clusterKey: string;
  readonly symbol: string;
  readonly stockName: string;
  readonly keyword: string;
  readonly exposureType: AiStockKeywordExposureType;
  readonly source: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly confidence: number;
  readonly evidenceJson: Record<string, unknown>;
  readonly validFrom: Date;
  readonly status: 'active';
}

const isExposureType = (value: unknown): value is AiStockKeywordExposureType => {
  return typeof value === 'string' && (EXPOSURE_TYPES as readonly string[]).includes(value);
};

const toCleanString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toConfidence = (value: unknown): number | null => {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0 || numberValue > 1) {
    return null;
  }
  return numberValue;
};

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/u, '');

const extractJsonObject = (content: string): string => {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const candidate = fenced?.[1] ?? content;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error('AI stock keyword response does not contain JSON object');
  }
  return candidate.slice(start, end + 1);
};

const buildPrompt = (stocks: readonly IStockRow[]): string => {
  return [
    '你是A股股票知识库标注员。请只基于公开常识和股票名称/行业，为每只股票生成5个高置信关键词。',
    '必须返回严格JSON，不要Markdown，不要解释。',
    '每只股票必须尽量各返回1条 industry_exposure、business_exposure、product_exposure、concept_exposure、risk_exposure。',
    '不要编造新闻，不要写新闻证据。keyword要短，适合和新闻主题匹配。',
    'JSON结构：{"stocks":[{"symbol":"000001","stockName":"平安银行","keywords":[{"keyword":"银行","exposureType":"industry_exposure","confidence":0.95,"reason":"所属行业"}]}]}',
    `允许的exposureType：${EXPOSURE_TYPES.join(', ')}`,
    `股票列表：${JSON.stringify(stocks.map(stock => ({
      symbol: stock.symbol,
      stockName: stock.name,
      industry: stock.industry ?? null,
    })))}`,
  ].join('\n');
};

const countByExposureType = (rows: readonly IValidatedKeywordRow[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.exposureType] = (counts[row.exposureType] ?? 0) + 1;
  }
  return counts;
};

export class OpenAiCompatibleStockKeywordRequester implements IAiStockKeywordRequester {
  public readonly model: string;

  private readonly baseUrl: string;

  public constructor(private readonly options: IOpenAiCompatibleStockKeywordRequesterOptions) {
    this.model = options.model;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
  }

  public async requestKeywords(input: IAiStockKeywordRequestInput): Promise<IAiStockKeywordPayload> {
    const messages: IOpenAiCompatibleMessage[] = [
      {
        role: 'system',
        content: '你只输出严格JSON。任何不确定的内容要用较低confidence表达，但不能伪造新闻证据。',
      },
      {
        role: 'user',
        content: input.prompt,
      },
    ];
    const body = JSON.stringify({
      model: this.options.model,
      messages,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });

    let response: Response;
    try {
      response = await fetchWithRetry(
        `${this.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
        },
        {
          maxRetries: 3,
          requestTimeoutMs: this.options.timeoutMs ?? 60000,
        }
      );
    } catch (error) {
      const match = error instanceof Error ? error.message.match(/Retryable HTTP status:\s*(\d+)/) : null;
      if (match) {
        throw new Error(`AI stock keyword request failed with HTTP ${match[1]}`);
      }
      throw error;
    }

    if (!response.ok) {
      throw new Error(`AI stock keyword request failed with HTTP ${response.status}`);
    }

    const payload = await response.json() as IOpenAiCompatibleResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('AI stock keyword response missing content');
    }
    return JSON.parse(extractJsonObject(content)) as IAiStockKeywordPayload;
  }
}

export class AiStockKeywordGenerationService {
  public constructor(private readonly requester: IAiStockKeywordRequester) {}

  public async generate(prisma: any, options: IAiStockKeywordGenerationOptions): Promise<IAiStockKeywordGenerationResult> {
    const stocks = await this.loadStocks(prisma, options);
    const batchSize = Math.max(1, Math.trunc(options.batchSize ?? DEFAULT_BATCH_SIZE));
    const maxRequestChars = options.maxRequestChars ?? DEFAULT_MAX_REQUEST_CHARS;
    const rows: IValidatedKeywordRow[] = [];
    let skippedInvalidKeywordCount = 0;

    const requestWithDynamicBatching = async (
      toRequest: readonly IStockRow[]
    ): Promise<{ readonly rows: readonly IValidatedKeywordRow[]; readonly skippedInvalidKeywordCount: number }> => {
      if (toRequest.length === 0) {
        return { rows: [], skippedInvalidKeywordCount: 0 };
      }
      const prompt = buildPrompt(toRequest);
      const bodyChars = JSON.stringify({ model: this.requester.model, prompt }).length;
      if (prompt.length > maxRequestChars || bodyChars > maxRequestChars) {
        if (toRequest.length > 1) {
          const mid = Math.floor(toRequest.length / 2);
          const left = toRequest.slice(0, mid);
          const right = toRequest.slice(mid);
          console.warn(
            `[AiStockKeywordGenerationService] Request payload too large (size ${toRequest.length}). Splitting into ${left.length} and ${right.length}.`
          );
          const leftResult = await requestWithDynamicBatching(left);
          const rightResult = await requestWithDynamicBatching(right);
          return {
            rows: [...leftResult.rows, ...rightResult.rows],
            skippedInvalidKeywordCount: leftResult.skippedInvalidKeywordCount + rightResult.skippedInvalidKeywordCount,
          };
        }
        throw new Error(`AI stock keyword request too large even for single stock: promptChars=${prompt.length}, bodyChars=${bodyChars}, max=${maxRequestChars}`);
      }

      try {
        const payload = await this.requester.requestKeywords({
          stocks: toRequest,
          prompt,
          promptVersion: PROMPT_VERSION,
          model: this.requester.model,
        });
        const validation = this.validatePayload(payload, toRequest, options);
        return validation;
      } catch (error) {
        if (toRequest.length > 1) {
          const mid = Math.floor(toRequest.length / 2);
          const left = toRequest.slice(0, mid);
          const right = toRequest.slice(mid);
          console.warn(
            `[AiStockKeywordGenerationService] AI request failed for batch size ${toRequest.length}. Splitting into sizes ${left.length} and ${right.length}. Error: ${error instanceof Error ? error.message : String(error)}`
          );
          const leftResult = await requestWithDynamicBatching(left);
          const rightResult = await requestWithDynamicBatching(right);
          return {
            rows: [...leftResult.rows, ...rightResult.rows],
            skippedInvalidKeywordCount: leftResult.skippedInvalidKeywordCount + rightResult.skippedInvalidKeywordCount,
          };
        }
        throw error;
      }
    };

    for (let index = 0; index < stocks.length; index += batchSize) {
      const batch = stocks.slice(index, index + batchSize);
      options.onProgress?.(`生成关键词批次 ${Math.floor(index / batchSize) + 1}/${Math.ceil(stocks.length / batchSize)}，股票 ${batch.length} 只`);
      const result = await requestWithDynamicBatching(batch);
      rows.push(...result.rows);
      skippedInvalidKeywordCount += result.skippedInvalidKeywordCount;
    }

    if (stocks.length > 0 && rows.length === 0) {
      throw new Error('AI stock keyword output has no valid keywords');
    }

    const insertedCount = options.dryRun
      ? 0
      : await this.insertRows(prisma, rows);

    return {
      stockCount: stocks.length,
      batchCount: Math.ceil(stocks.length / batchSize),
      generatedKeywordCount: rows.length,
      insertedCount,
      skippedInvalidKeywordCount,
      dryRun: options.dryRun === true,
      source: SOURCE,
      modelVersion: this.requester.model,
      promptVersion: PROMPT_VERSION,
      exposureTypeCounts: countByExposureType(rows),
      sample: rows.slice(0, 20).map(row => ({ ...row })),
    };
  }

  private async loadStocks(prisma: any, options: IAiStockKeywordGenerationOptions): Promise<readonly IStockRow[]> {
    if (typeof prisma?.stock?.findMany !== 'function') {
      throw new Error('Prisma client missing stock.findMany');
    }
    const where: Record<string, unknown> = { clusterKey: options.clusterKey };
    if (options.symbolFilter && options.symbolFilter.length > 0) {
      where.symbol = { in: options.symbolFilter };
    }
    return prisma.stock.findMany({
      where,
      orderBy: { symbol: 'asc' },
      skip: options.skip && options.skip > 0 ? Math.trunc(options.skip) : undefined,
      take: options.limit && options.limit > 0 ? Math.trunc(options.limit) : undefined,
      select: {
        symbol: true,
        name: true,
        industry: true,
        clusterKey: true,
      },
    });
  }

  private validatePayload(
    payload: IAiStockKeywordPayload,
    stocks: readonly IStockRow[],
    options: IAiStockKeywordGenerationOptions,
  ): { readonly rows: readonly IValidatedKeywordRow[]; readonly skippedInvalidKeywordCount: number } {
    const stockBySymbol = new Map(stocks.map(stock => [stock.symbol, stock]));
    const rows: IValidatedKeywordRow[] = [];
    let skippedInvalidKeywordCount = 0;

    if (!Array.isArray(payload.stocks)) {
      throw new Error('AI stock keyword response missing stocks array');
    }

    for (const stockDraft of payload.stocks) {
      const symbol = toCleanString(stockDraft.symbol);
      const stock = symbol ? stockBySymbol.get(symbol) : undefined;
      if (!symbol || !stock) {
        skippedInvalidKeywordCount += 1;
        continue;
      }
      if (!Array.isArray(stockDraft.keywords)) {
        skippedInvalidKeywordCount += 1;
        continue;
      }
      const seen = new Set<string>();
      // 维护 symbol 计数器，避免每次 filter O(n) → O(1)
      const symbolCount = rows.reduce<Record<string, number>>((acc, row) => {
        acc[row.symbol] = (acc[row.symbol] ?? 0) + 1;
        return acc;
      }, {});
      for (const keywordDraft of stockDraft.keywords) {
        if ((symbolCount[symbol] ?? 0) >= KEYWORDS_PER_STOCK) {
          break;
        }
        const keyword = toCleanString(keywordDraft.keyword);
        const exposureType = keywordDraft.exposureType;
        const confidence = toConfidence(keywordDraft.confidence);
        const reason = toCleanString(keywordDraft.reason);
        if (!keyword || !isExposureType(exposureType) || confidence === null) {
          skippedInvalidKeywordCount += 1;
          continue;
        }
        const key = `${symbol}\u0000${exposureType}\u0000${keyword}`;
        if (seen.has(key)) {
          skippedInvalidKeywordCount += 1;
          continue;
        }
        seen.add(key);
        rows.push({
          clusterKey: options.clusterKey,
          symbol,
          stockName: stock.name,
          keyword,
          exposureType,
          source: SOURCE,
          sourceId: `${symbol}:${exposureType}:${keyword}`,
          sourceName: SOURCE_NAME,
          confidence,
          evidenceJson: {
            schemaVersion: 'ai-stock-knowledge-v1',
            generatedBy: 'ai',
            basis: 'public_company_common_knowledge',
            isNewsEvidence: false,
            modelVersion: this.requester.model,
            promptVersion: PROMPT_VERSION,
            generatedAt: options.asOf.toISOString(),
            reason,
            stock: {
              symbol,
              name: stock.name,
              industry: stock.industry ?? null,
            },
          },
          validFrom: options.asOf,
          status: 'active',
        });
        symbolCount[symbol] = (symbolCount[symbol] ?? 0) + 1;
      }
    }

    if (rows.length === 0) {
      throw new Error('AI stock keyword output has no valid keywords');
    }

    // 用 Set 一次性查 missing symbols，O(n) 替代 O(n²)
    const coveredSymbols = new Set(rows.map((row) => row.symbol));
    const missingSymbols = stocks.filter((stock) => !coveredSymbols.has(stock.symbol));
    if (missingSymbols.length > 0) {
      throw new Error(`AI stock keyword output missing valid keywords for symbols: ${missingSymbols.map(stock => stock.symbol).join(', ')}`);
    }

    return { rows, skippedInvalidKeywordCount };
  }

  private async insertRows(prisma: any, rows: readonly IValidatedKeywordRow[]): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }
    if (typeof prisma?.stockExposureFact?.createMany !== 'function') {
      throw new Error('Prisma client missing stockExposureFact.createMany');
    }
    const result = await prisma.stockExposureFact.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return Number(result.count ?? 0);
  }
}

export const createAiStockKeywordRequesterFromEnv = (
  environment: NodeJS.ProcessEnv = process.env,
): OpenAiCompatibleStockKeywordRequester => {
  const baseUrl = environment.OPENAI_BASE_URL ?? environment.AI_BASE_URL ?? environment.LLM_SMART_BASE_URL;
  const apiKey = environment.OPENAI_API_KEY ?? environment.AI_API_KEY ?? environment.LLM_SMART_API_KEY;
  const model = environment.AI_STOCK_KEYWORD_MODEL ?? environment.OPENAI_MODEL ?? environment.LLM_SMART_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new Error('Missing AI stock keyword env: OPENAI_BASE_URL/OPENAI_API_KEY/AI_STOCK_KEYWORD_MODEL or LLM_SMART_BASE_URL/LLM_SMART_API_KEY/LLM_SMART_MODEL');
  }
  return new OpenAiCompatibleStockKeywordRequester({
    baseUrl,
    apiKey,
    model,
    timeoutMs: Number(environment.AI_STOCK_KEYWORD_TIMEOUT_MS ?? 60000),
  });
};
