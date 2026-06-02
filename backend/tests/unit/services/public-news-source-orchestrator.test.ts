import { describe, expect, it } from 'vitest';
import {
  createGoogleNewsRssUrls,
  parseRssXml,
  parseSinaFinanceRollHtml,
  PublicNewsSourceOrchestrator,
  type IPublicNewsSourceAdapter,
} from '../../../src/services/public-news-source-orchestrator.js';
import type { INewsSourceArticle } from '../../../src/sources/contracts.js';

describe('public news source orchestrator', () => {
  it('parses RSS items and strips HTML summaries', () => {
    const articles = parseRssXml({
      xml: [
        '<rss><channel>',
        '<item>',
        '<title>新能源订单增长带动设备需求增加</title>',
        '<link>https://example.com/news/1</link>',
        '<description><![CDATA[<p>上市公司订单增加，产业链交付改善。</p>]]></description>',
        '<pubDate>Tue, 02 Jun 2026 14:30:00 +0800</pubDate>',
        '</item>',
        '</channel></rss>',
      ].join(''),
      sourceName: 'sina-rss',
      feedUrl: 'https://rss.sina.com.cn/news/allnews/finance.xml',
      capturedAt: new Date('2026-06-02T07:00:00.000Z'),
    });

    expect(articles).toHaveLength(1);
    expect(articles[0]).toEqual(expect.objectContaining({
      title: '新能源订单增长带动设备需求增加',
      summary: '上市公司订单增加，产业链交付改善。',
      url: 'https://example.com/news/1',
      publishedAt: new Date('2026-06-02T06:30:00.000Z'),
    }));
    expect(articles[0]?.metadata).toEqual(expect.objectContaining({
      provider: 'sina-rss',
      source: 'sina-rss',
      feedUrl: 'https://rss.sina.com.cn/news/allnews/finance.xml',
    }));
  });

  it('generates zero-config Google News RSS URLs for Chinese finance keywords', () => {
    const urls = createGoogleNewsRssUrls(['A股 半导体', '新能源 订单']);

    expect(urls).toEqual([
      'https://news.google.com/rss/search?q=A%E8%82%A1+%E5%8D%8A%E5%AF%BC%E4%BD%93&hl=zh-CN&gl=CN&ceid=CN%3Azh-Hans',
      'https://news.google.com/rss/search?q=%E6%96%B0%E8%83%BD%E6%BA%90+%E8%AE%A2%E5%8D%95&hl=zh-CN&gl=CN&ceid=CN%3Azh-Hans',
    ]);
  });

  it('parses Sina finance roll page links as current public news', () => {
    const articles = parseSinaFinanceRollHtml({
      html: [
        '<html><body>',
        '<a href="https://cj.sina.cn/articles/view/1">快讯：有色板块涨势扩大 锡业股份等多股涨停</a>',
        '<a href="https://finance.sina.com.cn/roll/">滚动首页</a>',
        '<a href="https://cj.sina.cn/articles/view/2">韩国简化极紫外光刻机进口程序，以支持芯片产业发展</a>',
        '</body></html>',
      ].join(''),
      pageUrl: 'https://finance.sina.com.cn/roll/',
      capturedAt: new Date('2026-06-02T07:00:00.000Z'),
    });

    expect(articles).toHaveLength(2);
    expect(articles[0]).toEqual(expect.objectContaining({
      title: '快讯：有色板块涨势扩大 锡业股份等多股涨停',
      summary: '快讯：有色板块涨势扩大 锡业股份等多股涨停',
      url: 'https://cj.sina.cn/articles/view/1',
      publishedAt: new Date('2026-06-02T07:00:00.000Z'),
    }));
    expect(articles[0]?.metadata).toEqual(expect.objectContaining({
      provider: 'sina-finance-roll',
      source: 'sina-finance-roll',
      pageUrl: 'https://finance.sina.com.cn/roll/',
    }));
  });

  it('keeps successful optional sources when another optional source fails', async () => {
    const article: INewsSourceArticle = {
      title: '半导体报价上涨带动产业链需求',
      summary: '半导体报价上涨，产业链订单增长。',
      url: 'https://example.com/chip',
      publishedAt: new Date('2026-06-02T06:00:00.000Z'),
      capturedAt: new Date('2026-06-02T07:00:00.000Z'),
      metadata: {
        provider: 'ok-source',
        requestId: 'ok-1',
        providerIdentity: 'ok-source',
      },
    };
    const okSource: IPublicNewsSourceAdapter = {
      name: 'ok-source',
      fetch: () => Promise.resolve({ articles: [article], summary: { feedCount: 1 } }),
    };
    const failedSource: IPublicNewsSourceAdapter = {
      name: 'failed-source',
      fetch: () => Promise.reject(new Error('network failed')),
    };

    const orchestrator = new PublicNewsSourceOrchestrator({
      adapters: [okSource, failedSource],
      timeoutMs: 1000,
      perSourceLimit: 20,
    });
    const result = await orchestrator.fetch({
      asOf: new Date('2026-06-02T08:00:00.000Z'),
      capturedAt: new Date('2026-06-02T07:00:00.000Z'),
    });

    expect(result.articles).toEqual([article]);
    expect(result.summary.totalArticles).toBe(1);
    expect(result.summary.sources['ok-source']).toEqual(expect.objectContaining({
      status: 'success',
      articleCount: 1,
    }));
    expect(result.summary.sources['failed-source']).toEqual(expect.objectContaining({
      status: 'failed',
      articleCount: 0,
      error: 'network failed',
    }));
  });

  it('returns no optional articles in baseline mode', async () => {
    const okSource: IPublicNewsSourceAdapter = {
      name: 'ok-source',
      fetch: () => Promise.resolve({ articles: [], summary: { feedCount: 1 } }),
    };
    const orchestrator = new PublicNewsSourceOrchestrator({
      adapters: [okSource],
      timeoutMs: 1000,
      perSourceLimit: 20,
    });

    const result = await orchestrator.fetch({
      asOf: new Date('2026-06-02T08:00:00.000Z'),
      capturedAt: new Date('2026-06-02T07:00:00.000Z'),
      mode: 'baseline',
    });

    expect(result.articles).toEqual([]);
    expect(result.summary.mode).toBe('baseline');
    expect(result.summary.sources['ok-source']).toEqual(expect.objectContaining({
      status: 'disabled',
      articleCount: 0,
    }));
  });
});
