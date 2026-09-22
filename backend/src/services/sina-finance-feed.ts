import type { INewsSourceArticle } from '../sources/contracts.js';
import type { IPublicNewsSourceAdapter, IPublicNewsSourceAdapterFetchInput, IPublicNewsSourceAdapterResult } from './public-news-source-orchestrator.js';
import { readNewsText } from './news-http.js';

const FEED_URL = 'https://feed.mix.sina.com.cn/api/roll/get';
const CHANNELS = ['2516', '2517'] as const;
const PAGE_SIZE = 50;
const MAX_PAGES = 10;
const cleanText = (value: unknown): string => typeof value === 'string'
  ? value.replace(/<[^>]*>/gu, ' ').replace(/&nbsp;/gu, ' ').replace(/&amp;/gu, '&').replace(/\s+/gu, ' ').trim()
  : '';

export class SinaFinanceFeedSourceAdapter implements IPublicNewsSourceAdapter {
  public readonly name = 'sina-finance-feed';
  public constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  public async fetch(input: IPublicNewsSourceAdapterFetchInput): Promise<IPublicNewsSourceAdapterResult> {
    const deadline = Date.now() + input.timeoutMs;
    const articles = new Map<string, INewsSourceArticle>();
    const failedEndpoints: string[] = [];
    const counts = { rawCount: 0, invalidTime: 0, future: 0, invalidContent: 0, duplicates: 0, validCount: 0, pages: 0 };
    await Promise.all(CHANNELS.map(async (channel) => {
      let visibleCount = 0;
      for (let page = 1; page <= MAX_PAGES && visibleCount < input.limit; page += 1) {
        const url = `${FEED_URL}?${new URLSearchParams({ pageid: '153', lid: channel, num: String(PAGE_SIZE), page: String(page) })}`;
        try {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error('Sina source timeout');
          const text = await readNewsText(url, { timeoutMs: remaining, fetchImpl: this.fetchImpl });
          const payload = JSON.parse(text) as { result?: { status?: { code?: number }; data?: unknown } };
          if (payload?.result?.status?.code !== 0 || !Array.isArray(payload.result.data)) {
            throw new Error('Invalid Sina feed response');
          }
          counts.pages += 1;
          const rows = payload.result.data;
          counts.rawCount += rows.length;
          for (const value of rows) {
            if (!value || typeof value !== 'object') { counts.invalidContent += 1; continue; }
            const row = value as Record<string, unknown>;
            const seconds = Number(row.ctime);
            const publishedAt = new Date(seconds * 1000);
            if (!Number.isFinite(seconds) || seconds <= 0 || Number.isNaN(publishedAt.getTime())) {
              counts.invalidTime += 1; continue;
            }
            if (publishedAt > input.asOf) { counts.future += 1; continue; }
            const title = cleanText(row.title);
            const articleUrl = typeof row.url === 'string' ? row.url.trim() : '';
            if (!title || !/^https?:\/\//iu.test(articleUrl)) { counts.invalidContent += 1; continue; }
            const summary = cleanText(row.summary) || cleanText(row.intro) || cleanText(row.wapsummary) || title;
            visibleCount += 1;
            counts.validCount += 1;
            if (articles.has(articleUrl)) { counts.duplicates += 1; continue; }
            articles.set(articleUrl, {
              title, summary, url: articleUrl, publishedAt, capturedAt: input.capturedAt,
              metadata: {
                provider: this.name, providerIdentity: this.name, source: this.name,
                requestId: `${this.name}-${input.capturedAt.toISOString()}`,
                recordId: `${this.name}:${String(row.oid ?? articleUrl)}`,
                feedUrl: url, channel, originalSource: cleanText(row.media_name),
                publishedAtSource: 'ctime', contentQuality: summary === title ? 'title_only' : 'summary',
              },
            });
          }
          if (rows.length < PAGE_SIZE) break;
        } catch (error) {
          failedEndpoints.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
          break;
        }
      }
    }));
    const selected = [...articles.values()].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime()).slice(0, input.limit);
    return {
      articles: selected,
      status: failedEndpoints.length ? (counts.pages ? 'partial' : 'failed') : selected.length ? 'success' : 'empty',
      summary: { ...counts, failedEndpoints, returnedCount: selected.length, maxPagesPerChannel: MAX_PAGES },
    };
  }
}
