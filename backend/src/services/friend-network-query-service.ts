import type { IAgeGraphClient } from '../repositories/friend-network-graph-repository.js';

export interface IFriendNetworkRelationQueryResult {
  readonly sourceKeyword: string;
  readonly targetKeyword: string;
  readonly relationType: string;
  readonly direction: string;
  readonly confidence: number;
  readonly weakSignal: boolean;
  readonly reasoning: string;
}

export interface IFriendNetworkNodeQueryResult {
  readonly keyword: string;
  readonly category: string;
  readonly frequency: number;
  readonly temperature: string;
  readonly weakSignal: boolean;
}

export interface IFriendNetworkGraphSummary {
  readonly cluster: string;
  readonly nodeCount: number;
  readonly relationshipCount: number;
}

export interface IAgeGraphReadClient extends IAgeGraphClient {
  query: <T>(cypher: string, columnNames?: readonly string[]) => Promise<readonly T[]>;
}

const quoteCypherString = (value: string): string => {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

export class FriendNetworkQueryService {
  public constructor(private readonly graphClient: IAgeGraphReadClient) {}

  public queryNeighbors(cluster: string, keyword: string): Promise<readonly IFriendNetworkRelationQueryResult[]> {
    return this.graphClient.query<IFriendNetworkRelationQueryResult>([
      `MATCH (source:SignalNode {cluster: ${quoteCypherString(cluster)}, keyword: ${quoteCypherString(keyword)}})-[r:FRIEND_RELATION]->(target:SignalNode)`,
      'RETURN properties(source).keyword AS sourceKeyword,',
      'properties(target).keyword AS targetKeyword,',
      'properties(r).relationType AS relationType,',
      'properties(r).direction AS direction,',
      'properties(r).confidence AS confidence,',
      'properties(r).weakSignal AS weakSignal,',
      'properties(r).reasoning AS reasoning',
      'ORDER BY r.confidence DESC',
    ].join(' '), ['sourceKeyword', 'targetKeyword', 'relationType', 'direction', 'confidence', 'weakSignal', 'reasoning']);
  }

  public queryWeakSignals(cluster: string): Promise<readonly IFriendNetworkRelationQueryResult[]> {
    return this.graphClient.query<IFriendNetworkRelationQueryResult>([
      `MATCH (source:SignalNode {cluster: ${quoteCypherString(cluster)}})-[r:FRIEND_RELATION]->(target:SignalNode {cluster: ${quoteCypherString(cluster)}})`,
      'WHERE r.weakSignal = true',
      'RETURN properties(source).keyword AS sourceKeyword,',
      'properties(target).keyword AS targetKeyword,',
      'properties(r).relationType AS relationType,',
      'properties(r).direction AS direction,',
      'properties(r).confidence AS confidence,',
      'properties(r).weakSignal AS weakSignal,',
      'properties(r).reasoning AS reasoning',
      'ORDER BY r.confidence DESC',
    ].join(' '), ['sourceKeyword', 'targetKeyword', 'relationType', 'direction', 'confidence', 'weakSignal', 'reasoning']);
  }

  public queryNodes(cluster: string): Promise<readonly IFriendNetworkNodeQueryResult[]> {
    return this.graphClient.query<IFriendNetworkNodeQueryResult>([
      `MATCH (node:SignalNode {cluster: ${quoteCypherString(cluster)}})`,
      'RETURN properties(node).keyword AS keyword,',
      'properties(node).category AS category,',
      'properties(node).frequency AS frequency,',
      'properties(node).temperature AS temperature,',
      'properties(node).weakSignal AS weakSignal',
      'ORDER BY node.frequency DESC, node.keyword ASC',
    ].join(' '), ['keyword', 'category', 'frequency', 'temperature', 'weakSignal']);
  }

  public async querySummary(cluster: string): Promise<IFriendNetworkGraphSummary> {
    const nodes = await this.graphClient.query<{ total: number }>([
      `MATCH (node:SignalNode {cluster: ${quoteCypherString(cluster)}})`,
      'WITH count(node) AS total',
      'RETURN total',
    ].join(' '), ['total']);
    const relationships = await this.graphClient.query<{ total: number }>([
      `MATCH (:SignalNode {cluster: ${quoteCypherString(cluster)}})-[r:FRIEND_RELATION]->(:SignalNode {cluster: ${quoteCypherString(cluster)}})`,
      'WITH count(r) AS total',
      'RETURN total',
    ].join(' '), ['total']);

    return {
      cluster,
      nodeCount: nodes[0]?.total ?? 0,
      relationshipCount: relationships[0]?.total ?? 0,
    };
  }
}
