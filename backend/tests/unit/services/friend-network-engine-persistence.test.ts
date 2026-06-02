import { describe, expect, it } from 'vitest';

import type {
  IFriendNetworkAiAdapter,
  IFriendNetworkGraphRepository,
  IFriendNetworkPersistenceResult,
  IFriendNetworkPersistInput,
} from '../../../src/index.js';
import { createFriendNetworkEngine } from '../../../src/services/friend-network-engine.js';

class FakeAiAdapter implements IFriendNetworkAiAdapter {
  public async judge(candidates: readonly { sourceKeyword: string; targetKeyword: string; evidence: readonly string[] }[]) {
    return candidates.map((candidate) => ({
      sourceKeyword: candidate.sourceKeyword,
      targetKeyword: candidate.targetKeyword,
      relationType: 'driver' as const,
      direction: 'forward' as const,
      confidence: 0.91,
      weakSignal: candidate.sourceKeyword.includes('制造') || candidate.targetKeyword.includes('白银'),
      evidence: candidate.evidence,
      reasoning: `AI 判定 ${candidate.sourceKeyword} 推动 ${candidate.targetKeyword}`,
    }));
  }
}

class FakeGraphRepository implements IFriendNetworkGraphRepository {
  public lastPersistInput: IFriendNetworkPersistInput | null = null;

  public async persist(input: IFriendNetworkPersistInput): Promise<IFriendNetworkPersistenceResult> {
    this.lastPersistInput = input;

    return {
      cluster: input.cluster,
      graphName: 'friend_network',
      nodeCount: input.nodes.length,
      relationshipCount: input.relationships.length,
      persistedAt: input.asOf.toISOString(),
    };
  }
}

describe('friend-network engine persistence', () => {
  it('persists graph facts instead of only building a temporary tree snapshot', async () => {
    const graphRepository = new FakeGraphRepository();
    const engine = createFriendNetworkEngine({
      aiAdapter: new FakeAiAdapter(),
      graphRepository,
    });

    const result = await engine.run({
      cluster: 'cluster-a',
      sourceNewsFilePath: '/tmp/raw-news.json',
      asOf: new Date('2026-03-17T12:00:00.000Z'),
      newsItems: [
        {
          id: 'news-1',
          title: '高端制造扩产推动白银材料需求上升',
          summary: '新能源订单增长，白银伴生矿供给偏紧。',
          url: 'https://example.com/news-1',
          publishedAt: '2026-03-17T09:00:00.000Z',
          capturedAt: '2026-03-17T10:00:00.000Z',
          source: 'stub',
        },
      ],
    });

    expect(graphRepository.lastPersistInput).not.toBeNull();
    expect(graphRepository.lastPersistInput?.cluster).toBe('cluster-a');
    expect(graphRepository.lastPersistInput?.nodes.length).toBeGreaterThan(0);
    expect(graphRepository.lastPersistInput?.relationships.length).toBeGreaterThan(0);
    expect(graphRepository.lastPersistInput?.relationships[0]?.reasoning).toContain('AI 判定');
    expect(result.persistence).toEqual({
      cluster: 'cluster-a',
      graphName: 'friend_network',
      nodeCount: graphRepository.lastPersistInput?.nodes.length ?? 0,
      relationshipCount: graphRepository.lastPersistInput?.relationships.length ?? 0,
      persistedAt: '2026-03-17T12:00:00.000Z',
    });
  });
});
