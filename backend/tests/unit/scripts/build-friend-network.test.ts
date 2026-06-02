import { describe, expect, it } from 'vitest';

import {
  buildFriendRelationshipTree,
  extractNewsRecordsFromPayload,
  type IRawNewsFilePayload,
} from '../../../scripts/build-friend-network.js';

const createPayload = (): IRawNewsFilePayload => {
  return {
    rawNews: [
      {
        id: 'news-1',
        title: '白银需求上升 新能源制造扩产',
        summary: '新能源与高端制造扩产带动白银需求提升',
        url: 'https://example.com/1',
        publishedAt: '2026-03-17T09:00:00.000Z',
        capturedAt: '2026-03-17T10:00:00.000Z',
      },
      {
        id: 'news-2',
        title: '光伏扩产带动白银材料关注度升温',
        summary: '光伏、新能源、高端制造共同推升白银材料需求',
        url: 'https://example.com/2',
        publishedAt: '2026-03-17T09:30:00.000Z',
        capturedAt: '2026-03-17T10:00:00.000Z',
      },
      {
        id: 'news-3',
        title: '制造业订单回暖 白银伴生矿话题升温',
        summary: '制造业订单改善带动白银与伴生矿关键词共振',
        url: 'https://example.com/3',
        publishedAt: '2026-03-17T10:00:00.000Z',
        capturedAt: '2026-03-17T10:05:00.000Z',
      },
    ],
  };
};

describe('build-friend-network script helpers', () => {
  it('reads news items from raw news payload', () => {
    const records = extractNewsRecordsFromPayload(createPayload());

    expect(records).toHaveLength(3);
    expect(records[0]?.title).toContain('白银');
  });

  it('builds a friend relationship tree with reasons and simplified tags', () => {
    const report = buildFriendRelationshipTree({
      payload: createPayload(),
      sourceNewsFilePath: '/tmp/raw-news.json',
      generatedAtBeijing: '2026-03-17 20:30:00',
    });

    expect(report.newsCount).toBe(3);
    expect(report.keywordCount).toBeGreaterThan(0);
    expect(report.relationshipCount).toBeGreaterThan(0);
    expect(report.roots.length).toBeGreaterThan(0);
    expect(report.roots[0]).toMatchObject({
      status: 'effective',
      temperature: expect.stringMatching(/hot|cold/),
      weakSignal: expect.any(Boolean),
    });
    expect(report.roots[0]?.reasons.length).toBeGreaterThan(0);
    expect(report.roots[0]?.children.length).toBeGreaterThan(0);
  });

  it('does not limit root keywords and exposes every extracted keyword as a root entry', () => {
    const report = buildFriendRelationshipTree({
      payload: createPayload(),
      sourceNewsFilePath: '/tmp/raw-news.json',
      generatedAtBeijing: '2026-03-17 20:30:00',
    });

    expect(report.roots).toHaveLength(report.keywordCount);
  });
});
