import type { INewsRepository } from './interfaces/i-news-repository.js';
import type { IPrismaNewsRecord, IPrismaNormalizedNewsRecord, IPrismaRawNewsRecord, IPrismaTransactionalClient } from './prisma-types.js';

import { NewsItem } from '../types/entities/news-item.js';
import { Timestamp } from '../types/value-objects/timestamp.js';

const DEFAULT_NEWS_CLUSTER_KEY = 'global';

const resolveCapturedAt = (record: Pick<IPrismaNewsRecord, 'capturedAt' | 'publishedAt'>): Date => {
  return record.capturedAt;
};

const mapRecordToNewsItem = (record: IPrismaNewsRecord): NewsItem => {
  void record.clusterKey;
  void record.runContextId;
  void record.sourceRef;
  void resolveCapturedAt(record);

  return new NewsItem(
    record.id,
    record.title,
    record.content,
    record.source,
    Timestamp.from(record.publishedAt),
  );
};

const mapNewsItemToRecord = (item: NewsItem): IPrismaNewsRecord => {
  return {
    id: item.id,
    title: item.title,
    content: item.content,
    source: item.source,
    keywords: item.keywords.map(keyword => keyword.word),
    publishedAt: item.publishedAt.toDate(),
    capturedAt: item.publishedAt.toDate(),
    clusterKey: DEFAULT_NEWS_CLUSTER_KEY,
    sourceRef: null,
    runContextId: null,
  };
};

export class PrismaNewsRepository implements INewsRepository {
  public constructor(
    private readonly prisma: Pick<
      IPrismaTransactionalClient,
      'newsItem' | 'rawNewsRecord' | 'normalizedNewsRecord'
    >,
  ) {}

  public async add(item: NewsItem): Promise<void> {
    await this.prisma.newsItem.create({
      data: mapNewsItemToRecord(item),
    });
  }

  public async addRawRecord(record: IPrismaRawNewsRecord): Promise<void> {
    await this.prisma.rawNewsRecord.create({
      data: record,
    });
  }

  public async addNormalizedRecord(record: IPrismaNormalizedNewsRecord): Promise<void> {
    await this.prisma.normalizedNewsRecord.create({
      data: record,
    });
  }

  public async remove(id: string): Promise<void> {
    await this.prisma.newsItem.delete({
      where: { id },
    });
  }

  public async findById(id: string): Promise<NewsItem | null> {
    const record = await this.prisma.newsItem.findUnique({
      where: { id },
    });

    return record ? mapRecordToNewsItem(record) : null;
  }

  public async findAll(): Promise<readonly NewsItem[]> {
    const records = await this.prisma.newsItem.findMany();

    return records.map(mapRecordToNewsItem);
  }
}
