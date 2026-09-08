declare module 'pg' {
  export interface PoolQueryResult { rows: any[]; rowCount: number | null; }
  export interface PoolClient {
    query(queryText: string, values?: readonly unknown[]): Promise<PoolQueryResult>;
    release(): void;
  }
  export class Pool {
    constructor(options: { connectionString: string; max?: number; idleTimeoutMillis?: number; connectionTimeoutMillis?: number; allowExitOnIdle?: boolean });
    connect(): Promise<PoolClient>;
    query(queryText: string, values?: readonly unknown[]): Promise<PoolQueryResult>;
    end(): Promise<void>;
    on(event: 'error', listener: (error: Error) => void): void;
  }
  export class Client {
    public constructor(options: { connectionString: string });
    public connect(): Promise<void>;
    public query(queryText: string, values?: readonly unknown[]): Promise<PoolQueryResult>;
    public on(event: 'error', listener: (error: Error) => void): void;
    public end(): Promise<void>;
  }
}
