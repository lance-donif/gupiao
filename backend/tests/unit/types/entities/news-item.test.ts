import { describe, expect, it } from 'vitest';

import { Keyword, NewsItem, Timestamp } from '../../../../src/index.js';

describe('NewsItem', () => {
  it('compares equality by id only', () => {
    const publishedAt = Timestamp.from('2025-03-14T09:30:00.000Z');
    const left = new NewsItem('news-1', '标题A', '内容A', 'source-a', publishedAt);
    const sameId = new NewsItem('news-1', '标题B', '内容B', 'source-b', publishedAt);
    const differentId = new NewsItem('news-2', '标题A', '内容A', 'source-a', publishedAt);

    expect(left.equals(sameId)).toBe(true);
    expect(left.equals(differentId)).toBe(false);
  });

  it('prevents duplicate keywords when adding repeatedly', () => {
    const newsItem = new NewsItem(
      'news-1',
      '标题A',
      '内容A',
      'source-a',
      Timestamp.from('2025-03-14T09:30:00.000Z'),
    );
    const keyword = new Keyword('kw-1', 'AI', 'theme', ['算力']);
    const duplicateById = new Keyword('kw-1', '人工智能', 'macro', ['模型']);

    newsItem.addKeyword(keyword);
    newsItem.addKeyword(duplicateById);

    expect(newsItem.keywords).toHaveLength(1);
    expect(newsItem.keywords[0]).toBe(keyword);
  });

  it('deduplicates initial keywords passed to constructor', () => {
    const keyword = new Keyword('kw-1', '半导体', 'industry');
    const newsItem = new NewsItem(
      'news-1',
      '标题A',
      '内容A',
      'source-a',
      Timestamp.from('2025-03-14T09:30:00.000Z'),
      [keyword, new Keyword('kw-1', '芯片', 'theme')],
    );

    expect(newsItem.keywords).toHaveLength(1);
    expect(newsItem.keywords[0]?.word).toBe('半导体');
  });
});
