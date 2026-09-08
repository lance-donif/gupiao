import pg from 'pg';
import type { AiRequestContext } from './ai-request-context.js';
import { AiNeedsAttentionError, AiPausedError } from './ai-scheduling-errors.js';

export interface AiHealth {
  identity: string;
  capacity: number;
  successes: number;
  stableSince: number;
  failures: number;
  cooldownUntil: number;
  disabled: boolean;
  probing: boolean;
  latency: number;
  validRate: number;
  nextStart: number;
  minute: { at: number; tokens: number }[];
  day: string;
  dayRequests: number;
  dayTokens: number;
  learnedRpm?: number;
  learnedTpm?: number;
}
export interface AiLease { id: string; candidate: string; scopes: string[]; expiresAt: number; startedAt: number; tokens: number; }
export interface AiSchedulerSnapshot { health: Record<string, AiHealth>; leases: AiLease[]; }
export interface AiAttemptRecord { id: string; candidate: string; taskId?: string; status: string; kind?: string; httpStatus?: number; latencyMs?: number; }
export interface AiSchedulerStore {
  transact<T>(fn: (snapshot: AiSchedulerSnapshot) => T, context?: AiRequestContext, reserve?: boolean): Promise<T>;
  record(attempt: AiAttemptRecord): Promise<void>;
  waiting?(context: AiRequestContext, nextAttemptAt: number): Promise<void>;
}

export class MemoryAiSchedulerStore implements AiSchedulerStore {
  public snapshot: AiSchedulerSnapshot = { health: {}, leases: [] };
  public attempts: AiAttemptRecord[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  public transact<T>(fn: (snapshot: AiSchedulerSnapshot) => T): Promise<T> {
    const result = this.tail.then(() => { const copy = structuredClone(this.snapshot); const result = fn(copy); this.snapshot = copy; return result; });
    this.tail = result.catch(() => undefined);
    return result;
  }
  public async record(attempt: AiAttemptRecord): Promise<void> { this.attempts.push(attempt); }
}

export class PostgresAiSchedulerStore implements AiSchedulerStore {
  public readonly pool: pg.Pool;
  public constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4, idleTimeoutMillis: 1000, connectionTimeoutMillis: 15000, allowExitOnIdle: true });
    this.pool.on('error', () => { /* Failed operations propagate to the caller; never log connection credentials. */ });
  }
  public async transact<T>(fn: (snapshot: AiSchedulerSnapshot) => T, context?: AiRequestContext, reserve = false): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(917420260908)");
      const rows = await client.query('SELECT state FROM "AiSchedulerState" WHERE id=$1 FOR UPDATE', ['global']);
      const snapshot: AiSchedulerSnapshot = rows.rows[0]?.state ?? { health: {}, leases: [] };
      for(const lease of snapshot.leases.filter(item=>item.expiresAt<Date.now())) await client.query('UPDATE "AiAttempt" SET status=\'EXPIRED\',"completedAt"=now() WHERE id=$1 AND status=\'RUNNING\'',[lease.id]);
      const previousIds = new Set(snapshot.leases.map(lease => lease.id));
      const result = fn(snapshot);
      const added = snapshot.leases.filter(lease => !previousIds.has(lease.id));
      if (reserve && added.length && context) {
        const owned = await client.query('SELECT id FROM "AiWorkItem" WHERE id=$1 AND owner=$2 AND status IN (\'RUNNING\',\'WAITING\') AND "leaseUntil">now() FOR UPDATE', [context.taskId, context.owner]);
        if (!owned.rowCount || Date.now() >= context.deadline || context.signal.aborted) throw new AiPausedError('AI task lease or run deadline expired');
        const updated = await client.query('UPDATE "AiWorkItem" SET "requestCount"="requestCount"+1 WHERE id=$1 AND "requestCount"<$2 RETURNING id', [context.rootId, context.maxAttempts]);
        if (!updated.rowCount) throw new AiNeedsAttentionError('AI task request budget exhausted');
        await client.query('UPDATE "AiWorkItem" SET status=\'RUNNING\' WHERE id=$1',[context.taskId]);
      }
      for (const lease of added) {
        await client.query('INSERT INTO "AiAttempt" (id,"taskId",candidate,status,"startedAt") VALUES($1,$2,$3,$4,now())', [lease.id, context?.taskId ?? null, lease.candidate, 'RUNNING']);
      }
      await client.query('INSERT INTO "AiSchedulerState"(id,state,"updatedAt") VALUES($1,$2,now()) ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state,"updatedAt"=now()', ['global', JSON.stringify(snapshot)]);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
  public async record(attempt: AiAttemptRecord): Promise<void> {
    await this.pool.query('UPDATE "AiAttempt" SET status=$2,kind=$3,"httpStatus"=$4,"latencyMs"=$5,"completedAt"=now() WHERE id=$1', [attempt.id, attempt.status, attempt.kind ?? null, attempt.httpStatus ?? null, attempt.latencyMs ?? null]);
  }
  public async waiting(context:AiRequestContext,nextAttemptAt:number):Promise<void> {
    await this.pool.query('UPDATE "AiWorkItem" SET status=\'WAITING\',"nextAttemptAt"=$3 WHERE id=$1 AND owner=$2 AND status IN (\'RUNNING\',\'WAITING\')',[context.taskId,context.owner,new Date(nextAttemptAt)]);
  }
}

const stores = new Map<string, PostgresAiSchedulerStore>();
export function aiStoreFromDatabase(connectionString: string): PostgresAiSchedulerStore {
  let store = stores.get(connectionString);
  if (!store) { store = new PostgresAiSchedulerStore(connectionString); stores.set(connectionString, store); }
  return store;
}
