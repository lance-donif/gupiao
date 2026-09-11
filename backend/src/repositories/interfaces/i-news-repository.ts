import type { NewsItem } from '../../types/entities/news-item.js';
import type { IPrismaNormalizedNewsRecord, IPrismaRawNewsRecord } from '../prisma-types.js';

export interface ICrossBatchNewsRecord {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly reprintGroupId: string | null;
  readonly publishedAt: Date;
}

export interface INewsRepository {
  add: (item: NewsItem) => Promise<void>;
  addMany: (items: readonly NewsItem[]) => Promise<void>;
  remove: (id: string) => Promise<void>;
  findById: (id: string) => Promise<NewsItem | null>;
  findAll: () => Promise<readonly NewsItem[]>;
  addRawRecord: (record: IPrismaRawNewsRecord) => Promise<void>;
  addManyRawRecords: (records: readonly IPrismaRawNewsRecord[]) => Promise<void>;
  addNormalizedRecord: (record: IPrismaNormalizedNewsRecord) => Promise<void>;
  addManyNormalizedRecords: (
    records: readonly IPrismaNormalizedNewsRecord[],
  ) => Promise<void>;
  /**
   * 跨批转载归并候选集：同 clusterKey、publishedAt 相近且不晚于 asOf。
   * 单次查询，调用方内存比对；无 N+1。
   */
  findRecentNormalizedRecords: (
    clusterKey: string,
    since: Date,
    asOf: Date,
  ) => Promise<readonly ICrossBatchNewsRecord[]>;}
