import { describe, expect, it } from 'vitest';

import type { IFriendNetworkEngineInput } from '../../../src/index.js';
import { createStubFriendNetworkAiAdapter } from '../../../src/services/friend-network-ai-adapter.js';
import { createFriendNetworkEngine } from '../../../src/services/friend-network-engine.js';

describe('friend-network engine', () => {
  it('exports engine input/output types from the public barrel', () => {
    const input: IFriendNetworkEngineInput = {
      cluster: 'cluster-a',
      sourceNewsFilePath: '/tmp/raw-news.json',
      asOf: new Date('2026-03-17T12:00:00.000Z'),
      newsItems: [],
    };

    expect(input.cluster).toBe('cluster-a');
  });

  it('runs the full news -> entity -> graph -> ai -> snapshot pipeline as one system', async () => {
    const engine = createFriendNetworkEngine({
      aiAdapter: createStubFriendNetworkAiAdapter(),
    });

    const result = await engine.run({
      cluster: 'cluster-a',
      sourceNewsFilePath: '/tmp/raw-news.json',
      asOf: new Date('2026-03-17T12:00:00.000Z'),
      newsItems: [
        {
          id: '1',
          title: '新能源扩产带动白银需求提升',
          summary: '伴生矿供给偏紧',
          url: 'https://example.com/1',
          publishedAt: '2026-03-17T09:00:00.000Z',
          capturedAt: '2026-03-17T10:00:00.000Z',
          source: 'stub',
        },
      ],
    });

    expect(result.graph.nodes.length).toBeGreaterThan(0);
    expect(result.graph.relationships.length).toBeGreaterThan(0);
    expect(result.tree.roots.length).toBeGreaterThan(0);
    expect(result.aiDecisions[0]?.reasoning).toContain('同一新闻语境');
    expect(result.persistence).toBeNull();
  });
});
