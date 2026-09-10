import pg from 'pg';
import { AiNeedsAttentionError, AiPausedError } from './ai-scheduling-errors.js';

/**
 * 运行租约：会话级 advisory lock + 递增代次（generation）。
 *
 * 除了「同一 trace 同时只有一个执行者」之外，本模块还引入了**代次**语义：
 * 每次 `start()` 都会在 `PipelineCheckpoint` 的保留槽位上写入一条租约记录
 * `{ owner, leaseUntil, generation }`（generation 单调递增）。这样即使旧执行者
 * 因网络分区/连接假死而晚到，也能被 `isLeaseHolder` 判为过期，从而**不得提交产物**。
 *
 * 说明：租约记录使用保留 stage 名存放在既有 `PipelineCheckpoint` 表中，不改变
 * 既有 stage 的检查点语义（保留 stage 名与真实阶段名不会冲突，旧数据仍可读出）。
 */
export const PIPELINE_LEASE_STAGE = '__pipeline_run_lease__';

/** 持久化的租约记录。 */
export interface LeaseRecord {
  owner: string | null;
  leaseUntil: string;
  generation: number;
}

/** 判定「我是否仍是当前租约持有者」的输入。 */
export interface LeaseGuard {
  owner: string;
  generation: number;
}

export interface LeaseHolderQuery extends LeaseGuard {
  traceId: string;
  now?: Date;
}

/** 读取持久化租约记录；无记录返回 null。 */
export async function readLeaseRecord(prisma: any, traceId: string): Promise<LeaseRecord | null> {
  if (prisma.runLease?.findUnique) {
    const row = await prisma.runLease.findUnique({
      where: { traceId },
      select: { owner: true, generation: true, leaseUntil: true },
    });
    if (row) {
      return {
        owner: row.owner ?? null,
        leaseUntil: row.leaseUntil instanceof Date ? row.leaseUntil.toISOString() : String(row.leaseUntil),
        generation: Number(row.generation),
      };
    }
  }
  if (!prisma.pipelineCheckpoint?.findFirst) return null;
  const row = await prisma.pipelineCheckpoint.findFirst({
    where: { traceId, stage: PIPELINE_LEASE_STAGE },
    select: { result: true },
  });
  const value = row?.result;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const generation = Number(record.generation);
  if (!Number.isFinite(generation)) return null;
  return {
    owner: typeof record.owner === 'string' ? record.owner : null,
    leaseUntil: typeof record.leaseUntil === 'string' ? record.leaseUntil : new Date(0).toISOString(),
    generation,
  };
}

/**
 * 纯判定函数：`owner` + `generation` 必须与当前租约记录完全一致，且 `leaseUntil >= now`。
 * 三项任一不满足即视为过期执行者。可被测试直接调用。
 */
export async function isLeaseHolder(prisma: any, query: LeaseHolderQuery): Promise<boolean> {
  const record = await readLeaseRecord(prisma, query.traceId);
  if (!record) return false;
  if (record.owner !== query.owner) return false;
  if (record.generation !== query.generation) return false;
  const now = (query.now ?? new Date()).getTime();
  return new Date(record.leaseUntil).getTime() >= now;
}

/** 非持有者提交一律抛错，绝不静默丢弃。 */
export async function assertLeaseHolder(prisma: any, query: LeaseHolderQuery): Promise<void> {
  if (!(await isLeaseHolder(prisma, query))) {
    throw new AiPausedError(`Pipeline lease lost: 提交被拒绝 (owner=${query.owner}, generation=${query.generation})`);
  }
}

/** Session lock spans preparation, AI, scoring, publication and diagnostics. */
export class PipelineRunLease {
  public readonly controller = new AbortController();
  public readonly owner: string;
  private readonly client: pg.Client;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private checking = false;
  private generation = 0;
  private timeoutMs = 0;
  private leaseUntil = new Date(0);
  private superseded = false;
  public constructor(connectionString: string, private readonly traceId: string, owner?: string) {
    this.owner = owner ?? `owner-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.client = new pg.Client({ connectionString, connectionTimeoutMillis:10000, query_timeout:10000 });
    this.client.on('error', () => this.controller.abort(new AiPausedError('Pipeline database lease lost')));
  }
  public async start(timeoutMs: number): Promise<void> {
    await this.client.connect();
    try {
      // advisory lock 是数据库级全局的，测试/多环境并行时必须把 database + schema 纳入 key，
      // 否则不同 schema 下同名 traceId 会互相抢锁（生产固定 public，语义不变）。
      const result = await this.client.query(
        "SELECT pg_try_advisory_lock(hashtextextended(current_database() || ':' || current_schema() || ':pipeline:' || $1, 0)) AS owned",
        [this.traceId],
      );
      if (!result.rows[0]?.owned) {
        throw new AiNeedsAttentionError('This pipeline is already running');
      }
      this.timeoutMs = timeoutMs;
      this.leaseUntil = new Date(Date.now() + timeoutMs);
      const existing = await this.readPersistedLease();
      // 代次单调递增：接管者必然拿到比前任更大的 generation。
      this.generation = (existing?.generation ?? 0) + 1;
      await this.writePersistedLease();
      this.timer = setTimeout(() => this.controller.abort(new AiPausedError('One-hour pipeline deadline reached')), timeoutMs);
      this.heartbeat = setInterval(() => { void this.renew(); }, 10000);
    } catch (error) {
      // 启动失败必须关闭连接：否则会话会一直持有 advisory lock，阻塞后续接管。
      clearTimeout(this.timer);
      clearInterval(this.heartbeat);
      await this.client.end().catch(() => undefined);
      throw error;
    }
  }
  /** 当前代次；`start()` 之前为 0。 */
  public currentGeneration(): number { return this.generation; }
  /** 当前租约到期时间。 */
  public currentLeaseUntil(): Date { return new Date(this.leaseUntil.getTime()); }
  /**
   * 校验存活与代次：既检查 abort 信号（心跳在失去代次或连接时触发），
   * 也检查代次是否仍为本次 `start()` 取得的代次。
   */
  public assertActive(): void {
    this.controller.signal.throwIfAborted();
    if (this.superseded) throw new AiPausedError('Pipeline lease generation superseded');
  }
  public async close(): Promise<void> {
    clearTimeout(this.timer); clearInterval(this.heartbeat);
    try { await this.releasePersistedLease(); } catch { /* 释放失败不应阻塞关闭；advisory lock 随连接释放。 */ }
    await this.client.end();
  }
  private async renew(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const record = await this.readPersistedLease();
      if (!record || record.owner !== this.owner || record.generation !== this.generation) {
        this.superseded = true;
        this.controller.abort(new AiPausedError('Pipeline lease generation superseded'));
        return;
      }
      await this.client.query('SELECT 1');
      this.leaseUntil = new Date(Date.now() + this.timeoutMs);
      await this.writePersistedLease();
    } catch {
      this.controller.abort(new AiPausedError('Pipeline database lease lost'));
    } finally {
      this.checking = false;
    }
  }
  private async readPersistedLease(): Promise<LeaseRecord | null> {
    const hasRunLease = await this.leaseTableExists();
    if (hasRunLease) {
      const result = await this.client.query('SELECT owner, generation, "leaseUntil" FROM "RunLease" WHERE "traceId"=$1', [this.traceId]);
      const row = result.rows[0] as { owner?: string | null; generation?: number | string; leaseUntil?: string | Date } | undefined;
      if (!row) return null;
      const generation = Number(row.generation);
      if (!Number.isFinite(generation)) return null;
      return {
        owner: row.owner ?? null,
        leaseUntil: row.leaseUntil instanceof Date ? row.leaseUntil.toISOString() : String(row.leaseUntil),
        generation,
      };
    }
    const result = await this.client.query('SELECT result FROM "PipelineCheckpoint" WHERE "traceId"=$1 AND stage=$2', [this.traceId, PIPELINE_LEASE_STAGE]);
    const value = result.rows[0]?.result;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const generation = Number(record.generation);
    if (!Number.isFinite(generation)) return null;
    return {
      owner: typeof record.owner === 'string' ? record.owner : null,
      leaseUntil: typeof record.leaseUntil === 'string' ? record.leaseUntil : new Date(0).toISOString(),
      generation,
    };
  }
  private async writePersistedLease(): Promise<void> {
    if (await this.leaseTableExists()) {
      await this.client.query(
        'INSERT INTO "RunLease"("id","traceId",owner,generation,"leaseUntil","updatedAt") VALUES(gen_random_uuid(),$1,$2,$3,$4,now()) '
        + 'ON CONFLICT ("traceId") DO UPDATE SET owner=EXCLUDED.owner,generation=EXCLUDED.generation,"leaseUntil"=EXCLUDED."leaseUntil","updatedAt"=now()',
        [this.traceId, this.owner, this.generation, this.leaseUntil],
      );
      return;
    }
    const payload: LeaseRecord = { owner: this.owner, leaseUntil: this.leaseUntil.toISOString(), generation: this.generation };
    await this.client.query(
      'INSERT INTO "PipelineCheckpoint"("traceId",stage,input,result,"updatedAt") VALUES($1,$2,$3,$4::jsonb,now()) '
      + 'ON CONFLICT ("traceId",stage) DO UPDATE SET input=EXCLUDED.input,result=EXCLUDED.result,"updatedAt"=now()',
      [this.traceId, PIPELINE_LEASE_STAGE, 'lease', JSON.stringify(payload)],
    );
  }
  private async releasePersistedLease(): Promise<void> {
    if (this.generation <= 0) return;
    if (await this.leaseTableExists()) {
      await this.client.query(
        'UPDATE "RunLease" SET "owner"=NULL,"leaseUntil"=now(),"updatedAt"=now() WHERE "traceId"=$1 AND "owner"=$2',
        [this.traceId, this.owner],
      );
      return;
    }
    // 保留 generation 只是旧表兼容；新 schema 迁移后走 RunLease。
    const payload: LeaseRecord = { owner: null, leaseUntil: new Date().toISOString(), generation: this.generation };
    await this.client.query(
      "UPDATE \"PipelineCheckpoint\" SET result=$4::jsonb,\"updatedAt\"=now() WHERE \"traceId\"=$1 AND stage=$2 AND (result->>'owner')=$3",
      [this.traceId, PIPELINE_LEASE_STAGE, this.owner, JSON.stringify(payload)],
    );
  }

  private async leaseTableExists(): Promise<boolean> {
    // 用 search_path 相对名判断：schema 隔离的测试库/多 schema 部署下与后续查询保持一致。
    const result = await this.client.query("SELECT to_regclass('\"RunLease\"') IS NOT NULL AS ok");
    return Boolean(result.rows[0]?.ok);
  }
}
