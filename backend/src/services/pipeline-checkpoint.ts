import { createHash } from 'node:crypto';
import { AiNeedsAttentionError } from './ai-scheduling-errors.js';
import { assertLeaseHolder, type LeaseGuard } from './pipeline-run-lease.js';
import { TraceManager } from './trace-manager.js';

/** 稳定规范化：对象键排序、Date 转 ISO、bigint 转字符串、遵循 toJSON。 */
export function canonicalizeValue(value: unknown): unknown {
  const canonical = (item: any): any => typeof item === 'bigint' ? item.toString() : item instanceof Date ? item.toISOString()
    : item && typeof item.toJSON === 'function' ? canonical(item.toJSON())
    : Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return canonical(value);
}

/** 规范化后的 JSON 字符串；分片切分与哈希都基于它，保证跨执行者一致。 */
export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

export function inputFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJsonString(value)).digest('hex');
}

/**
 * 可选租约守卫：产物/检查点提交前，调用方须通过 `owner + generation` 证明自己仍是
 * 当前租约持有者。缺省（undefined）表示不启用守卫，保持旧调用点行为不变。
 */
export type CheckpointLeaseGuard = LeaseGuard;

export async function checkpointWork<T>(prisma: any, traceId: string, stage: string, input: unknown, work: () => Promise<T>, lease?: CheckpointLeaseGuard | null): Promise<T> {
  const fingerprint = inputFingerprint(input);
  const rows = await prisma.$queryRawUnsafe('SELECT input,result FROM "PipelineCheckpoint" WHERE "traceId"=$1 AND stage=$2', traceId, stage);
  if (rows.length) {
    if (rows[0].input !== fingerprint) throw new AiNeedsAttentionError(`Checkpoint input changed: ${stage}; use a new trace`);
    return rows[0].result as T;
  }
  const result = await work();
  if (result === undefined) return result;
  // 过期执行者即便拿到成功响应，也不得落库：提交前做 owner + leaseUntil + generation 三重校验。
  if (lease) await assertLeaseHolder(prisma, { traceId, owner: lease.owner, generation: lease.generation });
  await prisma.$executeRawUnsafe('INSERT INTO "PipelineCheckpoint"("traceId",stage,input,result) VALUES($1,$2,$3,$4::jsonb)', traceId, stage, fingerprint, JSON.stringify(result));
  return result;
}

/** Compare actual persisted artifacts, not merely the number of rows. */
export async function artifactFingerprint(prisma: any, where: Record<string, unknown>, tables: readonly string[], fields?: readonly string[]): Promise<string> {
  const artifacts = await Promise.all(tables.map(async table => {
    const rows = await prisma[table]?.findMany?.({where}) ?? [];
    return [table, rows.map((row: Record<string, unknown>) => inputFingerprint(fields
      ? Object.fromEntries(fields.map(field => [field,row[field]]))
      : Object.fromEntries(Object.entries(row).filter(([key])=>!['createdAt','updatedAt','isReconciled','realizedDirection','realizedChangePct'].includes(key))))).sort()];
  }));
  return inputFingerprint(artifacts);
}

/** Compute local stages and their success marker in the same transaction. */
export async function runArtifactStage<T extends Record<string, any>>(
  prisma: any, traceId: string, clusterKey: string, stage: string,
  input: unknown, tables: readonly string[], work: (tx: any) => Promise<T>,
): Promise<T> {
  const fingerprint = inputFingerprint(input);
  const completed = (await TraceManager.getSuccessfulStepOutputs(prisma,traceId)).get(stage);
  const where = {traceId,clusterKey};
  if (completed?.inputFingerprint === fingerprint && completed.artifactFingerprint === await artifactFingerprint(prisma,where,tables)) {
    return completed.result as T;
  }
  await TraceManager.startStepTrace(prisma,traceId,stage,{inputFingerprint:fingerprint});
  return prisma.$transaction(async (tx: any) => {
    for (const table of tables) await tx[table].deleteMany({where});
    const result = await work(tx);
    await TraceManager.completeStepTrace(tx,traceId,stage,{
      inputFingerprint:fingerprint, artifactFingerprint:await artifactFingerprint(tx,where,tables),result,
    });
    return result;
  },{timeout:300000});
}
