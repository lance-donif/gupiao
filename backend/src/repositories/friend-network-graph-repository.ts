import type {
  IFriendNetworkPersistenceResult,
  IFriendNetworkPersistInput,
} from '../services/friend-network-types.js';
import type { IFriendNetworkGraphRepository } from './interfaces/i-friend-network-graph-repository.js';

const escapeCypherLiteral = (value: string): string => {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
};

const quoteCypherString = (value: string): string => {
  return `"${escapeCypherLiteral(value)}"`;
};

const normalizeAgtypeScalar = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    }
    catch {
      return trimmed.slice(1, -1);
    }
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  if (trimmed === 'true') { return true; }
  if (trimmed === 'false') { return false; }

  return trimmed;
};

export interface IAgeGraphClient {
  execute: (cypher: string) => Promise<void>;
  executeBatch: (cypher: string, params: Readonly<Record<string, unknown>>) => Promise<void>;
  query: <T>(cypher: string, columnNames?: readonly string[]) => Promise<readonly T[]>;
  close: () => Promise<void>;
}

export class PgAgeGraphClient implements IAgeGraphClient {
  public constructor(
    private readonly databaseUrl: string,
    private readonly graphName: string,
  ) {}

  public async execute(cypher: string): Promise<void> {
    await this.runCypher(cypher);
  }

  public async executeBatch(cypher: string, params: Readonly<Record<string, unknown>>): Promise<void> {
    await this.runCypher(cypher, undefined, params);
  }

  public async query<T>(cypher: string, columnNames?: readonly string[]): Promise<readonly T[]> {
    const rows = await this.runCypher(cypher, columnNames);
    return rows as readonly T[];
  }

  private async runCypher(
    cypher: string,
    columnNames?: readonly string[],
    params?: Readonly<Record<string, unknown>>,
  ): Promise<readonly Record<string, unknown>[]> {
    const pgModule = (await import('pg')) as {
      Client: new (options: { connectionString: string }) => {
        connect: () => Promise<void>;
        query: (queryText: string, values?: readonly unknown[]) => Promise<{ rows: readonly Record<string, unknown>[] }>;
        end: () => Promise<void>;
      };
    };
    const client = new pgModule.Client({ connectionString: this.databaseUrl });

    await client.connect();
    try {
      await client.query('LOAD \'age\'');
      await client.query('SET search_path = ag_catalog, "$user", public');
      const escapedGraphName = this.graphName.replace(/'/g, '\'\'');
      const columnDefinition = columnNames && columnNames.length > 0
        ? columnNames.map(name => `${name} agtype`).join(', ')
        : 'result agtype';
      const paramValues = params ? Object.values(params) : [];
      const sql = `SELECT * FROM ag_catalog.cypher('${escapedGraphName}', $$ ${cypher} $$, ${paramValues.length > 0 ? paramValues.map((_, i) => `$${i + 1}::agtype`).join(', ') : 'NULL'}) AS (${columnDefinition});`;
      const result = await client.query(sql, paramValues);
      return result.rows.map((row) => {
        const normalizedEntries = Object.entries(row).map(([key, value]) => [key, normalizeAgtypeScalar(value)]);
        return Object.fromEntries(normalizedEntries);
      });
    }
    finally {
      await client.end();
    }
  }

  public async close(): Promise<void> {
    return Promise.resolve();
  }
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

export const buildDeleteClusterGraphCypher = (cluster: string): readonly string[] => {
  return [
    `MATCH ()-[r:FRIEND_RELATION {cluster: ${quoteCypherString(cluster)}}]->() DELETE r RETURN 1`,
    `MATCH (n:SignalNode {cluster: ${quoteCypherString(cluster)}}) DELETE n RETURN 1`,
  ];
};

export class FriendNetworkAgeGraphReadClient implements IAgeGraphClient {
  public constructor(private readonly baseClient: PgAgeGraphClient) {}

  public execute(cypher: string): Promise<void> {
    return this.baseClient.execute(cypher);
  }

  public executeBatch(cypher: string, params: Readonly<Record<string, unknown>>): Promise<void> {
    return this.baseClient.executeBatch(cypher, params);
  }

  public query<T>(cypher: string, columnNames?: readonly string[]): Promise<readonly T[]> {
    return this.baseClient.query<T>(cypher, columnNames);
  }

  public close(): Promise<void> {
    return this.baseClient.close();
  }
}
