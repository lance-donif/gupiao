import type {
  IStockExposureCandidateRecord,
  IStockExposureEvidence,
  IStockExposureFactRecord,
  IStockExposureRejectedRecord,
} from './stock-exposure-types.js';
import crypto from 'node:crypto';
import { normalizeBaseUrl } from '../lib/url-utils.js';

interface ITickFlowUniverseSummary {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly region?: string;
  readonly category?: string;
  readonly symbol_count?: number;
}

interface ITickFlowUniverseDetail extends ITickFlowUniverseSummary {
  readonly symbols?: readonly string[];
}

interface ITickFlowResponse<T> {
  readonly data?: T;
  readonly code?: string;
  readonly message?: string;
}

interface ITickFlowStockExposureServiceOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly requestsPerSecond?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface ITickFlowStockExposureSyncInput {
  readonly traceId: string;
  readonly asOf: Date;
  readonly clusterKey: string;
  readonly stockNameBySymbol: ReadonlyMap<string, string>;
  readonly universeLimit?: number;
}

export interface ITickFlowStockExposureSyncResult {
  readonly universeCount: number;
  readonly acceptedUniverseCount: number;
  readonly skippedUniverseCount: number;
  readonly candidateCount: number;
  readonly promotedFactCount: number;
  readonly rejectedCount: number;
  readonly failures: readonly string[];
  readonly sample: readonly Record<string, unknown>[];
  readonly rejectedSample: readonly Record<string, unknown>[];
}

const TICKFLOW_SOURCE = 'tickflow_sw_universe';
const DEFAULT_BASE_URL = 'https://api.tickflow.org';
const SW_UNIVERSE_PATTERN = /^CN_Equity_SW([123])_\d+$/u;

export const isSupportedTickFlowSwUniverse = (universe: ITickFlowUniverseSummary): boolean => {
  return (
    typeof universe.id === 'string'
    && SW_UNIVERSE_PATTERN.test(universe.id)
    && universe.region === 'CN'
    && universe.category === 'equity'
  );
};

export const resolveTickFlowTaxonomyLevel = (sourceId: string): 'SW1' | 'SW2' | 'SW3' | null => {
  const match = sourceId.match(SW_UNIVERSE_PATTERN);
  return match ? `SW${match[1]}` as 'SW1' | 'SW2' | 'SW3' : null;
};

export const normalizeTickFlowSymbol = (symbol: string): string | null => {
  const match = symbol.trim().toUpperCase().match(/^(\d{6})\.(SH|SZ|BJ)$/u);
  return match ? match[1] : null;
};

const stripSwPrefix = (name: string): string => {
  return name.replace(/^SW[123]/u, '').trim();
};

const hashPayload = (value: unknown): string => {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
};

const calculateIndustryExposureConfidence = (taxonomyLevel: 'SW1' | 'SW2' | 'SW3', memberCount: number): number => {
  const levelBase = taxonomyLevel === 'SW3' ? 0.92 : taxonomyLevel === 'SW2' ? 0.84 : 0.76;
  const breadthPenalty = Math.min(0.28, Math.max(0, memberCount - 30) * 0.002);
  return Number(Math.max(0.45, levelBase - breadthPenalty).toFixed(4));
};

const createEvidence = (
  detail: ITickFlowUniverseDetail,
  symbol: string,
  normalizedSymbol: string,
  requestUrl: string,
  asOf: Date,
  confidenceReason: string,
): IStockExposureEvidence => ({
  schemaVersion: 'stock-exposure-evidence-v1',
  provider: 'tickflow',
  requestUrl,
  sourceId: String(detail.id),
  sourceName: String(detail.name),
  description: detail.description,
  payloadHash: hashPayload(detail),
  observedAt: asOf.toISOString(),
  rawSymbol: symbol,
  normalizedSymbol,
  memberCount: detail.symbols?.length ?? detail.symbol_count,
  confidenceReason,
});

const buildCandidateRowsFromUniverse = (
  detail: ITickFlowUniverseDetail,
  input: ITickFlowStockExposureSyncInput,
  requestUrl: string,
): {
  readonly accepted: readonly IStockExposureCandidateRecord[];
  readonly rejected: readonly IStockExposureRejectedRecord[];
} => {
  if (!detail.id || !detail.name || !Array.isArray(detail.symbols)) {
    return { accepted: [], rejected: [] };
  }

  const taxonomyLevel = resolveTickFlowTaxonomyLevel(detail.id);
  if (!taxonomyLevel) {
    return { accepted: [], rejected: [] };
  }

  const keyword = stripSwPrefix(detail.name);
  const memberCount = detail.symbols.length;
  const confidence = calculateIndustryExposureConfidence(taxonomyLevel, memberCount);
  const confidenceReason = `${taxonomyLevel} 申万行业成分，成员数 ${memberCount}，宽行业已做置信度折减`;

  const accepted: IStockExposureCandidateRecord[] = [];
  const rejected: IStockExposureRejectedRecord[] = [];

  for (const rawSymbol of detail.symbols) {
    const normalizedSymbol = normalizeTickFlowSymbol(rawSymbol);
    if (!normalizedSymbol) {
      rejected.push({
        traceId: input.traceId,
        asOf: input.asOf,
        clusterKey: input.clusterKey,
        symbol: rawSymbol,
        stockName: '',
        keyword,
        exposureType: 'industry_exposure',
        taxonomyLevel,
        source: TICKFLOW_SOURCE,
        sourceId: detail.id,
        sourceName: detail.name,
        confidence: 0,
        evidenceJson: createEvidence(detail, rawSymbol, rawSymbol, requestUrl, input.asOf, '代码格式不支持'),
        memberCount,
        validFrom: input.asOf,
        validTo: null,
        status: 'rejected',
        failureReason: 'unsupported_symbol_format',
      });
      continue;
    }

    const stockName = input.stockNameBySymbol.get(normalizedSymbol);
    if (!stockName) {
      rejected.push({
        traceId: input.traceId,
        asOf: input.asOf,
        clusterKey: input.clusterKey,
        symbol: normalizedSymbol,
        stockName: '',
        keyword,
        exposureType: 'industry_exposure',
        taxonomyLevel,
        source: TICKFLOW_SOURCE,
        sourceId: detail.id,
        sourceName: detail.name,
        confidence: 0,
        evidenceJson: createEvidence(detail, rawSymbol, normalizedSymbol, requestUrl, input.asOf, '本地 Stock 表缺少该股票'),
        memberCount,
        validFrom: input.asOf,
        validTo: null,
        status: 'rejected',
        failureReason: 'stock_not_found',
      });
      continue;
    }

    accepted.push({
      traceId: input.traceId,
      asOf: input.asOf,
      clusterKey: input.clusterKey,
      symbol: normalizedSymbol,
      stockName,
      keyword,
      exposureType: 'industry_exposure',
      taxonomyLevel,
      source: TICKFLOW_SOURCE,
      sourceId: detail.id,
      sourceName: detail.name,
      confidence,
      evidenceJson: createEvidence(detail, rawSymbol, normalizedSymbol, requestUrl, input.asOf, confidenceReason),
      memberCount,
      validFrom: input.asOf,
      validTo: null,
      status: 'candidate',
      failureReason: null,
    });
  }

  return { accepted, rejected };
};

const persistExposureRows = async (
  prisma: any,
  acceptedRows: readonly IStockExposureCandidateRecord[],
  rejectedRows: readonly IStockExposureRejectedRecord[],
): Promise<void> => {
  if (acceptedRows.length > 0) {
    await prisma.stockExposureCandidate.createMany({
      data: acceptedRows.map(row => ({
        ...row,
        evidenceJson: row.evidenceJson,
      })),
      skipDuplicates: true,
    });
  }

  if (rejectedRows.length > 0) {
    await prisma.stockExposureCandidate.createMany({
      data: rejectedRows.map(row => ({
        ...row,
        evidenceJson: row.evidenceJson,
      })),
      skipDuplicates: true,
    });
  }

  const factRows: IStockExposureFactRecord[] = acceptedRows.map(row => ({
    traceId: row.traceId,
    asOf: row.asOf,
    clusterKey: row.clusterKey,
    symbol: row.symbol,
    stockName: row.stockName,
    keyword: row.keyword,
    exposureType: row.exposureType,
    taxonomyLevel: row.taxonomyLevel,
    source: row.source,
    sourceId: row.sourceId,
    sourceName: row.sourceName,
    confidence: row.confidence,
    evidenceJson: row.evidenceJson,
    memberCount: row.memberCount,
    validFrom: row.validFrom,
    validTo: row.validTo,
    status: 'active',
  }));

  // 批量 upsert：所有 upsert 装进 $transaction，单次 round-trip 替代 N 次串行
  if (prisma.stockExposureFact.upsert) {
    const upsertOps = factRows.map(row => prisma.stockExposureFact.upsert({
      where: {
        clusterKey_symbol_keyword_exposureType_source_sourceId: {
          clusterKey: row.clusterKey,
          symbol: row.symbol,
          keyword: row.keyword,
          exposureType: row.exposureType,
          source: row.source,
          sourceId: row.sourceId,
        },
      },
      create: {
        traceId: row.traceId,
        clusterKey: row.clusterKey,
        symbol: row.symbol,
        stockName: row.stockName,
        keyword: row.keyword,
        exposureType: row.exposureType,
        taxonomyLevel: row.taxonomyLevel,
        source: row.source,
        sourceId: row.sourceId,
        sourceName: row.sourceName,
        confidence: row.confidence,
        evidenceJson: row.evidenceJson,
        memberCount: row.memberCount,
        validFrom: row.validFrom,
        validTo: row.validTo,
        status: row.status,
      },
      update: {
        traceId: row.traceId,
        stockName: row.stockName,
        sourceName: row.sourceName,
        confidence: row.confidence,
        evidenceJson: row.evidenceJson,
        memberCount: row.memberCount,
        validFrom: row.validFrom,
        validTo: row.validTo,
        status: row.status,
      },
    }));
    // Chunk transactions to prevent 5000ms timeout on massive dataset
    const chunkSize = 100;
    for (let i = 0; i < upsertOps.length; i += chunkSize) {
      const chunk = upsertOps.slice(i, i + chunkSize);
      await prisma.$transaction(chunk);
    }
    return;
  }

  // 降级：createMany skipDuplicates（一次写入）
  if (prisma.stockExposureFact.createMany) {
    await prisma.stockExposureFact.createMany({
      data: factRows.map(row => ({
        traceId: row.traceId,
        clusterKey: row.clusterKey,
        symbol: row.symbol,
        stockName: row.stockName,
        keyword: row.keyword,
        exposureType: row.exposureType,
        taxonomyLevel: row.taxonomyLevel,
        source: row.source,
        sourceId: row.sourceId,
        sourceName: row.sourceName,
        confidence: row.confidence,
        evidenceJson: row.evidenceJson,
        memberCount: row.memberCount,
        validFrom: row.validFrom,
        validTo: row.validTo,
        status: row.status,
      })),
      skipDuplicates: true,
    });
  }
};

export class TickFlowStockExposureService {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestIntervalMs: number;
  private lastRequestAt = 0;

  public constructor(private readonly options: ITickFlowStockExposureServiceOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.fetchImpl = options.fetchImpl ?? fetch;
    const rps = Math.max(0.1, Math.min(options.requestsPerSecond ?? 3, 10));
    this.requestIntervalMs = Math.ceil(1000 / rps);
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const waitMs = Math.max(0, this.lastRequestAt + this.requestIntervalMs - now);
    if (waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    this.lastRequestAt = Date.now();
  }

  private async getJson<T>(path: string): Promise<T> {
    await this.throttle();
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'x-api-key': this.options.apiKey,
      },
    });
    if (!response.ok) {
      throw new Error(`TickFlow ${path} failed with HTTP ${response.status}`);
    }
    return await response.json() as T;
  }

  public async sync(prisma: any, input: ITickFlowStockExposureSyncInput): Promise<ITickFlowStockExposureSyncResult> {
    const listPayload = await this.getJson<ITickFlowResponse<ITickFlowUniverseSummary[]>>('/v1/universes');
    const universes = listPayload.data ?? [];
    const supported = universes.filter(isSupportedTickFlowSwUniverse);
    const selected = typeof input.universeLimit === 'number' ? supported.slice(0, input.universeLimit) : supported;

    const failures: string[] = [];
    let candidateCount = 0;
    let promotedFactCount = 0;
    let rejectedCount = 0;
    const sample: Record<string, unknown>[] = [];
    const rejectedSample: Record<string, unknown>[] = [];

    for (const universe of selected) {
      const sourceId = String(universe.id);
      const path = `/v1/universes/${encodeURIComponent(sourceId)}`;
      const requestUrl = `${this.baseUrl}${path}`;
      try {
        const detailPayload = await this.getJson<ITickFlowResponse<ITickFlowUniverseDetail>>(path);
        if (!detailPayload.data) {
          failures.push(`${sourceId}: empty_detail`);
          continue;
        }
        const rows = buildCandidateRowsFromUniverse(detailPayload.data, input, requestUrl);
        await persistExposureRows(prisma, rows.accepted, rows.rejected);
        candidateCount += rows.accepted.length;
        promotedFactCount += rows.accepted.length;
        rejectedCount += rows.rejected.length;
        sample.push(...rows.accepted.slice(0, Math.max(0, 10 - sample.length)).map(row => ({
          symbol: row.symbol,
          stockName: row.stockName,
          keyword: row.keyword,
          taxonomyLevel: row.taxonomyLevel,
          sourceId: row.sourceId,
          confidence: row.confidence,
          memberCount: row.memberCount,
        })));
        rejectedSample.push(...rows.rejected.slice(0, Math.max(0, 10 - rejectedSample.length)).map(row => ({
          symbol: row.symbol,
          keyword: row.keyword,
          sourceId: row.sourceId,
          failureReason: row.failureReason,
        })));
      }
      catch (error) {
        failures.push(`${sourceId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      universeCount: universes.length,
      acceptedUniverseCount: selected.length,
      skippedUniverseCount: universes.length - selected.length,
      candidateCount,
      promotedFactCount,
      rejectedCount,
      failures,
      sample,
      rejectedSample,
    };
  }
}

export const createTickFlowStockExposureServiceFromEnv = (
  environment: NodeJS.ProcessEnv = process.env,
): TickFlowStockExposureService => {
  const apiKey = environment.TICKFLOW_API_KEY;
  if (!apiKey) {
    throw new Error('Missing TICKFLOW_API_KEY');
  }
  return new TickFlowStockExposureService({
    apiKey,
    baseUrl: environment.TICKFLOW_BASE_URL,
    requestsPerSecond: environment.TICKFLOW_RPS ? Number(environment.TICKFLOW_RPS) : undefined,
  });
};

export const __privateTickFlowStockExposure = {
  buildCandidateRowsFromUniverse,
  calculateIndustryExposureConfidence,
  persistExposureRows,
  stripSwPrefix,
};
