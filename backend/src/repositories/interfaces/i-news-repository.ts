import type { NewsItem } from '../../types/entities/news-item.js';
import type { IPrismaNormalizedNewsRecord, IPrismaRawNewsRecord } from '../prisma-types.js';

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
}
