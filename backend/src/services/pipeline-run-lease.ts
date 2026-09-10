import pg from 'pg';
import { AiNeedsAttentionError, AiPausedError } from './ai-scheduling-errors.js';

/** Session lock spans preparation, AI, scoring, publication and diagnostics. */
export class PipelineRunLease {
  public readonly controller = new AbortController();
  private readonly client: pg.Client;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private checking = false;
  public constructor(connectionString: string, private readonly traceId: string) {
    this.client = new pg.Client({ connectionString, connectionTimeoutMillis:10000, query_timeout:10000 });
    this.client.on('error', () => this.controller.abort(new AiPausedError('Pipeline database lease lost')));
  }
  public async start(timeoutMs: number): Promise<void> {
    await this.client.connect();
    const result = await this.client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS owned', [`pipeline:${this.traceId}`]);
    if (!result.rows[0]?.owned) {
      await this.client.end();
      throw new AiNeedsAttentionError('This pipeline is already running');
    }
    this.timer = setTimeout(() => this.controller.abort(new AiPausedError('One-hour pipeline deadline reached')), timeoutMs);
    this.heartbeat = setInterval(() => {
      if (this.checking) return;
      this.checking = true;
      void this.client.query('SELECT 1').catch(() => this.controller.abort(new AiPausedError('Pipeline database lease lost')))
        .finally(() => { this.checking = false; });
    }, 10000);
  }
  public assertActive(): void { this.controller.signal.throwIfAborted(); }
  public async close(): Promise<void> {
    clearTimeout(this.timer); clearInterval(this.heartbeat);
    await this.client.end();
  }
}
