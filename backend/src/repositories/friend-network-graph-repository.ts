import type {
  IFriendNetworkPersistedNode,
  IFriendNetworkPersistedRelationship,
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

const toJsonLiteral = (value: unknown): string => {
  return JSON.stringify(value);
};

const buildNodeMergeCypher = (cluster: string, node: IFriendNetworkPersistedNode): string => {
  return [
    `MERGE (n:SignalNode {cluster: ${quoteCypherString(cluster)}, keyword: ${quoteCypherString(node.keyword)}})`,
    `SET n.category = ${quoteCypherString(node.category)},`,
    `    n.frequency = ${node.frequency},`,
    `    n.temperature = ${quoteCypherString(node.temperature)},`,
    `    n.weakSignal = ${String(node.weakSignal)},`,
    `    n.updatedAt = ${quoteCypherString(node.updatedAt)},`,
    `    n.lastNewsIds = ${quoteCypherString(toJsonLiteral(node.newsIds))}`,
    'RETURN n',
  ].join(' ');
};

const buildRelationshipMergeCypher = (
  cluster: string,
  relationship: IFriendNetworkPersistedRelationship,
): string => {
  return [
    `MATCH (source:SignalNode {cluster: ${quoteCypherString(cluster)}, keyword: ${quoteCypherString(relationship.sourceKeyword)}})`,
    `MATCH (target:SignalNode {cluster: ${quoteCypherString(cluster)}, keyword: ${quoteCypherString(relationship.targetKeyword)}})`,
    `MERGE (source)-[r:FRIEND_RELATION {cluster: ${quoteCypherString(cluster)}, sourceKeyword: ${quoteCypherString(relationship.sourceKeyword)}, targetKeyword: ${quoteCypherString(relationship.targetKeyword)}}]->(target)`,
    `SET r.relationType = ${quoteCypherString(relationship.relationType)},`,
    `    r.direction = ${quoteCypherString(relationship.direction)},`,
    `    r.status = ${quoteCypherString(relationship.status)},`,
    `    r.confidence = ${relationship.confidence},`,
    `    r.weakSignal = ${String(relationship.weakSignal)},`,
    `    r.updatedAt = ${quoteCypherString(relationship.updatedAt)},`,
    `    r.reasoning = ${quoteCypherString(relationship.reasoning)},`,
    `    r.evidence = ${quoteCypherString(toJsonLiteral(relationship.evidence))},`,
    `    r.newsIds = ${quoteCypherString(toJsonLiteral(relationship.newsIds))}`,
    'RETURN r',
  ].join(' ');
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

  public async query<T>(cypher: string, columnNames?: readonly string[]): Promise<readonly T[]> {
    const rows = await this.runCypher(cypher, columnNames);
    return rows as readonly T[];
  }

  private async runCypher(cypher: string, columnNames?: readonly string[]): Promise<readonly Record<string, unknown>[]> {
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
      const sql = `SELECT * FROM ag_catalog.cypher('${escapedGraphName}', $$ ${cypher} $$) AS (${columnDefinition});`;
      const result = await client.query(sql);
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
    const statements = [
      ...input.nodes.map(node => buildNodeMergeCypher(input.cluster, node)),
      ...input.relationships.map(relationship => buildRelationshipMergeCypher(input.cluster, relationship)),
    ];

    for (const statement of statements) {
      await this.graphClient.execute(statement);
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

  public query<T>(cypher: string, columnNames?: readonly string[]): Promise<readonly T[]> {
    return this.baseClient.query<T>(cypher, columnNames);
  }

  public close(): Promise<void> {
    return this.baseClient.close();
  }
}
