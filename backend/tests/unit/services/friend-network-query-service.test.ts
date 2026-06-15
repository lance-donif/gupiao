import { describe, expect, it } from 'vitest';

import { FriendNetworkQueryService } from '../../../src/services/friend-network-query-service.js';

class FakeGraphClient {
  public readonly queries: string[] = [];

  public async execute(_cypher: string): Promise<void> {
    return Promise.resolve();
  }

  public async executeBatch(_cypher: string, _params: Readonly<Record<string, unknown>>): Promise<void> {
    return Promise.resolve();
  }

  public async close(): Promise<void> {
    return Promise.resolve();
  }

  public async query<T>(cypher: string, _columnNames?: readonly string[]): Promise<readonly T[]> {
    this.queries.push(cypher);

    if (cypher.includes('count(node)')) {
      return [{ total: 3 }] as unknown as readonly T[];
    }

    if (cypher.includes('count(r)')) {
      return [{ total: 2 }] as unknown as readonly T[];
    }

    if (cypher.includes('WHERE r.weakSignal = true')) {
      return [{
        sourceKeyword: '新能源',
        targetKeyword: '白银',
        relationType: 'driver',
        direction: 'forward',
        confidence: 0.91,
        weakSignal: true,
        reasoning: '新能源扩产推升银浆需求。',
      }] as unknown as readonly T[];
    }

    if (cypher.includes('RETURN properties(node).keyword AS keyword')) {
      return [{
        keyword: '白银',
        category: 'theme',
        frequency: 3,
        temperature: 'hot',
        weakSignal: true,
      }] as unknown as readonly T[];
    }

    return [{
      sourceKeyword: '新能源',
      targetKeyword: '白银',
      relationType: 'driver',
      direction: 'forward',
      confidence: 0.91,
      weakSignal: true,
      reasoning: '新能源扩产推升银浆需求。',
    }] as unknown as readonly T[];
  }
}

describe('friend-network query service', () => {
  it('builds graph queries for summary, nodes, neighbors and weak signals', async () => {
    const graphClient = new FakeGraphClient();
    const service = new FriendNetworkQueryService(graphClient);

    const [summary, nodes, neighbors, weakSignals] = await Promise.all([
      service.querySummary('cluster-a'),
      service.queryNodes('cluster-a'),
      service.queryNeighbors('cluster-a', '白银'),
      service.queryWeakSignals('cluster-a'),
    ]);

    expect(summary).toEqual({
      cluster: 'cluster-a',
      nodeCount: 3,
      relationshipCount: 2,
    });
    expect(nodes[0]?.keyword).toBe('白银');
    expect(neighbors[0]?.targetKeyword).toBe('白银');
    expect(weakSignals[0]?.weakSignal).toBe(true);
    expect(graphClient.queries).toHaveLength(5);
  });
});
