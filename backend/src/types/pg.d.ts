declare module 'pg' {
  export class Client {
    public constructor(options: { connectionString: string });
    public connect(): Promise<void>;
    public query(queryText: string, values?: readonly unknown[]): Promise<unknown>;
    public end(): Promise<void>;
  }
}
