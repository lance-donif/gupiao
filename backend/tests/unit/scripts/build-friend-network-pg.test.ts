import { beforeEach, describe, expect, it, vi } from 'vitest';

const readFileMock = vi.fn();
const persistMock = vi.fn();

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
}));

vi.mock('../../../src/repositories/friend-network-graph-repository.js', () => {
  class FakePgAgeGraphClient {
    public constructor(_databaseUrl: string, _graphName: string) {}
  }

  class FakeFriendNetworkGraphRepository {
    public async persist(input: unknown) {
      return persistMock(input);
    }
  }

  return {
    PgAgeGraphClient: FakePgAgeGraphClient,
    FriendNetworkGraphRepository: FakeFriendNetworkGraphRepository,
  };
});

describe('build-friend-network-pg script', () => {
  beforeEach(() => {
    readFileMock.mockReset();
    persistMock.mockReset();
    process.env.LLM_SMART_BASE_URL = 'http://localhost:8080/v1';
    process.env.LLM_SMART_API_KEY = 'sk-3809aefa0050e57ff804482aed94bc96f5e382fccdf7b76b1f95a08321d8c8cb';
    process.env.LLM_SMART_MODEL = 'gpt-5.4-mini';
  });

  it('persists the unified friend network into PostgreSQL/AGE instead of writing a temp file', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({
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
    }));
    persistMock.mockImplementation(async (input: { cluster: string; nodes: unknown[]; relationships: unknown[]; asOf: Date }) => ({
      cluster: input.cluster,
      graphName: 'friend_network',
      nodeCount: input.nodes.length,
      relationshipCount: input.relationships.length,
      persistedAt: input.asOf.toISOString(),
    }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decisions: [
                  {
                    sourceKeyword: '新能源',
                    targetKeyword: '白银',
                    relationType: 'driver',
                    direction: 'forward',
                    confidence: 0.9,
                    weakSignal: false,
                    evidence: ['新能源扩产带动白银需求提升'],
                    reasoning: '新能源与白银存在因果传导。',
                  },
                ],
              }),
            },
          },
        ],
      }),
    });

    try {
      const { buildFriendNetworkToPg } = await import('../../../scripts/build-friend-network-pg.js');
      const result = await buildFriendNetworkToPg({
        sourceNewsFilePath: '/tmp/raw-news.json',
        cluster: 'cluster-a',
        asOf: new Date('2026-03-17T12:00:00.000Z'),
      });

      expect(persistMock).toHaveBeenCalledTimes(1);
      expect(result.persistence).toEqual({
        cluster: 'cluster-a',
        graphName: 'friend_network',
        nodeCount: result.graph.nodes.length,
        relationshipCount: result.graph.relationships.length,
        persistedAt: '2026-03-17T12:00:00.000Z',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
