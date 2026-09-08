import { createHash } from 'node:crypto';
import { AiNeedsAttentionError } from './ai-scheduling-errors.js';

export function inputFingerprint(value: unknown): string {
  const canonical = (item: any): any => item instanceof Date ? item.toISOString()
    : Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export async function checkpointWork<T>(prisma: any, traceId: string, stage: string, input: unknown, work: () => Promise<T>): Promise<T> {
  const fingerprint = inputFingerprint(input);
  const rows = await prisma.$queryRawUnsafe('SELECT input,result FROM "PipelineCheckpoint" WHERE "traceId"=$1 AND stage=$2', traceId, stage);
  if (rows.length) {
    if (rows[0].input !== fingerprint) throw new AiNeedsAttentionError(`Checkpoint input changed: ${stage}; use a new trace`);
    return rows[0].result as T;
  }
  const result = await work();
  if (result === undefined) return result;
  await prisma.$executeRawUnsafe('INSERT INTO "PipelineCheckpoint"("traceId",stage,input,result) VALUES($1,$2,$3,$4::jsonb)', traceId, stage, fingerprint, JSON.stringify(result));
  return result;
}

/** Compare actual persisted artifacts, not merely the number of rows. */
export async function artifactFingerprint(prisma: any, where: Record<string, unknown>, tables: readonly string[], fields?: readonly string[]): Promise<string> {
  const artifacts = await Promise.all(tables.map(async table => {
    const rows = await prisma[table]?.findMany?.({where}) ?? [];
    return [table, rows.map((row: Record<string, unknown>) => inputFingerprint(fields
      ? Object.fromEntries(fields.map(field => [field,row[field]]))
      : row)).sort()];
  }));
  return inputFingerprint(artifacts);
}
