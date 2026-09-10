/**
 * 股票历史状态解析（asOf 维度）。
 *
 * 数据源：StockStatusHistory。在给定 asOf 下，适用记录为满足 effectiveFrom <= asOf 的
 * 最新一条。若没有任何适用记录，必须返回「数据缺口」——**绝不**把今天的行业 / ST / 上市
 * 退市名单套用到过去。
 */
export interface StockHistoricalStatus {
  readonly symbol: string;
  readonly effectiveFrom: Date;
  readonly isST: boolean;
  readonly industry: string | null;
  readonly listedAt: Date | null;
  readonly delistedAt: Date | null;
  readonly source: string | null;
}

export class StockStatusCoverageGapError extends Error {
  public readonly symbol: string;

  public readonly asOf: string;

  public constructor(symbol: string, asOf: Date) {
    super(`股票历史状态数据缺口：symbol=${symbol} 在 asOf=${asOf.toISOString()} 无适用 StockStatusHistory 记录`);
    this.name = 'StockStatusCoverageGapError';
    this.symbol = symbol;
    this.asOf = asOf.toISOString();
  }
}

/**
 * 按 asOf 解析股票历史状态。
 * 适用记录：effectiveFrom <= asOf 中 effectiveFrom 最大者。
 * 无适用记录 → 抛 StockStatusCoverageGapError（数据缺口）。
 * 注意：hasDelegate 守卫由调用方负责（缺失委托时不应调用本函数）。
 */
export const resolveStockStatusAsOf = async (
  prisma: any,
  symbol: string,
  asOf: Date,
): Promise<StockHistoricalStatus> => {
  const rows = await prisma.stockStatusHistory.findMany({
    where: { symbol },
    orderBy: { effectiveFrom: 'desc' },
  });

  let applicable: any = null;
  for (const row of rows) {
    const effectiveFrom = row.effectiveFrom instanceof Date ? row.effectiveFrom : new Date(row.effectiveFrom);
    if (effectiveFrom.getTime() <= asOf.getTime()) {
      applicable = row;
      break;
    }
  }

  if (!applicable) {
    throw new StockStatusCoverageGapError(symbol, asOf);
  }

  return {
    symbol,
    effectiveFrom: applicable.effectiveFrom instanceof Date ? applicable.effectiveFrom : new Date(applicable.effectiveFrom),
    isST: Boolean(applicable.isST),
    industry: applicable.industry ?? null,
    listedAt: applicable.listedAt ? new Date(applicable.listedAt) : null,
    delistedAt: applicable.delistedAt ? new Date(applicable.delistedAt) : null,
    source: applicable.source ?? null,
  };
};

/** 批量解析，返回 symbol -> 状态；缺口的 symbol 不出现在结果中（由调用方决定是否视为 gap）。 */
export const resolveStockStatusBatch = async (
  prisma: any,
  symbols: readonly string[],
  asOf: Date,
): Promise<Map<string, StockHistoricalStatus>> => {
  const result = new Map<string, StockHistoricalStatus>();
  for (const symbol of symbols) {
    try {
      result.set(symbol, await resolveStockStatusAsOf(prisma, symbol, asOf));
    } catch (err) {
      if (err instanceof StockStatusCoverageGapError) {
        continue;
      }
      throw err;
    }
  }
  return result;
};
