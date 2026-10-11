import type {
  IFriendNetworkPersistenceResult,
  IFriendNetworkPersistInput,
} from '../services/friend-network-types.js';
import type { IFriendNetworkGraphRepository } from './interfaces/i-friend-network-graph-repository.js';

export interface IAgeGraphClient {
  execute: (cypher: string) => Promise<void>;
  executeBatch: (cypher: string, params: Readonly<Record<string, unknown>>) => Promise<void>;
  query: <T>(cypher: string, columnNames?: readonly string[]) => Promise<readonly T[]>;
  close: () => Promise<void>;
}



export class FriendNetworkGraphRepository implements IFriendNetworkGraphRepository {
  public constructor(
    private readonly graphClient: IAgeGraphClient,
    private readonly graphName: string = 'friend_network',
  ) {}

  public async persist(input: IFriendNetworkPersistInput): Promise<IFriendNetworkPersistenceResult> {
    // 批量 MERGE：单条 UNWIND 替代 N 次 MERGE 循环（消除 N+1：N → 2 次 round-trip）
    if (input.nodes.length > 0) {
      const nodeRows = input.nodes.map(node => ({
        keyword: node.keyword,
        category: node.category,
        frequency: node.frequency,
        temperature: node.temperature,
        weakSignal: node.weakSignal,
        updatedAt: node.updatedAt,
        newsIds: node.newsIds,
      }));
      const nodeCypher = [
        'UNWIND $rows AS row',
        'MERGE (n:SignalNode {cluster: $cluster, keyword: row.keyword})',
        'SET n.category = row.category,',
        '    n.frequency = row.frequency,',
        '    n.temperature = row.temperature,',
        '    n.weakSignal = row.weakSignal,',
        '    n.updatedAt = row.updatedAt,',
        '    n.lastNewsIds = row.newsIds',
        'RETURN n',
      ].join(' ');
      await this.graphClient.executeBatch(nodeCypher, { cluster: input.cluster, rows: nodeRows });
    }

    if (input.relationships.length > 0) {
      const relRows = input.relationships.map(rel => ({
        sourceKeyword: rel.sourceKeyword,
        targetKeyword: rel.targetKeyword,
        relationType: rel.relationType,
        direction: rel.direction,
        status: rel.status,
        confidence: rel.confidence,
        weakSignal: rel.weakSignal,
        updatedAt: rel.updatedAt,
        reasoning: rel.reasoning,
        evidence: rel.evidence,
        newsIds: rel.newsIds,
      }));
      const relCypher = [
        'UNWIND $rows AS row',
        'MATCH (source:SignalNode {cluster: $cluster, keyword: row.sourceKeyword})',
        'MATCH (target:SignalNode {cluster: $cluster, keyword: row.targetKeyword})',
        'MERGE (source)-[r:FRIEND_RELATION {cluster: $cluster, sourceKeyword: row.sourceKeyword, targetKeyword: row.targetKeyword}]->(target)',
        'SET r.relationType = row.relationType,',
        '    r.direction = row.direction,',
        '    r.status = row.status,',
        '    r.confidence = row.confidence,',
        '    r.weakSignal = row.weakSignal,',
        '    r.updatedAt = row.updatedAt,',
        '    r.reasoning = row.reasoning,',
        '    r.evidence = row.evidence,',
        '    r.newsIds = row.newsIds',
        'RETURN r',
      ].join(' ');
      await this.graphClient.executeBatch(relCypher, { cluster: input.cluster, rows: relRows });
    }

    return {
      cluster: input.cluster,
      graphName: this.graphName,
      nodeCount: input.nodes.length,
      relationshipCount: input.relationships.length,
      persistedAt: input.asOf.toISOString(),
    };
  }
}

