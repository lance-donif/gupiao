import { describe, expect, it, vi } from 'vitest';
import { readNewsText } from '../../../src/services/news-http.js';
import { SinaFinanceFeedSourceAdapter } from '../../../src/services/sina-finance-feed.js';
import { GoogleNewsRssSourceAdapter, PublicNewsSourceOrchestrator } from '../../../src/services/public-news-source-orchestrator.js';
import { fetchNewsNowSources } from '../../../scripts/fetch-newsnow.js';
import { AkToolsHttpNewsProvider } from '../../../src/services/tavily-news-provider.js';
import { createProviderRequestMetadata } from '../../../src/sources/index.js';

const asOf = new Date('2026-09-22T08:00:00Z');
const input = { asOf, capturedAt: new Date('2026-09-22T12:00:00Z'), timeoutMs: 1000, limit: 300 };
const json = (payload: unknown) => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
const sinaRow = (id: string, ctime: unknown = asOf.getTime() / 1000 - 60) => ({
  oid: id, ctime, title: `财经新闻${id}`, summary: '<p>产业需求增加</p>', url: `https://finance.sina.com.cn/stock/${id}`, media_name: '新浪财经',
});
const sina = (rows: unknown[]) => json({ result: { status: { code: 0 }, data: rows } });
const rss = '<rss><channel><item><title>产业需求增长</title><link>https://example.com/a</link><description>新增订单带动产业需求增长</description><pubDate>Tue, 22 Sep 2026 14:00:00 +0800</pubDate></item></channel></rss>';

describe('news body deadlines and NewsNow validation', () => {
  it('times out after headers if the response body never completes', async () => {
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream()));
    await expect(readNewsText('https://example.com', { fetchImpl, timeoutMs: 15 })).rejects.toThrow('timeout');
  });

  it('retries empty/invalid bodies but never exceeds three attempts', async () => {
    const fetchImpl = vi.fn(async () => new Response(''));
    await expect(fetchNewsNowSources(9, { fetchImpl, timeoutMs: 100, retryDelayMs: 0 })).rejects.toThrow('空响应体');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects malformed source items and succeeds on a valid retry', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json([{ id: 'cls', status: 'cache', items: [{}] }]))
      .mockResolvedValueOnce(json([{ id: 'cls', status: 'cache', items: [{ title: '有效新闻标题', url: 'https://example.com' }] }]));
    expect(await fetchNewsNowSources(3, { fetchImpl, retryDelayMs: 0 })).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('Sina JSON feed', () => {
  it('uses ctime, deduplicates channels, and reports invalid/future records', async () => {
    const adapter = new SinaFinanceFeedSourceAdapter(async () => sina([
      sinaRow('one'), sinaRow('future', asOf.getTime() / 1000 + 1), sinaRow('missing', null),
    ]));
    const result = await adapter.fetch(input);
    expect(result.status).toBe('success');
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0].publishedAt.toISOString()).toBe('2026-09-22T07:59:00.000Z');
    expect(result.articles[0].summary).toBe('产业需求增加');
    expect(result.summary).toMatchObject({ rawCount: 6, invalidTime: 2, future: 2, duplicates: 1 });
  });

  it('continues past a full page of future records to find visible news', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const page = new URL(String(url)).searchParams.get('page');
      return page === '1' ? sina(Array.from({ length: 50 }, (_, i) => sinaRow(`future-${i}`, asOf.getTime() / 1000 + 1))) : sina([sinaRow('visible')]);
    });
    const result = await new SinaFinanceFeedSourceAdapter(fetchImpl).fetch(input);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(result.articles).toHaveLength(1);
  });

  it('caps pagination even when every upstream record is in the future', async () => {
    const fetchImpl = vi.fn(async () => sina(Array.from({ length: 50 }, (_, i) => sinaRow(String(i), asOf.getTime() / 1000 + 1))));
    const result = await new SinaFinanceFeedSourceAdapter(fetchImpl).fetch(input);
    expect(fetchImpl).toHaveBeenCalledTimes(20);
    expect(result.status).toBe('empty');
    expect(result.summary).toMatchObject({ pages: 20, future: 1000 });
  });

  it('distinguishes empty data from failed and partially failed channels', async () => {
    expect((await new SinaFinanceFeedSourceAdapter(async () => sina([])).fetch(input)).status).toBe('empty');
    expect((await new SinaFinanceFeedSourceAdapter(async () => json({})).fetch(input)).status).toBe('failed');
    const result = await new SinaFinanceFeedSourceAdapter(async url => String(url).includes('lid=2516') ? json({}) : sina([sinaRow('ok')])).fetch(input);
    expect(result.status).toBe('partial');
    expect(result.articles).toHaveLength(1);
  });
});

describe('Google RSS retry and source state', () => {
  it('retries 503 once and reports partial failures without counting them as success', async () => {
    const calls = new Map<string, number>();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const key = String(url); const count = (calls.get(key) ?? 0) + 1; calls.set(key, count);
      if (key.includes('q=bad')) return new Response('', { status: 404 });
      return count === 1 ? new Response('', { status: 503 }) : new Response(rss);
    });
    const adapter = new GoogleNewsRssSourceAdapter({ keywords: ['good', 'bad'], fetchImpl });
    const result = await new PublicNewsSourceOrchestrator({ adapters: [adapter], timeoutMs: 1000, perSourceLimit: 300 }).fetch(input);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.summary.sources['google-news-rss'].status).toBe('partial');
    expect(result.articles).toHaveLength(1);
  });

  it('bounds stalled response bodies by the total source timeout', async () => {
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream()));
    const result = await new GoogleNewsRssSourceAdapter({ keywords: ['a'], fetchImpl }).fetch({ ...input, timeoutMs: 30 });
    expect(result.status).toBe('failed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports empty RSS and rejects HTML masquerading as a feed', async () => {
    const empty = new GoogleNewsRssSourceAdapter({ keywords: ['a'], fetchImpl: async () => new Response('<rss><channel></channel></rss>') });
    expect((await empty.fetch(input)).status).toBe('empty');
    const invalid = new GoogleNewsRssSourceAdapter({ keywords: ['a'], fetchImpl: async () => new Response('<html>blocked</html>') });
    expect((await invalid.fetch(input)).status).toBe('failed');
  });
});

describe('Baidu asOf boundary', () => {
  it('passes the Beijing date and excludes future and unparseable calendar events', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => String(url).includes('news_economic_baidu') ? json([
      { 日期: '2026-09-23', 时间: '00:15', 地区: '中国', 事件: '已发生事件' },
      { 日期: '2026-09-23', 时间: '00:31', 地区: '中国', 事件: '未来事件' },
      { 日期: '2026-09-23', 时间: '待定', 地区: '中国', 事件: '时间不明' },
      { 日期: '2026-02-30', 时间: '12:00', 地区: '中国', 事件: '非法日期' },
    ]) : json([]));
    const provider = new AkToolsHttpNewsProvider({ baseUrl: 'http://aktools:8010', maxResults: 100, fetchImpl });
    const result = await provider.executeAsync({ query: '', asOf: new Date('2026-09-22T16:30:00Z') }, createProviderRequestMetadata());
    expect(fetchImpl.mock.calls.map(call => String(call[0]))).toContain('http://aktools:8010/api/public/news_economic_baidu?date=20260923');
    expect(result.status).toBe('success');
    if (result.status === 'success') expect(result.payload.items.map(item => item.title)).toEqual(['中国: 已发生事件']);
    expect(provider.getFetchSummary()).toMatchObject({ endpoints: { news_economic_baidu: { invalidCount: 2, invalidTimeCount: 2, futureCount: 1, validCount: 1 } } });
  });
});
