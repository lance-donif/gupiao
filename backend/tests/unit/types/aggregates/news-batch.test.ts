import { describe, expect, it } from 'vitest';

import { NewsBatch, NewsItem, Timestamp } from '../../../../src/index.js';

const createNewsItem = (id: string): NewsItem => {
  return new NewsItem(
    id,
    `标题-${id}`,
    `内容-${id}`,
    'source-a',
    Timestamp.from('2025-03-14T09:30:00.000Z'),
  );
};

describe('NewsBatch', () => {
  it('rejects duplicate items added in separate operations', () => {
    const batch = new NewsBatch('batch-1', Timestamp.from('2025-03-14T08:00:00.000Z'));
    const item = createNewsItem('news-1');

    batch.addItems([item]);

    expect(() => batch.addItems([createNewsItem('news-1')])).toThrowError(
      'Duplicate item in batch: news-1',
    );
    expect(batch.items).toHaveLength(1);
  });

  it('rejects duplicate items inside the same addItems call', () => {
    const batch = new NewsBatch('batch-1', Timestamp.from('2025-03-14T08:00:00.000Z'));

    expect(() => batch.addItems([createNewsItem('news-1'), createNewsItem('news-1')])).toThrowError(
      'Duplicate item in batch: news-1',
    );
    expect(batch.items).toHaveLength(0);
  });

  it('fails when committing an empty batch', () => {
    const batch = new NewsBatch('batch-1', Timestamp.from('2025-03-14T08:00:00.000Z'));

    expect(() => batch.commit()).toThrowError('Cannot commit empty batch');
    expect(batch.status).toBe('PENDING');
  });

  it('transitions from PENDING to COMMITTED for non-empty batch', () => {
    const batch = new NewsBatch('batch-1', Timestamp.from('2025-03-14T08:00:00.000Z'));

    batch.addItems([createNewsItem('news-1'), createNewsItem('news-2')]);
    batch.commit();

    expect(batch.status).toBe('COMMITTED');
    expect(batch.items.map((item) => item.id)).toEqual(['news-1', 'news-2']);
  });

  it('prevents further state mutations after commit', () => {
    const batch = new NewsBatch('batch-1', Timestamp.from('2025-03-14T08:00:00.000Z'));

    batch.addItems([createNewsItem('news-1')]);
    batch.commit();

    expect(() => batch.addItems([createNewsItem('news-2')])).toThrowError(
      'Cannot add items to a batch with status COMMITTED',
    );
    expect(() => batch.commit()).toThrowError('Cannot commit a batch with status COMMITTED');
  });

  it('supports constructing a pending batch with initial unique items', () => {
    const batch = new NewsBatch(
      'batch-2',
      Timestamp.from('2025-03-14T08:00:00.000Z'),
      [createNewsItem('news-1'), createNewsItem('news-2')],
    );

    expect(batch.status).toBe('PENDING');
    expect(batch.items.map((item) => item.id)).toEqual(['news-1', 'news-2']);
  });
});
