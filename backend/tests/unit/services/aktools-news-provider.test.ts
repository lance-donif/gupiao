import { describe, expect, it } from 'vitest';
import { AkToolsHttpNewsProvider } from '../../../src/services/tavily-news-provider.js';
import { createProviderRequestMetadata } from '../../../src/sources/index.js';

describe('aktools news provider', () => {
  it('treats AKShare local datetime strings as Beijing time for today filtering', async () => {
    const provider = new AkToolsHttpNewsProvider({
      baseUrl: 'http://127.0.0.1:8010',
      maxResults: 100,
      fetchImpl: async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        const payload = url.includes('stock_info_global_em')
          ? [{ 标题: '东财新闻', 摘要: '北京时间新闻', 发布时间: '2026-05-24 14:04:05', 链接: 'https://example.com/em' }]
          : url.includes('stock_info_global_ths')
            ? [{ 标题: '同花顺新闻', 内容: '北京时间新闻', 发布时间: '2026-05-24 14:22:16', 链接: 'https://example.com/ths' }]
            : [{ 地区: '中国', 事件: '经济日历事件', 重要性: '高', 日期: '2026-05-24', 时间: '09:30:00' }];

        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const result = await provider.executeAsync(
      { query: '', asOf: new Date('2026-05-24T15:59:59.999Z') },
      {
        ...createProviderRequestMetadata(),
        requestedAt: new Date('2026-05-25T00:30:00.000Z'),
      },
    );

    expect(result.status).toBe('success');
    if (result.status !== 'success') {
      throw new Error('expected success');
    }

    expect(result.payload.items).toHaveLength(3);
    expect(result.payload.items[0]?.publishedAt).toBe('2026-05-24T06:04:05.000Z');
    expect(result.payload.items[1]?.publishedAt).toBe('2026-05-24T06:22:16.000Z');
    expect(result.payload.items[2]?.title).toBe('中国: 经济日历事件');
    expect(result.payload.items[2]?.publishedAt).toBe('2026-05-24T01:30:00.000Z');
  });

  it('creates stable content based ids instead of position based ids', async () => {
    const makeProvider = (title: string) => new AkToolsHttpNewsProvider({
      baseUrl: 'http://127.0.0.1:8010',
      maxResults: 100,
      fetchImpl: async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        const payload = url.includes('stock_info_global_em')
          ? [{ 标题: title, 摘要: '同一时间不同标题', 发布时间: '2026-05-24 14:04:05', 链接: 'https://example.com/em' }]
          : [];

        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const metadata = {
      ...createProviderRequestMetadata(),
      requestedAt: new Date('2026-05-24T07:00:00.000Z'),
    };
    const first = await makeProvider('第一条新闻').executeAsync(
      { query: '', asOf: new Date('2026-05-24T15:59:59.999Z') },
      metadata,
    );
    const second = await makeProvider('第二条新闻').executeAsync(
      { query: '', asOf: new Date('2026-05-24T15:59:59.999Z') },
      metadata,
    );

    expect(first.status).toBe('success');
    expect(second.status).toBe('success');
    if (first.status !== 'success' || second.status !== 'success') {
      throw new Error('expected success');
    }
    expect(first.payload.items[0]?.id).toMatch(/^akshare_global_em:all:/u);
    expect(second.payload.items[0]?.id).toMatch(/^akshare_global_em:all:/u);
    expect(first.payload.items[0]?.id).not.toBe(second.payload.items[0]?.id);
  });

  it('applies request limit after mapping today items', async () => {
    const provider = new AkToolsHttpNewsProvider({
      baseUrl: 'http://127.0.0.1:8010',
      maxResults: 100,
      fetchImpl: async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        const payload = url.includes('stock_info_global_em')
          ? [{ 标题: '第一条银行新闻', 摘要: '银行', 发布时间: '2026-05-24 14:04:05', 链接: 'https://example.com/one' }]
          : url.includes('stock_info_global_ths')
            ? [{ 标题: '第二条银行新闻', 内容: '银行', 发布时间: '2026-05-24 14:22:16', 链接: 'https://example.com/three' }]
            : [{ 地区: '中国', 事件: '银行经济日历事件', 重要性: '高', 日期: '2026-05-24', 时间: '09:30:00' }];

        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const result = await provider.executeAsync(
      { query: '银行', asOf: new Date('2026-05-24T15:59:59.999Z'), limit: 3 },
      {
        ...createProviderRequestMetadata(),
        requestedAt: new Date('2026-05-24T07:00:00.000Z'),
      },
    );

    expect(result.status).toBe('success');
    if (result.status !== 'success') {
      throw new Error('expected success');
    }
    expect(result.payload.items.map(item => item.title)).toEqual([
      '第一条银行新闻',
      '第二条银行新闻',
      '中国: 银行经济日历事件',
    ]);
  });

  it('skips a failed endpoint when another endpoint has mappable news', async () => {
    const provider = new AkToolsHttpNewsProvider({
      baseUrl: 'http://127.0.0.1:8010',
      maxResults: 100,
      fetchImpl: async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        if (url.includes('stock_info_global_em')) {
          return new Response('bad gateway', { status: 502 });
        }
        const payload = url.includes('stock_info_global_ths')
          ? [{ 标题: '同花顺可用新闻', 内容: '电池', 发布时间: '2026-05-24 14:22:16', 链接: 'https://example.com/ths' }]
          : [];

        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const result = await provider.executeAsync(
      { query: '电池', asOf: new Date('2026-05-24T15:59:59.999Z') },
      {
        ...createProviderRequestMetadata(),
        requestedAt: new Date('2026-05-24T07:00:00.000Z'),
      },
    );

    expect(result.status).toBe('success');
    if (result.status !== 'success') {
      throw new Error('expected success');
    }
    expect(result.payload.items.map(item => item.title)).toEqual(['同花顺可用新闻']);
    expect(provider.getHealthStatus().detail).toContain('skipped=');
  });

  it('times out a slow endpoint and still returns data from healthy endpoints', async () => {
    const provider = new AkToolsHttpNewsProvider({
      baseUrl: 'http://127.0.0.1:8010',
      maxResults: 100,
      endpointTimeoutMs: 1,
      fetchImpl: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes('stock_info_global_em')) {
          await new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        const payload = url.includes('stock_info_global_ths')
          ? [{ 标题: '健康端点新闻', 内容: '电池', 发布时间: '2026-05-24 14:22:16', 链接: 'https://example.com/ths' }]
          : [];

        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const result = await provider.executeAsync(
      { query: '电池', asOf: new Date('2026-05-24T15:59:59.999Z') },
      {
        ...createProviderRequestMetadata(),
        requestedAt: new Date('2026-05-24T07:00:00.000Z'),
      },
    );

    expect(result.status).toBe('success');
    if (result.status !== 'success') {
      throw new Error('expected success');
    }
    expect(result.payload.items.map(item => item.title)).toEqual(['健康端点新闻']);
    expect(provider.getHealthStatus().detail).toContain('stock_info_global_em');
  });
});
