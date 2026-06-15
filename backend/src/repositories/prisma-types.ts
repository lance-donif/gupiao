export interface IPrismaNewsRecord {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly source: string;
  readonly keywords?: readonly string[];
  readonly sourceRef?: string | null;
  readonly publishedAt: Date;
  readonly capturedAt: Date;
  readonly clusterKey: string;
  readonly runContextId?: string | null;
}

export interface IPrismaCandleRecord {
  readonly id?: string;
  readonly tradingDay: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly capturedAt: Date;
}

export interface IPrismaStockRecord {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly industry: string;
  readonly exchange?: string | null;
  readonly clusterKey: string;
  readonly runContextId?: string | null;
  readonly lastSyncedAt?: Date | null;
  readonly latestTradeDay?: Date | null;
  readonly candles: readonly IPrismaCandleRecord[];
}

export interface IPrismaNewsDelegate {
  create: (args: { data: IPrismaNewsRecord }) => Promise<IPrismaNewsRecord>;
  createMany: (args: { data: readonly IPrismaNewsRecord[] }) => Promise<{ count: number }>;
  delete: (args: { where: { id: string } }) => Promise<IPrismaNewsRecord>;
  findUnique: (args: { where: { id: string } }) => Promise<IPrismaNewsRecord | null>;
  findMany: () => Promise<readonly IPrismaNewsRecord[]>;
}

export interface IPrismaStockDelegate {
  create: (args: { data: IPrismaStockRecord }) => Promise<IPrismaStockRecord>;
  delete: (args: { where: { id: string } }) => Promise<IPrismaStockRecord>;
  findUnique: (args: { where: { id: string } }) => Promise<IPrismaStockRecord | null>;
  findMany: () => Promise<readonly IPrismaStockRecord[]>;
}

export interface IPrismaRawNewsRecord {
  readonly id?: string;
  readonly title: string;
  readonly content: string;
  readonly source: string;
  readonly url: string;
  readonly publishedAt: Date;
  readonly capturedAt?: Date;
  readonly clusterKey: string;
  readonly rawMetadata: any;
  readonly titleHash: string;
}

export interface IPrismaNormalizedNewsRecord {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly source: string;
  readonly url: string;
  readonly publishedAt: Date;
  readonly capturedAt?: Date;
  readonly clusterKey: string;
  readonly reprintGroupId?: string | null;
  readonly reprintWeight?: any;
}

export interface IPrismaRawNewsDelegate {
  create: (args: { data: IPrismaRawNewsRecord }) => Promise<IPrismaRawNewsRecord>;
  createMany: (args: { data: readonly IPrismaRawNewsRecord[] }) => Promise<{ count: number }>;
}

export interface IPrismaNormalizedNewsDelegate {
  create: (args: { data: IPrismaNormalizedNewsRecord }) => Promise<IPrismaNormalizedNewsRecord>;
  createMany: (
    args: { data: readonly IPrismaNormalizedNewsRecord[] },
  ) => Promise<{ count: number }>;
}

export interface IPrismaTransactionalClient {
  readonly newsItem: IPrismaNewsDelegate;
  readonly stock: IPrismaStockDelegate;
  readonly rawNewsRecord: IPrismaRawNewsDelegate;
  readonly normalizedNewsRecord: IPrismaNormalizedNewsDelegate;
}

export interface IPrismaClient extends IPrismaTransactionalClient {
  $transaction: <T>(
    callback: (transaction: IPrismaTransactionalClient) => Promise<T>,
  ) => Promise<T>;
}
