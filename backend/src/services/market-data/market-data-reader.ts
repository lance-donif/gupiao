/**
 * 统一行情读取接口与严格时间边界守卫。
 *
 * 任何用于「特征」的日 K 线读取都必须经过本模块：
 *  - 业务时间校验：candle.tradingDay <= asOf（不得使用 asOf 之后的交易日数据）
 *  - 可信可见时间校验：effectiveVisibleAt(candle) <= asOf
 *    日 K 线只有在该交易时段结束、且数据已可见后才可用于特征；盘中不得读取
 *    当日尚未结束/尚未发布的完整日线。
 *
 * 缺 visibleAt 时回退到 yield-visibility 的 dailyCloseVisibleAt（交易日 15:00 +08:00），
 * 不得因为字段缺失就放行。
 *
 * 数据修订版本（dataset version）：同一轮首次读取即固定 datasetVersionId，恢复时
 * 继续沿用（提供显式传参与默认解析两条路径，见 DatasetVersionResolver）。
 */
import { dailyCloseVisibleAt } from '../yield-visibility.js';

export interface CandleVisibilityInput {
  readonly tradingDay: Date;
  readonly visibleAt?: Date | null | undefined;
}

export interface ReadCandleRow {
  readonly stockId: string;
  readonly tradingDay: Date;
  readonly open?: unknown;
  readonly high?: unknown;
  readonly low?: unknown;
  readonly close?: unknown;
  readonly volume?: unknown;
  /** 交易状态（NORMAL/LIMIT_UP/...）；来源缺失时为 null（未知），不得推测。 */
  readonly tradingStatus?: string | null;
  /** 复权口径（hfq/none）；未知或前复权(qfq) 一律为 null，严格回测据此拒绝。 */
  readonly adjType?: string | null;
  readonly visibleAt?: Date | null;
  readonly datasetVersionId?: string | null;
  readonly [key: string]: unknown;
}

/** 计算一条 K 线的「有效可见时间」：显式 visibleAt 优先，否则回退到 15:00 收盘。 */
export function candleVisibleAt(candle: CandleVisibilityInput): Date {
  if (candle.visibleAt != null) {
    const parsed = new Date(candle.visibleAt as Date);
    if (Number.isFinite(parsed.getTime())) {
      return parsed;
    }
  }
  return dailyCloseVisibleAt(candle.tradingDay);
}

/**
 * 严格双重时间边界校验。只有业务时间（tradingDay <= asOf）与可信可见时间
 * （effectiveVisibleAt <= asOf）同时满足时，该 K 线才可用于特征。
 * 返回 false 即视为「未来/盘中泄漏」，不得纳入特征。
 */
export function isCandleVisibleAsOf(candle: CandleVisibilityInput, asOf: Date): boolean {
  if (candle.tradingDay.getTime() > asOf.getTime()) {
    return false;
  }
  return candleVisibleAt(candle).getTime() <= asOf.getTime();
}

/** 过滤出在 asOf 时点已可用于特征的 K 线（去除未来/盘中泄漏）。 */
export function filterVisibleCandles<T extends CandleVisibilityInput>(
  candles: readonly T[],
  asOf: Date,
): T[] {
  return candles.filter(candle => isCandleVisibleAsOf(candle, asOf));
}

/**
 * 构建 Prisma 的 datasetVersionId 过滤条件。
 *  - undefined：不加任何过滤（兼容旧逻辑，不引入 dataset 维度）
 *  - null：只取未归属任何数据集版本的 K 线
 *  - string：只取指定 datasetVersionId 的 K 线
 */
export function datasetVersionWhere(
  datasetVersionId: string | null | undefined,
): Record<string, unknown> {
  if (datasetVersionId === undefined) {
    return {};
  }
  if (datasetVersionId === null) {
    return { datasetVersionId: null };
  }
  return { datasetVersionId };
}

/**
 * 固定一轮运行的数据修订版本。
 *  - 显式传入的 id 直接生效并保持固定（恢复历史运行时沿用同一 revision）。
 *  - 未显式传入时走默认解析路径：解析一次（取最新 MarketDatasetVersion）并缓存，
 *    同一轮内不再变化。
 * resolve() 返回 undefined 表示「不施加 dataset 维度过滤」（旧行为）。
 */
export class DatasetVersionResolver {
  private resolved: string | null | undefined;

  public constructor(private readonly explicitId?: string | null) {}

  public get explicit(): string | null | undefined {
    return this.explicitId;
  }

  public async resolve(prisma: any): Promise<string | null | undefined> {
    if (this.explicitId !== undefined) {
      return this.explicitId;
    }
    if (this.resolved === undefined) {
      this.resolved = await resolveLatestDatasetVersionId(prisma);
    }
    return this.resolved;
  }
}

export async function resolveLatestDatasetVersionId(prisma: any): Promise<string | null> {
  if (!prisma || typeof prisma.marketDatasetVersion?.findFirst !== 'function') {
    return null;
  }
  const row = await prisma.marketDatasetVersion.findFirst({
    orderBy: { importedAt: 'desc' },
    select: { id: true },
  });
  return (row?.id as string | undefined) ?? null;
}

/** 将 datasetVersionId 拼接到原始 SQL（返回片段与参数）。参数为下一个 $ 序号。 */
export function buildDatasetSqlClause(
  datasetVersionId: string | null | undefined,
  nextParamIndex: number,
): { clause: string; param: string | null } {
  if (datasetVersionId === undefined) {
    return { clause: '', param: null };
  }
  if (datasetVersionId === null) {
    return { clause: ` AND c."datasetVersionId" IS NULL`, param: null };
  }
  return { clause: ` AND c."datasetVersionId" = $${nextParamIndex}`, param: datasetVersionId };
}

/**
 * 规范化的 K 线读取入口：
 *  - 业务时间下界（fromTradingDay，避免无界扫描）+ 上界（tradingDay <= asOf）
 *  - 可信可见时间：SQL 侧先施加「visibleAt 为空或 <= asOf」的粗过滤，返回后再由
 *    isCandleVisibleAsOf 做权威过滤（含 visibleAt 缺失时回退 15:00 收盘），双保险，
 *    保证「无字段放行」不会发生。
 *  - 同时回传 tradingStatus / adjType（缺失即 null = 未知），供严格回测准入与收益对账使用。
 * 优先走 $queryRawUnsafe（性能），否则回退到 Prisma findMany。
 */
export async function readCandles(
  prisma: any,
  opts: {
    /** 可选 cluster 过滤；省略时不按 clusterKey 限定（兼容仅按 stockId 读取的旧回退路径）。 */
    readonly clusterKey?: string;
    readonly asOf: Date;
    readonly stockIds: readonly string[];
    readonly fromTradingDay?: Date;
    readonly datasetVersionId?: string | null;
    readonly columns?: readonly string[];
    readonly limitPerStock?: number;
  },
): Promise<ReadCandleRow[]> {
  const columns = opts.columns ?? [
    'c."tradingDay"', 'c.open', 'c.high', 'c.low', 'c.close', 'c.volume',
    'c."tradingStatus"', 'c."adjType"', 'c."visibleAt"', 'c."datasetVersionId"',
  ];
  const fromTradingDay = opts.fromTradingDay
    ?? new Date(opts.asOf.getTime() - 365 * 3 * 24 * 60 * 60 * 1000);
  const params: unknown[] = [];
  const pushParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const asOfParam = pushParam(opts.asOf);
  const stockIdsParam = pushParam([...opts.stockIds]);
  const fromParam = pushParam(fromTradingDay);
  const clusterClause = opts.clusterKey !== undefined
    ? ` AND s."clusterKey" = ${pushParam(opts.clusterKey)}`
    : '';
  let datasetClause = '';
  if (opts.datasetVersionId === null) {
    datasetClause = ' AND c."datasetVersionId" IS NULL';
  } else if (opts.datasetVersionId !== undefined) {
    datasetClause = ` AND c."datasetVersionId" = ${pushParam(opts.datasetVersionId)}`;
  }

  if (typeof prisma?.$queryRawUnsafe === 'function') {
    const rows = await prisma.$queryRawUnsafe(
      [
        `SELECT s.id AS "stockId", ${columns.join(', ')}`,
        'FROM "Stock" s',
        `JOIN "Candle" c ON c."stockId" = s.id AND c."tradingDay" <= ${asOfParam} AND c."tradingDay" >= ${fromParam}`
          + ` AND (c."visibleAt" IS NULL OR c."visibleAt" <= ${asOfParam})${datasetClause}`,
        `WHERE s.id = ANY(${stockIdsParam}::text[])${clusterClause}`,
        'ORDER BY s.id ASC, c."tradingDay" DESC',
      ].join(' '),
      ...params,
    ) as readonly any[];

    return rows
      .map((row: any) => ({
        stockId: String(row.stockId),
        tradingDay: new Date(row.tradingDay),
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        tradingStatus: row.tradingStatus != null ? String(row.tradingStatus) : null,
        adjType: row.adjType != null ? String(row.adjType) : null,
        visibleAt: row.visibleAt ? new Date(row.visibleAt) : null,
        datasetVersionId: row.datasetVersionId ?? null,
      }))
      .filter((row: ReadCandleRow) => isCandleVisibleAsOf(row, opts.asOf));
  }

  const candles = await prisma.candle.findMany({
    where: {
      stockId: { in: [...opts.stockIds] },
      tradingDay: { lte: opts.asOf, gte: fromTradingDay },
      ...datasetVersionWhere(opts.datasetVersionId),
    },
    orderBy: [
      { stockId: 'asc' },
      { tradingDay: 'desc' },
    ],
  });

  return (candles as readonly any[])
    .map((row: any) => ({
      stockId: String(row.stockId),
      tradingDay: new Date(row.tradingDay),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      tradingStatus: row.tradingStatus != null ? String(row.tradingStatus) : null,
      adjType: row.adjType != null ? String(row.adjType) : null,
      visibleAt: row.visibleAt ? new Date(row.visibleAt) : null,
      datasetVersionId: row.datasetVersionId ?? null,
    }))
    .filter((row: ReadCandleRow) => isCandleVisibleAsOf(row, opts.asOf));
}
