export interface IStockHistoryTarget {
  readonly symbol: string;
  readonly sourceSymbol: string;
  readonly exchange: string;
  readonly name: string;
  readonly industry: string;
}

export interface IStockHistoryCandle {
  readonly tradingDay: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: bigint;
}

export interface IStockHistoryWindow {
  readonly startDate: string;
  readonly endDate: string;
}

export type StockHistoryProvider = 'Yahoo' | 'Baostock';

export interface IStockHistoryFetchResult {
  readonly target: IStockHistoryTarget;
  readonly provider: StockHistoryProvider;
  readonly candles: readonly IStockHistoryCandle[];
}

export type StockHistorySyncStatus = '完成' | '跳过' | '失败';

export interface IStockHistoryItemResult {
  readonly symbol: string;
  readonly name: string;
  readonly status: StockHistorySyncStatus;
  readonly source: StockHistoryProvider | null;
  readonly candleCount: number;
  readonly latestTradeDay: string | null;
  readonly message: string;
}

export interface IStockHistorySyncOptions {
  readonly databaseUrl: string;
  readonly clusterKey: string;
  readonly limit: number;
  readonly concurrency: number;
  readonly asOf: Date;
  readonly symbolFilter: readonly string[];
  readonly incremental?: boolean;
}

export interface IStockHistorySyncSummary {
  readonly 状态: '完成' | '有失败';
  readonly 范围: IStockHistoryWindow;
  readonly 股票数: number;
  readonly 完成: number;
  readonly 跳过: number;
  readonly 失败: number;
  readonly 请求数: number;
  readonly K线数: number;
  readonly 最新交易日: string | null;
  readonly 失败样例: readonly IStockHistoryItemResult[];
  readonly 数据库核验: Record<string, unknown>;
}
