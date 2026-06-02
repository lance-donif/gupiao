import type { NewsItem } from '../entities/news-item.js';
import type { Timestamp } from '../value-objects/timestamp.js';

export type BatchStatus = 'PENDING' | 'COMMITTED';

export class NewsBatch {
  private readonly itemIds: Set<string>;
  private readonly mutableItems: NewsItem[];
  private statusValue: BatchStatus;

  public constructor(
    public readonly id: string,
    public readonly createdAt: Timestamp,
    items: readonly NewsItem[] = [],
    status: BatchStatus = 'PENDING',
  ) {
    this.mutableItems = [];
    this.itemIds = new Set<string>();
    this.statusValue = status;

    this.ensureValidStatus(status);
    this.addItems(items);
  }

  public get items(): readonly NewsItem[] {
    return this.mutableItems;
  }

  public get status(): BatchStatus {
    return this.statusValue;
  }

  public addItems(items: readonly NewsItem[]): void {
    this.ensurePendingStatus('add items to');

    const pendingIds = new Set<string>();

    for (const item of items) {
      if (this.itemIds.has(item.id) || pendingIds.has(item.id)) {
        throw new Error(`Duplicate item in batch: ${item.id}`);
      }

      pendingIds.add(item.id);
    }

    for (const item of items) {
      this.mutableItems.push(item);
      this.itemIds.add(item.id);
    }
  }

  public commit(): void {
    this.ensurePendingStatus('commit');

    if (this.mutableItems.length === 0) {
      throw new Error('Cannot commit empty batch');
    }

    this.statusValue = 'COMMITTED';
  }

  private ensurePendingStatus(action: string): void {
    if (this.statusValue !== 'PENDING') {
      throw new Error(`Cannot ${action} a batch with status ${this.statusValue}`);
    }
  }

  private ensureValidStatus(status: BatchStatus): void {
    if (status !== 'PENDING' && status !== 'COMMITTED') {
      throw new Error(`Invalid batch status: ${String(status)}`);
    }
  }
}
