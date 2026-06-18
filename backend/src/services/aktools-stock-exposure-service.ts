import type {
  IStockExposureCandidateRecord,
  IStockExposureEvidence,
  IStockExposureFactRecord,
  IStockExposureRejectedRecord,
  StockExposureType,
} from './stock-exposure-types.js';
import crypto from 'node:crypto';
import { normalizeBaseUrl, toNonEmptyString } from '../lib/url-utils.js';

type AkRecord = Readonly<Record<string, unknown>>;

export interface IAkToolsStockExposureSyncInput {
  readonly traceId: string;
  readonly asOf: Date;
  readonly clusterKey: string;
  readonly stockNameBySymbol: ReadonlyMap<string, string>;
  readonly boardLimit?: number;
  readonly symbolLimit?: number;
}

export interface IAkToolsStockExposureSyncResult {
  readonly candidateCount: number;
  readonly promotedFactCount: number;
  readonly rejectedCount: number;
  readonly failures: readonly string[];
  readonly sample: readonly Record<string, unknown>[];
  readonly rejectedSample: readonly Record<string, unknown>[];
}

interface IAkToolsStockExposureServiceOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
}

interface IBuildRowsInput {
  readonly traceId: string;
  readonly asOf: Date;
  readonly clusterKey: string;
  readonly stockNameBySymbol: ReadonlyMap<string, string>;
}

const PROVIDER = 'aktools';
const INDUSTRY_SOURCE = 'akshare_industry_board_em';
const CONCEPT_SOURCE = 'akshare_concept_board_em';
const INDIVIDUAL_SOURCE = 'akshare_individual_info_em';
const STOCK_CHANGES_SOURCE = 'akshare_stock_changes_em';
const BOARD_CHANGE_SOURCE = 'akshare_board_change_em';

const hashPayload = (value: unknown): string => {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
};

const pickString = (record: AkRecord, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = toNonEmptyString(record[key]);
    if (value) {
      return value;
    }
  }
  return null;
};

export const normalizeAkToolsSymbol = (value: unknown): string | null => {
  const text = toNonEmptyString(value);
  if (!text) {
    return null;
  }
  const match = text.match(/(\d{6})/u);
  return match ? match[1] : null;
};

const unwrapAkToolsRows = (payload: unknown): AkRecord[] => {
  const value = typeof payload === 'object' && payload !== null && 'data' in payload
    ? (payload as { readonly data?: unknown }).data
    : payload;
  return Array.isArray(value) ? value.filter((row): row is AkRecord => typeof row === 'object' && row !== null) : [];
};

const buildQueryUrl = (baseUrl: string, endpoint: string, params?: Readonly<Record<string, string>>): string => {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/api/public/${endpoint}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
};

const createEvidence = (input: {
  readonly requestUrl: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly rawFields: AkRecord;
  readonly asOf: Date;
  readonly rawSymbol: string;
  readonly normalizedSymbol: string;
  readonly memberCount?: number;
  readonly confidenceReason: string;
}): IStockExposureEvidence => ({
  schemaVersion: 'stock-exposure-evidence-v1',
  provider: PROVIDER,
  requestUrl: input.requestUrl,
  sourceId: input.sourceId,
  sourceName: input.sourceName,
  payloadHash: hashPayload(input.rawFields),
  observedAt: input.asOf.toISOString(),
  rawSymbol: input.rawSymbol,
  normalizedSymbol: input.normalizedSymbol,
  memberCount: input.memberCount,
  confidenceReason: input.confidenceReason,
  rawFields: input.rawFields,
});

const createRejectedRow = (
  base: IBuildRowsInput,
  row: {
    readonly rawSymbol: string;
    readonly normalizedSymbol: string;
    readonly keyword: string;
    readonly exposureType: StockExposureType;
    readonly taxonomyLevel?: string;
    readonly source: string;
    readonly sourceId: string;
    readonly sourceName: string;
    readonly requestUrl: string;
    readonly rawFields: AkRecord;
    readonly memberCount?: number;
    readonly failureReason: string;
    readonly confidenceReason: string;
  },
): IStockExposureRejectedRecord => ({
  traceId: base.traceId,
  asOf: base.asOf,
  clusterKey: base.clusterKey,
  symbol: row.normalizedSymbol,
  stockName: '',
  keyword: row.keyword,
  exposureType: row.exposureType,
  taxonomyLevel: row.taxonomyLevel,
  source: row.source,
  sourceId: row.sourceId,
  sourceName: row.sourceName,
  confidence: 0,
  evidenceJson: createEvidence({ ...row, asOf: base.asOf }),
  memberCount: row.memberCount,
  validFrom: base.asOf,
  validTo: null,
  status: 'rejected',
  failureReason: row.failureReason,
});

const createAcceptedRow = (
  base: IBuildRowsInput,
  row: {
    readonly rawSymbol: string;
    readonly normalizedSymbol: string;
    readonly stockName: string;
    readonly keyword: string;
    readonly exposureType: StockExposureType;
    readonly taxonomyLevel?: string;
    readonly source: string;
    readonly sourceId: string;
    readonly sourceName: string;
    readonly requestUrl: string;
    readonly rawFields: AkRecord;
    readonly memberCount?: number;
    readonly confidence: number;
    readonly confidenceReason: string;
  },
): IStockExposureCandidateRecord => ({
  traceId: base.traceId,
  asOf: base.asOf,
  clusterKey: base.clusterKey,
  symbol: row.normalizedSymbol,
  stockName: row.stockName,
  keyword: row.keyword,
  exposureType: row.exposureType,
  taxonomyLevel: row.taxonomyLevel,
  source: row.source,
  sourceId: row.sourceId,
  sourceName: row.sourceName,
  confidence: row.confidence,
  evidenceJson: createEvidence({ ...row, asOf: base.asOf }),
  memberCount: row.memberCount,
  validFrom: base.asOf,
  validTo: null,
  status: 'candidate',
  failureReason: null,
});

const buildRowsForSymbol = (
  base: IBuildRowsInput,
  row: Omit<Parameters<typeof createAcceptedRow>[1], 'stockName' | 'confidence'> & {
    readonly confidence: number;
  },
): {
  readonly accepted: readonly IStockExposureCandidateRecord[];
  readonly rejected: readonly IStockExposureRejectedRecord[];
} => {
  if (!normalizeAkToolsSymbol(row.normalizedSymbol)) {
    return {
      accepted: [],
      rejected: [createRejectedRow(base, {
        ...row,
        failureReason: 'unsupported_symbol_format',
        confidenceReason: 'AKTools 返回的股票代码无法识别',
      })],
    };
  }

  const stockName = base.stockNameBySymbol.get(row.normalizedSymbol);
  if (!stockName) {
    return {
      accepted: [],
      rejected: [createRejectedRow(base, {
        ...row,
        failureReason: 'stock_not_found',
        confidenceReason: '本地 Stock 表缺少该股票',
      })],
    };
  }

  return {
    accepted: [createAcceptedRow(base, { ...row, stockName })],
    rejected: [],
  };
};

const persistExposureRows = async (
  prisma: any,
  acceptedRows: readonly IStockExposureCandidateRecord[],
  rejectedRows: readonly IStockExposureRejectedRecord[],
): Promise<void> => {
  if (acceptedRows.length > 0) {
    await prisma.stockExposureCandidate.createMany({ data: acceptedRows, skipDuplicates: true });
  }
  if (rejectedRows.length > 0) {
    await prisma.stockExposureCandidate.createMany({ data: rejectedRows, skipDuplicates: true });
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
  // 保留每行自己的 update payload（不能用 updateMany 替代，updateMany 同一桶内只能共享 data）
  if (typeof prisma.stockExposureFact.upsert === 'function') {
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
  if (typeof prisma.stockExposureFact.createMany === 'function') {
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

const buildBoardMemberRows = (input: {
  readonly base: IBuildRowsInput;
  readonly rows: readonly AkRecord[];
  readonly requestUrl: string;
  readonly boardName: string;
  readonly exposureType: 'industry_exposure' | 'concept_exposure';
  readonly source: string;
  readonly taxonomyLevel: string;
}): {
  readonly accepted: readonly IStockExposureCandidateRecord[];
  readonly rejected: readonly IStockExposureRejectedRecord[];
} => {
  const accepted: IStockExposureCandidateRecord[] = [];
  const rejected: IStockExposureRejectedRecord[] = [];
  const memberCount = input.rows.length;

  for (const rawFields of input.rows) {
    const rawSymbol = pickString(rawFields, ['代码', '股票代码', '成分股代码', 'symbol']) ?? '';
    const normalizedSymbol = normalizeAkToolsSymbol(rawSymbol) ?? rawSymbol;
    const row = buildRowsForSymbol(input.base, {
      rawSymbol,
      normalizedSymbol,
      keyword: input.boardName,
      exposureType: input.exposureType,
      taxonomyLevel: input.taxonomyLevel,
      source: input.source,
      sourceId: input.boardName,
      sourceName: input.boardName,
      requestUrl: input.requestUrl,
      rawFields,
      memberCount,
      confidence: input.exposureType === 'industry_exposure' ? 0.82 : 0.74,
      confidenceReason: `${input.taxonomyLevel} 板块成份来自 AKShare 东方财富接口，成员数 ${memberCount}`,
    });
    accepted.push(...row.accepted);
    rejected.push(...row.rejected);
  }

  return { accepted, rejected };
};

const buildIndividualInfoRows = (input: {
  readonly base: IBuildRowsInput;
  readonly rows: readonly AkRecord[];
  readonly requestUrl: string;
  readonly symbol: string;
}): {
  readonly accepted: readonly IStockExposureCandidateRecord[];
  readonly rejected: readonly IStockExposureRejectedRecord[];
} => {
  const profile = new Map<string, string>();
  for (const row of input.rows) {
    const key = pickString(row, ['item', '指标', '项目', 'name']);
    const value = pickString(row, ['value', '值', '内容']);
    if (key && value) {
      profile.set(key, value);
    }
  }

  const rawFields = Object.fromEntries(profile.entries());
  const keywords = [
    profile.get('行业'),
    profile.get('主营业务'),
    profile.get('经营范围'),
  ].filter((value): value is string => Boolean(value));
  const normalizedSymbol = normalizeAkToolsSymbol(profile.get('股票代码') ?? input.symbol) ?? input.symbol;
  const accepted: IStockExposureCandidateRecord[] = [];
  const rejected: IStockExposureRejectedRecord[] = [];

  for (const keyword of keywords) {
    const row = buildRowsForSymbol(input.base, {
      rawSymbol: input.symbol,
      normalizedSymbol,
      keyword,
      exposureType: 'company_profile_exposure',
      taxonomyLevel: 'company_profile',
      source: INDIVIDUAL_SOURCE,
      sourceId: `${normalizedSymbol}:${keyword}`,
      sourceName: '个股资料',
      requestUrl: input.requestUrl,
      rawFields,
      confidence: 0.68,
      confidenceReason: '个股资料行业或主营字段来自 AKShare 东方财富个股信息接口',
    });
    accepted.push(...row.accepted);
    rejected.push(...row.rejected);
  }

  return { accepted, rejected };
};

const buildMovementRows = (input: {
  readonly base: IBuildRowsInput;
  readonly rows: readonly AkRecord[];
  readonly requestUrl: string;
  readonly source: string;
  readonly sourceName: string;
}): {
  readonly accepted: readonly IStockExposureCandidateRecord[];
  readonly rejected: readonly IStockExposureRejectedRecord[];
} => {
  const accepted: IStockExposureCandidateRecord[] = [];
  const rejected: IStockExposureRejectedRecord[] = [];

  for (const rawFields of input.rows) {
    const rawSymbol = pickString(rawFields, [
      '代码',
      '股票代码',
      'symbol',
      '板块异动最频繁个股及所属类型-股票代码',
    ]) ?? '';
    const normalizedSymbol = normalizeAkToolsSymbol(rawSymbol) ?? rawSymbol;
    const stockName = pickString(rawFields, ['名称', '股票名称', '板块异动最频繁个股及所属类型-股票名称']);
    const movementType = pickString(rawFields, [
      '异动类型',
      '板块异动最频繁个股及所属类型-买卖方向',
      '板块具体异动类型列表及出现次数',
    ]);
    const boardName = pickString(rawFields, ['板块名称', '板块']);
    const keyword = movementType || boardName || stockName || pickString(rawFields, ['相关信息', '事件']) || input.sourceName;
    const row = buildRowsForSymbol(input.base, {
      rawSymbol,
      normalizedSymbol,
      keyword,
      exposureType: 'movement_evidence',
      taxonomyLevel: 'movement',
      source: input.source,
      sourceId: `${normalizedSymbol || 'unknown'}:${keyword}`,
      sourceName: input.sourceName,
      requestUrl: input.requestUrl,
      rawFields,
      confidence: 0.55,
      confidenceReason: '异动数据只作为事实解释，不接入行业或概念暴露评分',
    });
    accepted.push(...row.accepted);
    rejected.push(...row.rejected);
  }

  return { accepted, rejected };
};

export class AkToolsStockExposureService {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: IAkToolsStockExposureServiceOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async getRows(endpoint: string, params?: Readonly<Record<string, string>>): Promise<{
    readonly requestUrl: string;
    readonly rows: readonly AkRecord[];
  }> {
    const requestUrl = buildQueryUrl(this.baseUrl, endpoint, params);
    const response = await this.fetchImpl(requestUrl, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`AKTools ${endpoint} failed with HTTP ${response.status}`);
    }
    return { requestUrl, rows: unwrapAkToolsRows(await response.json()) };
  }

  public async sync(prisma: any, input: IAkToolsStockExposureSyncInput): Promise<IAkToolsStockExposureSyncResult> {
    const base = {
      traceId: input.traceId,
      asOf: input.asOf,
      clusterKey: input.clusterKey,
      stockNameBySymbol: input.stockNameBySymbol,
    };
    const failures: string[] = [];
    const acceptedRows: IStockExposureCandidateRecord[] = [];
    const rejectedRows: IStockExposureRejectedRecord[] = [];

    await this.collectBoardRows(base, input, acceptedRows, rejectedRows, failures);
    await this.collectIndividualRows(base, input, acceptedRows, rejectedRows, failures);
    await this.collectMovementRows(base, acceptedRows, rejectedRows, failures);

    await persistExposureRows(prisma, acceptedRows, rejectedRows);

    return {
      candidateCount: acceptedRows.length,
      promotedFactCount: acceptedRows.length,
      rejectedCount: rejectedRows.length,
      failures,
      sample: acceptedRows.slice(0, 10).map(row => ({
        symbol: row.symbol,
        stockName: row.stockName,
        keyword: row.keyword,
        exposureType: row.exposureType,
        source: row.source,
      })),
      rejectedSample: rejectedRows.slice(0, 10).map(row => ({
        symbol: row.symbol,
        keyword: row.keyword,
        exposureType: row.exposureType,
        source: row.source,
        failureReason: row.failureReason,
      })),
    };
  }

  private async collectBoardRows(
    base: IBuildRowsInput,
    input: IAkToolsStockExposureSyncInput,
    acceptedRows: IStockExposureCandidateRecord[],
    rejectedRows: IStockExposureRejectedRecord[],
    failures: string[],
  ): Promise<void> {
    const specs = [
      {
        listEndpoint: 'stock_board_industry_name_em',
        consEndpoint: 'stock_board_industry_cons_em',
        exposureType: 'industry_exposure' as const,
        source: INDUSTRY_SOURCE,
        taxonomyLevel: 'eastmoney_industry',
      },
      {
        listEndpoint: 'stock_board_concept_name_em',
        consEndpoint: 'stock_board_concept_cons_em',
        exposureType: 'concept_exposure' as const,
        source: CONCEPT_SOURCE,
        taxonomyLevel: 'eastmoney_concept',
      },
    ];

    for (const spec of specs) {
      try {
        const list = await this.getRows(spec.listEndpoint);
        const boards = list.rows.slice(0, input.boardLimit ?? list.rows.length);
        for (const board of boards) {
          const boardName = pickString(board, ['板块名称', '行业名称', '概念名称', '名称', 'name']);
          if (!boardName) {
            continue;
          }
          const detail = await this.getRows(spec.consEndpoint, { symbol: boardName });
          const rows = buildBoardMemberRows({
            base,
            rows: detail.rows.slice(0, input.symbolLimit ?? detail.rows.length),
            requestUrl: detail.requestUrl,
            boardName,
            exposureType: spec.exposureType,
            source: spec.source,
            taxonomyLevel: spec.taxonomyLevel,
          });
          acceptedRows.push(...rows.accepted);
          rejectedRows.push(...rows.rejected);
        }
      }
      catch (error) {
        failures.push(`${spec.listEndpoint}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async collectIndividualRows(
    base: IBuildRowsInput,
    input: IAkToolsStockExposureSyncInput,
    acceptedRows: IStockExposureCandidateRecord[],
    rejectedRows: IStockExposureRejectedRecord[],
    failures: string[],
  ): Promise<void> {
    const symbols = [...input.stockNameBySymbol.keys()].slice(0, input.symbolLimit ?? input.stockNameBySymbol.size);
    // 并行抓取个股，错误仅记录不影响其他
    await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const detail = await this.getRows('stock_individual_info_em', { symbol });
          const rows = buildIndividualInfoRows({ base, rows: detail.rows, requestUrl: detail.requestUrl, symbol });
          acceptedRows.push(...rows.accepted);
          rejectedRows.push(...rows.rejected);
        }
        catch (error) {
          failures.push(`stock_individual_info_em:${symbol}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
  }

  private async collectMovementRows(
    base: IBuildRowsInput,
    acceptedRows: IStockExposureCandidateRecord[],
    rejectedRows: IStockExposureRejectedRecord[],
    failures: string[],
  ): Promise<void> {
    const specs = [
      { endpoint: 'stock_changes_em', source: STOCK_CHANGES_SOURCE, sourceName: '个股异动' },
      { endpoint: 'stock_board_change_em', source: BOARD_CHANGE_SOURCE, sourceName: '板块异动' },
    ];

    // 并行抓取 2 个 endpoint
    await Promise.all(
      specs.map(async (spec) => {
        try {
          const detail = await this.getRows(spec.endpoint);
          const rows = buildMovementRows({
            base,
            rows: detail.rows,
            requestUrl: detail.requestUrl,
            source: spec.source,
            sourceName: spec.sourceName,
          });
          acceptedRows.push(...rows.accepted);
          rejectedRows.push(...rows.rejected);
        }
        catch (error) {
          failures.push(`${spec.endpoint}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
  }
}

export const __privateAkToolsStockExposure = {
  buildBoardMemberRows,
  buildIndividualInfoRows,
  buildMovementRows,
  buildQueryUrl,
  normalizeAkToolsSymbol,
  persistExposureRows,
  unwrapAkToolsRows,
};
