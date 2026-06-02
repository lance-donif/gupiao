import { describe, expect, it, vi } from 'vitest';

import type { IFriendNetworkAiAdapter } from '../../../src/services/friend-network-ai-adapter.js';
import { buildFriendNetworkSnapshot } from '../../../scripts/build-friend-network-v2.js';

describe('build-friend-network-v2 script', () => {
  it('builds a unified friend-network snapshot from raw news temp file', async () => {
    const result = await buildFriendNetworkSnapshot({
      sourceNewsFilePath: '/tmp/raw-news.json',
      cluster: 'cluster-a',
      payload: {
        rawNews: [
          {
            id: '1',
            title: '新能源扩产带动白银需求提升',
            summary: '伴生矿供给偏紧',
            url: 'https://example.com/1',
            publishedAt: '2026-03-17T09:00:00.000Z',
            capturedAt: '2026-03-17T10:00:00.000Z',
          },
        ],
      },
    });

    expect(result.tree.depthLimit).toBe(20);
    expect(result.graph.nodes.length).toBeGreaterThan(0);
    expect(result.tree.rootKeywords.length).toBe(result.graph.nodes.length);
    expect(result.tree.roots.length).toBeGreaterThan(0);
  });

  it('prefers injected ai adapter factory when available', async () => {
    const judge = vi.fn<IFriendNetworkAiAdapter['judge']>().mockResolvedValue([
      {
        sourceKeyword: '新能源',
        targetKeyword: '白银',
        relationType: 'transmission',
        direction: 'forward',
        confidence: 0.93,
        weakSignal: false,
        evidence: ['LLM 判断新能源扩产会传导至白银需求'],
        reasoning: 'LLM 判定为需求传导。',
      },
    ]);

    const result = await buildFriendNetworkSnapshot({
      sourceNewsFilePath: '/tmp/raw-news.json',
      cluster: 'cluster-a',
      payload: {
        rawNews: [
          {
            id: '1',
            title: '新能源扩产带动白银需求提升',
            summary: '伴生矿供给偏紧',
            url: 'https://example.com/1',
            publishedAt: '2026-03-17T09:00:00.000Z',
            capturedAt: '2026-03-17T10:00:00.000Z',
          },
        ],
      },
      createAiAdapter: () => ({ judge }),
      createStubAiAdapter: () => ({
        judge: vi.fn().mockResolvedValue([]),
      }),
    });

    expect(judge).toHaveBeenCalledOnce();
    expect(result.aiDecisions).toEqual([
      expect.objectContaining({
        sourceKeyword: '新能源',
        targetKeyword: '白银',
        relationType: 'transmission',
        confidence: 0.93,
      }),
    ]);
    expect(result.graph.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceKeyword: '新能源',
          targetKeyword: '白银',
          relationType: 'transmission',
          confidence: 0.93,
        }),
      ]),
    );
  });

  it('falls back to stub ai adapter when llm adapter is unavailable', async () => {
    const stubJudge = vi.fn<IFriendNetworkAiAdapter['judge']>().mockResolvedValue([
      {
        sourceKeyword: '新能源',
        targetKeyword: '白银',
        relationType: 'driver',
        direction: 'forward',
        confidence: 0.75,
        weakSignal: false,
        evidence: ['stub fallback'],
        reasoning: 'stub fallback reasoning',
      },
    ]);

    const result = await buildFriendNetworkSnapshot({
      sourceNewsFilePath: '/tmp/raw-news.json',
      cluster: 'cluster-a',
      payload: {
        rawNews: [
          {
            id: '1',
            title: '新能源扩产带动白银需求提升',
            summary: '伴生矿供给偏紧',
            url: 'https://example.com/1',
            publishedAt: '2026-03-17T09:00:00.000Z',
            capturedAt: '2026-03-17T10:00:00.000Z',
          },
        ],
      },
      createAiAdapter: () => {
        throw new Error('missing llm env');
      },
      createStubAiAdapter: () => ({ judge: stubJudge }),
    });

    expect(stubJudge).toHaveBeenCalledOnce();
    expect(result.aiDecisions).toEqual([
      expect.objectContaining({
        relationType: 'driver',
        confidence: 0.75,
      }),
    ]);
  });
});
