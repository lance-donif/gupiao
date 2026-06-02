import type { NewsItem } from '../../types/entities/news-item.js';
import type { IPrismaNormalizedNewsRecord, IPrismaRawNewsRecord } from '../prisma-types.js';

export interface INewsRepository {
  add: (item: NewsItem) => Promise<void>;
  remove: (id: string) => Promise<void>;
  findById: (id: string) => Promise<NewsItem | null>;
  findAll: () => Promise<readonly NewsItem[]>;
  addRawRecord: (record: IPrismaRawNewsRecord) => Promise<void>;
  addNormalizedRecord: (record: IPrismaNormalizedNewsRecord) => Promise<void>;
}
