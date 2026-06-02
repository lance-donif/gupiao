import { describe, it, expect } from 'vitest';
import {
  NewsIngestDeduplicationPipeline,
  type INormalizedNewsCandidate,
} from '../../../src/services/news-ingest-pipeline.js';

describe('News Ingest Reprint Deduplication Pipeline', () => {
  const pipeline = new NewsIngestDeduplicationPipeline();

  it('should pass normal distinct articles without penalty', () => {
    const candidates: INormalizedNewsCandidate[] = [
      {
        id: '1',
        title: '中国白银出口额今年创历史新高',
        content: '根据海关总署最新发布的数据，由于海外高端制造业对白银的需求持续高企，我国今年白银出口额首次创下历史新高。',
        source: 'Sina',
        url: 'http://example.com/1',
        publishedAt: new Date('2026-05-24T00:00:00Z'),
        dedupKey: 'key1',
      },
      {
        id: '2',
        title: '光伏产业爆发导致白银供需缺口扩大',
        content: '白银作为光伏网格银浆的核心原料，在光伏装机量爆发的背景下，全球白银供给持续紧张，面临严峻供需缺口。',
        source: 'EastMoney',
        url: 'http://example.com/2',
        publishedAt: new Date('2026-05-24T01:00:00Z'),
        dedupKey: 'key2',
      },
    ];

    const result = pipeline.process(candidates);
    expect(result.processed.length).toBe(2);
    expect(result.processed[0].reprintWeight).toBe(1.0);
    expect(result.processed[1].reprintWeight).toBe(1.0);
    expect(result.processed[0].reprintGroupId).toBe('1');
    expect(result.processed[1].reprintGroupId).toBe('2');
  });

  it('should detect similar reprint articles and apply 0.15 penalty weight', () => {
    const candidates: INormalizedNewsCandidate[] = [
      {
        id: '1',
        title: '突发！白银价格盘中突破五年新高，市场多空博弈白热化',
        content: '今日盘中，白银价格强势拉升突破五年新高，引发市场强烈关注。分析师指出白银的工业属性和金融属性双重共振，使得后续走势充满想象力。',
        source: 'Sina',
        url: 'http://example.com/3',
        publishedAt: new Date('2026-05-24T00:00:00Z'),
        dedupKey: 'key1',
      },
      {
        id: '2',
        title: '【转载】突发：白银价格大涨突破五年新高！市场博弈进入白热化',
        content: '突发爆料！今日白银价格暴涨并创五年新高，引发了极高的多空博弈。分析指出，受工业 and 金融双重属性共振，白银未来走势将极为开阔。',
        source: 'EastMoney',
        url: 'http://example.com/4',
        publishedAt: new Date('2026-05-24T00:05:00Z'),
        dedupKey: 'key2',
      },
    ];

    const result = pipeline.process(candidates);
    expect(result.processed.length).toBe(2);

    // 第一篇应该作为“首发”，权重为 1.0
    expect(result.processed[0].reprintWeight).toBe(1.0);
    expect(result.processed[0].reprintGroupId).toBe('1');

    // 第二篇与第一篇高度相似，属于转载，权重惩罚降至 0.15
    expect(result.processed[1].reprintWeight).toBe(0.15);
    expect(result.processed[1].reprintGroupId).toBe('1');
  });

  it('uses blocking buckets while preserving same-topic quality metadata', () => {
    const candidates: INormalizedNewsCandidate[] = [
      {
        id: 'robot-original',
        title: '机器人订单增长带动自动化设备需求增加',
        content: '机器人订单增长带动自动化设备需求增加，产业链交付改善。',
        source: 'AKTools',
        url: 'http://example.com/robot-1',
        publishedAt: new Date('2026-05-24T00:00:00Z'),
        dedupKey: 'robot-1',
      },
      {
        id: 'robot-reprint',
        title: '机器人订单增长带动自动化设备需求增加',
        content: '机器人订单增长带动自动化设备需求增加，产业链交付改善。',
        source: 'NewsNow',
        url: 'http://example.com/robot-2',
        publishedAt: new Date('2026-05-24T00:05:00Z'),
        dedupKey: 'robot-2',
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `distinct-${index}`,
        title: `海外宏观观察 ${index}`,
        content: `海外宏观观察 ${index} 与机器人产业无关，文本保持不同。`,
        source: 'Other',
        url: `http://example.com/distinct-${index}`,
        publishedAt: new Date('2026-05-24T01:00:00Z'),
        dedupKey: `distinct-${index}`,
      })),
    ];

    const result = pipeline.process(candidates);
    const original = result.processed.find(item => item.id === 'robot-original');
    const reprint = result.processed.find(item => item.id === 'robot-reprint');

    expect(result.steps).toContain('deduplicate:blocking-index');
    expect(original?.reprintWeight).toBe(1);
    expect(reprint?.reprintWeight).toBe(0.15);
    expect(reprint?.reprintGroupId).toBe('robot-original');
    expect(original?.sameTopicCount).toBe(2);
    expect(reprint?.sameTopicCount).toBe(2);
    expect(original?.quality).toEqual(expect.objectContaining({
      hasBusinessVariable: true,
      contentQuality: expect.any(String),
    }));
  });
});
