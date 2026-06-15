import type { NewsItem } from '../types/entities/news-item.js';
import type { Stock } from '../types/entities/stock.js';
import type { INewsRepository } from './interfaces/i-news-repository.js';
import type { IStockRepository } from './interfaces/i-stock-repository.js';

import type { IPrismaClient, IPrismaTransactionalClient } from './prisma-types.js';
import { PrismaNewsRepository } from './news-repository.js';
import { PrismaStockRepository } from './stock-repository.js';

export interface IUnitOfWork {
  readonly newsRepository: INewsRepository;
  readonly stockRepository: IStockRepository;
  register: (operation: (context: IUnitOfWorkContext) => Promise<void>) => void;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

export interface IUnitOfWorkContext {
  readonly newsRepository: INewsRepository;
  readonly stockRepository: IStockRepository;
}

type IUnitOfWorkOperation = (context: IUnitOfWorkContext) => Promise<void>;

const createContext = (transaction: IPrismaTransactionalClient): IUnitOfWorkContext => {
  return {
    newsRepository: new PrismaNewsRepository(transaction),
    stockRepository: new PrismaStockRepository(transaction),
  };
};

class DeferredNewsRepository implements INewsRepository {
  public constructor(
    private readonly repository: INewsRepository,
    private readonly enqueue: (operation: IUnitOfWorkOperation) => void,
  ) {}

  public add(item: NewsItem): Promise<void> {
    this.enqueue(async ({ newsRepository }) => {
      await newsRepository.add(item);
    });
    return Promise.resolve();
  }

  public addMany(items: readonly NewsItem[]): Promise<void> {
    this.enqueue(async ({ newsRepository }) => {
      await newsRepository.addMany(items);
    });
    return Promise.resolve();
  }

  public addRawRecord(record: any): Promise<void> {
    this.enqueue(async ({ newsRepository }) => {
      await newsRepository.addRawRecord(record);
    });
    return Promise.resolve();
  }

  public addManyRawRecords(records: readonly any[]): Promise<void> {
    this.enqueue(async ({ newsRepository }) => {
      await newsRepository.addManyRawRecords(records);
    });
    return Promise.resolve();
  }

  public addNormalizedRecord(record: any): Promise<void> {
    this.enqueue(async ({ newsRepository }) => {
      await newsRepository.addNormalizedRecord(record);
    });
    return Promise.resolve();
  }

  public addManyNormalizedRecords(records: readonly any[]): Promise<void> {
    this.enqueue(async ({ newsRepository }) => {
      await newsRepository.addManyNormalizedRecords(records);
    });
    return Promise.resolve();
  }

  public remove(id: string): Promise<void> {
    this.enqueue(async ({ newsRepository }) => {
      await newsRepository.remove(id);
    });
    return Promise.resolve();
  }

  public findById(id: string): Promise<NewsItem | null> {
    return this.repository.findById(id);
  }

  public findAll(): Promise<readonly NewsItem[]> {
    return this.repository.findAll();
  }
}

class DeferredStockRepository implements IStockRepository {
  public constructor(
    private readonly repository: IStockRepository,
    private readonly enqueue: (operation: IUnitOfWorkOperation) => void,
  ) {}

  public add(stock: Stock): Promise<void> {
    this.enqueue(async ({ stockRepository }) => {
      await stockRepository.add(stock);
    });
    return Promise.resolve();
  }

  public remove(id: string): Promise<void> {
    this.enqueue(async ({ stockRepository }) => {
      await stockRepository.remove(id);
    });
    return Promise.resolve();
  }

  public findById(id: string): Promise<Stock | null> {
    return this.repository.findById(id);
  }

  public findAll(): Promise<readonly Stock[]> {
    return this.repository.findAll();
  }
}

export class PrismaUnitOfWork implements IUnitOfWork {
  private readonly pendingOperations: IUnitOfWorkOperation[] = [];

  public readonly newsRepository: INewsRepository;

  public readonly stockRepository: IStockRepository;

  public constructor(private readonly prisma: IPrismaClient) {
    const newsRepository = new PrismaNewsRepository(prisma);
    const stockRepository = new PrismaStockRepository(prisma);

    this.newsRepository = new DeferredNewsRepository(newsRepository, this.register.bind(this));
    this.stockRepository = new DeferredStockRepository(stockRepository, this.register.bind(this));
  }

  public register(operation: IUnitOfWorkOperation): void {
    this.pendingOperations.push(operation);
  }

  public async commit(): Promise<void> {
    const operations = [...this.pendingOperations];

    try {
      await this.prisma.$transaction(async (transaction) => {
        const context = createContext(transaction);

        for (const operation of operations) {
          await operation(context);
        }
      });

      this.pendingOperations.splice(0, this.pendingOperations.length);
    }
    catch (error) {
      await this.rollback();
      throw error;
    }
  }

  public rollback(): Promise<void> {
    this.pendingOperations.splice(0, this.pendingOperations.length);
    return Promise.resolve();
  }
}
