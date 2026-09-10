/**
 * 行情数据契约与版本化数据集导入校验。
 *
 * 设计要点：
 *  - 写入 MarketDatasetVersion 记录覆盖区间（coverageStart/coverageEnd）与校验和（checksum）。
 *  - 现有来源没有提供、也无法从现有字段推断的字段（交易状态 tradingStatus、涨跌停价
 *    limitUpPrice/limitDownPrice、复权口径 adjType、公司行动）必须标为「未知」。
 *    表示方式：统一用 **null** 表示未知（Candle 对应列本就可空），并在报告中统计未知字段计数，
 *   绝不推测填充。
 *  - 复权口径准入：默认 permissive（只统计并记录 unknown / 前复权 adjType 计数，作为数据缺口
 *    证据，不阻断每日推荐链路）；显式开启 strictDataAdmission 或直接调用
 *    assertStrictMarketDataAdmission 时，未通过口径校验（adjType 为前复权 'qfq' 或未知 null）
 *    的数据必须被拒绝（抛 StrictBacktestRejectedError），而非静默参与。
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hasDelegate } from '../scoring/scoring-helpers.js';
import { datasetVersionWhere } from './market-data-reader.js';

/** 被来源数据缺失、无法推断的字段，统一用 null 表示「未知」。 */
export const UNKNOWN_FIELD_REPRESENTATION = 'null' as const;

export interface CandleImportRecord {
  readonly stockId: string;
  readonly tradingDay: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly tradingStatus?: string | null;
  readonly limitUpPrice?: number | null;
  readonly limitDownPrice?: number | null;
  readonly adjType?: string | null;
  readonly corporateActions?: unknown;
  readonly visibleAt?: Date | null;
}

/** 合法且可进入严格成交回测的复权口径（后复权 / 不复权）。前复权 'qfq' 不在内。 */
export const STRICT_BACKTEST_ALLOWED_ADJ_TYPES = new Set(['hfq', 'none', null]);

/** 合法且可进入严格成交回测的 K 线复权口径：后复权 hfq / 不复权 none。未知(null) 与前复权(qfq) 一律拒绝。 */
export const STRICT_CANDLE_ADJ_TYPES: ReadonlySet<string> = new Set(['hfq', 'none']);

export const isAdmissibleCandleAdjType = (value: unknown): boolean =>
  typeof value === 'string' && STRICT_CANDLE_ADJ_TYPES.has(value);

export class StrictBacktestRejectedError extends Error {
  public readonly versionId: string | null;

  public readonly reasons: readonly string[];

  public constructor(versionId: string | null, reasons: readonly string[]) {
    super(`严格成交回测拒绝未通过口径校验的数据集（versionId=${versionId ?? 'n/a'}）：${reasons.join('; ')}`);
    this.name = 'StrictBacktestRejectedError';
    this.versionId = versionId;
    this.reasons = reasons;
  }
}

export interface DatasetImportReport {
  readonly versionId: string;
  readonly source: string;
  readonly revision: string;
  readonly recordCount: number;
  readonly coverageStart: Date | null;
  readonly coverageEnd: Date | null;
  readonly checksum: string;
  /** 各「未知字段」出现的次数（表示方式：null 表示未知）。 */
  readonly unknownFieldCounts: Readonly<Record<string, number>>;
  readonly representation: 'null-means-unknown';
}

const KNOWN_UNKNOWN_FIELDS = [
  'tradingStatus',
  'limitUpPrice',
  'limitDownPrice',
  'adjType',
  'corporateActions',
] as const;

export interface NormalizedRecord {
  readonly record: CandleImportRecord;
  readonly unknownFields: ReadonlySet<string>;
}

/** 归一化单条记录：缺失/非法字段标为 null（未知），并统计未知字段。 */
export const normalizeCandleImportRecord = (raw: Record<string, unknown>): NormalizedRecord => {
  const unknownFields = new Set<string>();
  const mark = (field: string, value: unknown): unknown => {
    if (value === undefined || value === null || value === '') {
      unknownFields.add(field);
      return null;
    }
    if (field === 'adjType' && value !== 'hfq' && value !== 'none') {
      // 前复权(qfq) 及任何非后复权/不复权口径一律视为「未通过口径校验」，标为未知(null)；
      // 严格回测路径据此显式拒绝，绝不静默参与。
      unknownFields.add(field);
      return null;
    }
    return value;
  };

  const record: CandleImportRecord = {
    stockId: String(raw.stockId),
    tradingDay: raw.tradingDay instanceof Date ? raw.tradingDay : new Date(raw.tradingDay as string),
    open: Number(raw.open),
    high: Number(raw.high),
    low: Number(raw.low),
    close: Number(raw.close),
    volume: Number(raw.volume),
    tradingStatus: mark('tradingStatus', raw.tradingStatus) as string | null,
    limitUpPrice: mark('limitUpPrice', raw.limitUpPrice) as number | null,
    limitDownPrice: mark('limitDownPrice', raw.limitDownPrice) as number | null,
    adjType: mark('adjType', raw.adjType) as string | null,
    corporateActions: mark('corporateActions', raw.corporateActions),
    visibleAt: raw.visibleAt ? new Date(raw.visibleAt as string | Date) : null,
  };

  return { record, unknownFields };
};

export const computeDatasetChecksum = (records: readonly CandleImportRecord[]): string => {
  const canonical = records
    .map(r => [
      r.stockId,
      r.tradingDay.toISOString(),
      r.open, r.high, r.low, r.close, r.volume,
      r.tradingStatus ?? '∅', r.limitUpPrice ?? '∅', r.limitDownPrice ?? '∅',
      r.adjType ?? '∅',
    ].join('|'))
    .join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

export interface ImportMarketDatasetInput {
  readonly source: string;
  readonly asOf: Date;
  readonly records: readonly (Record<string, unknown> | CandleImportRecord)[];
  readonly revision?: string;
  readonly writeCandles?: boolean;
}

export const importMarketDataset = async (
  prisma: any,
  input: ImportMarketDatasetInput,
): Promise<DatasetImportReport> => {
  const normalized = input.records.map(raw => normalizeCandleImportRecord(raw as Record<string, unknown>));

  const records = normalized.map(n => n.record);
  const unknownFieldCounts: Record<string, number> = {};
  for (const field of KNOWN_UNKNOWN_FIELDS) {
    unknownFieldCounts[field] = normalized.filter(n => n.unknownFields.has(field)).length;
  }

  const checksum = computeDatasetChecksum(records);
  const revision = input.revision
    ?? crypto.createHash('sha256').update(`${input.source}:${input.asOf.toISOString()}:${checksum}`).digest('hex').slice(0, 16);

  const tradingDays = records.map(r => r.tradingDay.getTime());
  const coverageStart = tradingDays.length ? new Date(Math.min(...tradingDays)) : null;
  const coverageEnd = tradingDays.length ? new Date(Math.max(...tradingDays)) : null;

  const version = await prisma.marketDatasetVersion.create({
    data: {
      source: input.source,
      asOf: input.asOf,
      revision,
      checksum,
      coverageStart,
      coverageEnd,
    },
  });

  if (input.writeCandles) {
    for (const record of records) {
      await prisma.candle.upsert({
        where: {
          stockId_tradingDay: {
            stockId: record.stockId,
            tradingDay: record.tradingDay,
          },
        },
        create: {
          stockId: record.stockId,
          tradingDay: record.tradingDay,
          open: record.open,
          high: record.high,
          low: record.low,
          close: record.close,
          volume: BigInt(record.volume),
          tradingStatus: record.tradingStatus,
          limitUpPrice: record.limitUpPrice,
          limitDownPrice: record.limitDownPrice,
          adjType: record.adjType,
          visibleAt: record.visibleAt,
          datasetVersionId: version.id,
        },
        update: {
          tradingStatus: record.tradingStatus,
          limitUpPrice: record.limitUpPrice,
          limitDownPrice: record.limitDownPrice,
          adjType: record.adjType,
          visibleAt: record.visibleAt,
          datasetVersionId: version.id,
        },
      });
    }
  }

  return {
    versionId: version.id,
    source: input.source,
    revision,
    recordCount: records.length,
    coverageStart,
    coverageEnd,
    checksum,
    unknownFieldCounts,
    representation: 'null-means-unknown',
  };
};

/** 从 JSONL 文件导入：每行一个 JSON 对象（CandleImportRecord 形状）。 */
export const importMarketDatasetFromJsonl = async (
  prisma: any,
  input: { readonly filePath: string; readonly source: string; readonly asOf: Date; readonly revision?: string },
): Promise<DatasetImportReport> => {
  const text = readFileSync(input.filePath, 'utf8');
  const records = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>);
  return importMarketDataset(prisma, {
    source: input.source,
    asOf: input.asOf,
    records,
    revision: input.revision,
    writeCandles: true,
  });
};

/**
 * 严格成交回测路径的口径校验开关。
 * 「前复权(qfq)」在归一化阶段即被折叠为未知(null)，因此凡 adjType 未知（含前复权）
 * 一律拒绝：抛 StrictBacktestRejectedError，绝不静默参与严格回测。
 */
export const assertStrictBacktestAllowed = (
  report: DatasetImportReport,
  _opts: { readonly requireKnownAdjType?: boolean } = {},
): void => {
  const unknownAdjType = report.unknownFieldCounts.adjType ?? 0;
  if (unknownAdjType > 0) {
    throw new StrictBacktestRejectedError(report.versionId, [
      `${unknownAdjType} 条记录复权口径(adjType)未知或为前复权(qfq)，禁止进入严格成交回测`,
    ]);
  }
};

/**
 * 行情准入模式：
 *  - permissive（默认）：不拦截回测，只统计并记录 unknown / 前复权 adjType 计数，作为数据缺口证据。
 *  - strict：显式要求（`strictDataAdmission: true` 或 M7 评估路径直接调用校验函数），
 *    窗口内出现 qfq / 未知 adjType 时抛 StrictBacktestRejectedError。
 * 两种模式都不放宽任何可见性边界（业务时间 ∧ 可信可见时间仍由 readCandles 强制）。
 */
export type MarketDataAdmissionMode = 'permissive' | 'strict';

export interface MarketDataAdmissionInput {
  /** 限定同一 cluster 的股票；省略时不按 cluster 过滤。 */
  readonly clusterKey?: string;
  readonly datasetVersionId?: string | null;
  readonly fromTradingDay: Date;
  readonly toTradingDay: Date;
}

export interface MarketDataAdmissionReport {
  readonly mode: MarketDataAdmissionMode;
  /** 窗口内 adjType 未知(null) 或前复权(qfq) 的 K 线数；数据源无统计能力时为 null。 */
  readonly unknownAdjTypeCount: number | null;
  /** 是否真的执行了严格校验（permissive 恒为 false）。 */
  readonly checked: boolean;
  readonly datasetVersionId: string | null;
  readonly fromTradingDay: Date;
  readonly toTradingDay: Date;
  readonly reasons: readonly string[];
}

/** 构造「复权口径未知 / 前复权」的 K 线过滤条件（供 count / findMany 复用）。 */
export const buildUnknownAdjTypeWhere = (
  input: MarketDataAdmissionInput,
): Record<string, unknown> => {
  const where: Record<string, unknown> = {
    tradingDay: { gte: input.fromTradingDay, lte: input.toTradingDay },
    OR: [{ adjType: null }, { adjType: { notIn: [...STRICT_CANDLE_ADJ_TYPES] } }],
    ...datasetVersionWhere(input.datasetVersionId),
  };
  if (input.clusterKey !== undefined) {
    where.stock = { clusterKey: input.clusterKey };
  }
  return where;
};

/**
 * 严格复权口径准入（同步、逐行）。供回测 strict 路径与 M7 评估 / 验收路径显式调用：
 * 任一行 adjType 不是 hfq/none（含 null=未知、qfq=前复权）即抛 StrictBacktestRejectedError。
 * 默认路径不调用本函数（permissive 只记录计数，不拦截），因此不会让每日推荐链路崩溃。
 */
export const assertStrictMarketDataAdmission = (
  candles: readonly { readonly adjType?: unknown }[],
  opts: { readonly versionId?: string | null; readonly context?: string } = {},
): void => {
  const badCount = candles.filter(candle => !isAdmissibleCandleAdjType(candle?.adjType)).length;
  if (badCount === 0) {
    return;
  }
  throw new StrictBacktestRejectedError(opts.versionId ?? null, [
    `${badCount}/${candles.length} 条 K 线复权口径(adjType)未知或为前复权(qfq)，禁止进入严格成交回测（${opts.context ?? 'backtest replay window'}）`,
    '严格模式由调用方显式要求（strictDataAdmission=true / assertStrictMarketDataAdmission）；'
    + '每日推荐默认 permissive，不会被该缺口阻断，但缺口会记入 marketDataAdmission 报告',
  ]);
};

/** 统计窗口内 unknown / 前复权 adjType 的 K 线数；数据源无 candle.count 能力时返回 null（未知，不假定为 0）。 */
export const countUnknownAdjTypeCandles = async (
  prisma: any,
  input: MarketDataAdmissionInput,
): Promise<number | null> => {
  if (!hasDelegate(prisma, 'candle', 'count')) {
    return null;
  }
  const raw = await prisma.candle.count({ where: buildUnknownAdjTypeWhere(input) });
  return Number(raw) || 0;
};

/**
 * 回测路径的行情准入报告（在读取任何特征 / 对账 K 线之前调用，保证缺口先于评分可见）。
 *  - strict=false（默认）：只统计计数并记录 permissive 证据，绝不抛错。
 *  - strict=true：计数 > 0 直接抛 StrictBacktestRejectedError；数据源无统计能力时
 *    记录「改为行级校验」，由调用方对实际读出的 K 线调用 assertStrictMarketDataAdmission。
 */
export const collectMarketDataAdmission = async (
  prisma: any,
  input: MarketDataAdmissionInput,
  opts: { readonly strict?: boolean; readonly versionId?: string | null } = {},
): Promise<MarketDataAdmissionReport> => {
  const strict = opts.strict === true;
  const versionId = opts.versionId ?? input.datasetVersionId ?? null;
  const unknownAdjTypeCount = await countUnknownAdjTypeCandles(prisma, input);
  const base = {
    datasetVersionId: versionId,
    unknownAdjTypeCount,
    fromTradingDay: input.fromTradingDay,
    toTradingDay: input.toTradingDay,
  };
  const window = `${input.fromTradingDay.toISOString()} ~ ${input.toTradingDay.toISOString()}`;

  if (!strict) {
    return {
      ...base,
      mode: 'permissive',
      checked: false,
      reasons: [
        `行情准入 permissive（默认）：窗口 ${window} 内 adjType 未知/前复权 K 线 `
        + `${unknownAdjTypeCount === null ? '计数不可得（数据源无 candle.count）' : `${unknownAdjTypeCount} 条`}，`
        + '仅记录数据缺口证据，不阻断回测；可见性双时间边界仍强制生效',
      ],
    };
  }

  if (unknownAdjTypeCount === null) {
    return {
      ...base,
      mode: 'strict',
      checked: false,
      reasons: [`行情准入 strict：数据源无 candle.count，窗口 ${window} 的 adjType 计数不可得，改为对实际读出的 K 线逐行校验`],
    };
  }

  if (unknownAdjTypeCount > 0) {
    throw new StrictBacktestRejectedError(versionId, [
      `strictDataAdmission=true 且窗口 ${window} 内 ${unknownAdjTypeCount} 条 K 线复权口径(adjType)未知或为前复权(qfq)，禁止进入严格成交回测`,
      `运行前请回填 Candle.adjType（hfq/none）；每日推荐路径默认 permissive，不受影响`,
    ]);
  }

  return {
    ...base,
    mode: 'strict',
    checked: true,
    reasons: [`行情准入 strict：窗口 ${window} 内 K 线复权口径均为 hfq/none`],
  };
};
