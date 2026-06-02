import { describe, expect, it } from 'vitest';

import { FriendNetworkGraphRepository } from '../../../src/repositories/friend-network-graph-repository.js';

class FakeAgeGraphClient {
  public readonly statements: string[] = [];

  public async execute(cypher: string): Promise<void> {
    this.statements.push(cypher);
  }

  public async query<T>(_cypher: string, _columnNames?: readonly string[]): Promise<readonly T[]> {
    return [];
  }

  public async close(): Promise<void> {
    return Promise.resolve();
  }
}

describe('friend-network graph repository', () => {
  it('builds AGE cypher statements for node and relationship persistence', async () => {
    const graphClient = new FakeAgeGraphClient();
    const repository = new FriendNetworkGraphRepository(graphClient, 'friend_network');

    const result = await repository.persist({
      cluster: 'cluster-a',
      asOf: new Date('2026-03-17T12:00:00.000Z'),
      nodes: [
        {
          keyword: '白银',
          category: 'theme',
          frequency: 3,
          temperature: 'hot',
          weakSignal: true,
          updatedAt: '2026-03-17T12:00:00.000Z',
          newsIds: ['news-1'],
        },
      ],
      relationships: [
        {
          sourceKeyword: '制造业',
          targetKeyword: '白银',
          relationType: 'driver',
          direction: 'forward',
          confidence: 0.88,
          status: 'effective',
          weakSignal: true,
          evidence: ['制造扩产带动白银需求'],
          reasoning: '制造业扩产提升白银工业需求',
          updatedAt: '2026-03-17T12:00:00.000Z',
          newsIds: ['news-1'],
        },
      ],
    });

    expect(graphClient.statements).toHaveLength(2);
    expect(graphClient.statements[0]).toContain('MERGE (n:SignalNode');
    expect(graphClient.statements[0]).toContain('cluster: "cluster-a"');
    expect(graphClient.statements[1]).toContain('MERGE (source)-[r:FRIEND_RELATION');
    expect(graphClient.statements[1]).toContain('r.reasoning = "制造业扩产提升白银工业需求"');
    expect(result).toEqual({
      cluster: 'cluster-a',
      graphName: 'friend_network',
      nodeCount: 1,
      relationshipCount: 1,
      persistedAt: '2026-03-17T12:00:00.000Z',
    });
  });
});
