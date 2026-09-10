/**
 * 不可变产物存储：以 `RunArtifact`（清单）+ `RunArtifactShard`（分片）持久化一次阶段产出。
 *
 * 关键保证：
 *  - 清单与全部分片在**同一事务**内写入，失败整体回滚，不留半成品；
 *  - `(traceId, stageId, version)` 已存在且 `contentHash` 相同视为**幂等命中**，直接返回既有产物；
 *  - `contentHash` 由分片哈希确定性推导，`assertArtifactComplete` 按「分片数 == shardCount
 *    且索引恰好覆盖 0..shardCount-1」判定完整性，**绝不**用「记录数 > 0」当判据；
 *  - 提交前可选校验租约（过期执行者不得写入）。
 */
import { inputFingerprint, canonicalJsonString } from '../pipeline-checkpoint.js';
import { assertLeaseHolder, type LeaseGuard } from '../pipeline-run-lease.js';
import { evaluateArtifactCompleteness, type ArtifactShardLike } from './artifact-completeness.js';
import { STAGE_IDS, dependentsOf, resolveStageOrder, type StageId } from './stage-registry.js';

export interface ArtifactShardInput {
  readonly shardIndex: number;
  readonly contentHash: string;
  readonly byteSize?: number | null;
}

export interface RunArtifactRecord {
  readonly id: string;
  readonly traceId: string;
  readonly stageId: string;
  readonly version: number;
  readonly inputFingerprint: string;
  readonly upstreamFingerprints: Record<string, string>;
  readonly shardCount: number;
  readonly contentHash: string;
  readonly originTraceId: string | null;
  readonly originArtifactId: string | null;
}

export interface CommitArtifactInput {
  readonly traceId: string;
  readonly stageId: StageId | string;
  readonly version: number;
  readonly inputFingerprint: string;
  readonly upstreamFingerprints: Readonly<Record<string, string>>;
  readonly shardCount: number;
  readonly shards: readonly ArtifactShardInput[];
  readonly originTraceId?: string | null;
  readonly originArtifactId?: string | null;
  /** 启用时，提交前必须证明仍是当前租约持有者。 */
  readonly lease?: LeaseGuard | null;
  readonly now?: Date;
}

export interface ArtifactRefQuery {
  readonly traceId: string;
  readonly stageId: StageId | string;
  readonly version: number;
}

export interface ArtifactValidityQuery extends ArtifactRefQuery {
  readonly inputFingerprint: string;
  readonly upstreamFingerprints: Readonly<Record<string, string>>;
}

const normalizeArtifact = (row: any): RunArtifactRecord => ({
  id: String(row.id),
  traceId: String(row.traceId),
  stageId: String(row.stageId),
  version: Number(row.version),
  inputFingerprint: String(row.inputFingerprint),
  upstreamFingerprints: (row.upstreamFingerprints && typeof row.upstreamFingerprints === 'object' && !Array.isArray(row.upstreamFingerprints))
    ? row.upstreamFingerprints as Record<string, string>
    : {},
  shardCount: Number(row.shardCount),
  contentHash: String(row.contentHash),
  originTraceId: row.originTraceId ?? null,
  originArtifactId: row.originArtifactId ?? null,
});

/** 校验分片布局：数量、索引覆盖与去重，非法直接抛错。 */
export function assertShardLayout(shardCount: number, shards: readonly ArtifactShardInput[]): void {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error(`非法的分片数量：${shardCount}`);
  if (shards.length !== shardCount) throw new Error(`分片数量 ${shards.length} 与 shardCount ${shardCount} 不一致`);
  const seen = new Set<number>();
  for (const shard of shards) {
    if (!Number.isInteger(shard.shardIndex) || shard.shardIndex < 0 || shard.shardIndex >= shardCount) {
      throw new Error(`分片索引越界：${shard.shardIndex}`);
    }
    if (seen.has(shard.shardIndex)) throw new Error(`分片索引重复：${shard.shardIndex}`);
    if (!shard.contentHash) throw new Error(`分片 ${shard.shardIndex} 缺少内容哈希`);
    seen.add(shard.shardIndex);
  }
}

/** 由分片哈希确定性推导整体 contentHash。 */
export function computeArtifactContentHash(shards: readonly ArtifactShardInput[]): string {
  const manifest = [...shards]
    .sort((left, right) => left.shardIndex - right.shardIndex)
    .map(shard => ({ shardIndex: shard.shardIndex, contentHash: shard.contentHash }));
  return inputFingerprint(manifest);
}

/** 把任意 payload 切成 `shardCount` 个内容分片并计算逐片哈希（确定性）。 */
export function buildArtifactShards(payload: unknown, shardCount: number): ArtifactShardInput[] {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error(`非法的分片数量：${shardCount}`);
  const canonical = canonicalJsonString(payload);
  const total = canonical.length;
  const base = Math.floor(total / shardCount);
  const remainder = total % shardCount;
  const shards: ArtifactShardInput[] = [];
  let offset = 0;
  for (let index = 0; index < shardCount; index += 1) {
    const length = base + (index < remainder ? 1 : 0);
    const segment = canonical.slice(offset, offset + length);
    offset += length;
    shards.push({ shardIndex: index, contentHash: inputFingerprint(segment), byteSize: Buffer.byteLength(segment, 'utf8') });
  }
  return shards;
}

/**
 * 写入不可变产物。幂等：`(traceId, stageId, version)` 已存在且 contentHash 相同即返回既有记录。
 * 清单与分片在同一事务内写入。
 */
export async function commitArtifact(prisma: any, input: CommitArtifactInput): Promise<RunArtifactRecord> {
  assertShardLayout(input.shardCount, input.shards);
  const contentHash = computeArtifactContentHash(input.shards);
  const where = { traceId: input.traceId, stageId: input.stageId, version: input.version };
  const existing = await prisma.runArtifact.findFirst({ where });
  if (existing) {
    if (String(existing.contentHash) === contentHash) return normalizeArtifact(existing);
    throw new Error(`不可变产物冲突：trace=${input.traceId} stage=${input.stageId} version=${input.version} 已存在且 contentHash 不同`);
  }
  return prisma.$transaction(async (tx: any) => {
    // 提交前守卫：过期执行者不得写入，即使它此前收到了成功响应。
    if (input.lease) await assertLeaseHolder(tx, { traceId: input.traceId, owner: input.lease.owner, generation: input.lease.generation, now: input.now });
    const raced = await tx.runArtifact.findFirst({ where });
    if (raced) {
      if (String(raced.contentHash) === contentHash) return normalizeArtifact(raced);
      throw new Error(`不可变产物冲突：trace=${input.traceId} stage=${input.stageId} version=${input.version} 已存在且 contentHash 不同`);
    }
    const created = await tx.runArtifact.create({
      data: {
        traceId: input.traceId,
        stageId: input.stageId,
        version: input.version,
        inputFingerprint: input.inputFingerprint,
        upstreamFingerprints: { ...input.upstreamFingerprints },
        shardCount: input.shardCount,
        contentHash,
        originTraceId: input.originTraceId ?? null,
        originArtifactId: input.originArtifactId ?? null,
      },
    });
    await tx.runArtifactShard.createMany({
      data: input.shards.map(shard => ({
        artifactId: created.id,
        shardIndex: shard.shardIndex,
        contentHash: shard.contentHash,
        byteSize: shard.byteSize ?? null,
      })),
    });
    return normalizeArtifact(created);
  });
}

/** 按 `(traceId, stageId, version)` 精确读取产物清单，不存在返回 null。 */
export async function readArtifact(prisma: any, ref: ArtifactRefQuery): Promise<RunArtifactRecord | null> {
  const row = await prisma.runArtifact.findFirst({ where: { traceId: ref.traceId, stageId: ref.stageId, version: ref.version } });
  return row ? normalizeArtifact(row) : null;
}

/** 读取某阶段在该 trace 下版本号最大的产物清单。 */
export async function readLatestArtifact(prisma: any, traceId: string, stageId: StageId | string): Promise<RunArtifactRecord | null> {
  const row = await prisma.runArtifact.findFirst({ where: { traceId, stageId }, orderBy: { version: 'desc' } });
  return row ? normalizeArtifact(row) : null;
}

/** 完整性判定（布尔）：分片数 == shardCount 且索引恰好覆盖 0..shardCount-1。 */
export async function isArtifactComplete(prisma: any, artifactId: string): Promise<boolean> {
  const artifact = await prisma.runArtifact.findFirst({ where: { id: artifactId } });
  if (!artifact) return false;
  const shards: ArtifactShardLike[] = await prisma.runArtifactShard.findMany({ where: { artifactId } });
  return evaluateArtifactCompleteness(artifact, shards).complete;
}

/** 缺分片即抛错；错误信息携带缺失原因。 */
export async function assertArtifactComplete(prisma: any, artifactId: string): Promise<void> {
  const artifact = await prisma.runArtifact.findFirst({ where: { id: artifactId } });
  if (!artifact) throw new Error(`产物不存在：${artifactId}`);
  const shards: ArtifactShardLike[] = await prisma.runArtifactShard.findMany({ where: { artifactId } });
  const verdict = evaluateArtifactCompleteness(artifact, shards);
  if (!verdict.complete) throw new Error(`产物分片不完整：${artifactId}（${verdict.reason}）`);
}

/**
 * 可复用判定：输入指纹一致、全部上游产物指纹一致，且分片完整。
 * 输入或上游变化一律返回 false（交由执行器重算），不静默复用。
 */
export async function isArtifactValid(prisma: any, query: ArtifactValidityQuery): Promise<boolean> {
  const artifact = await readArtifact(prisma, query);
  if (!artifact) return false;
  if (artifact.inputFingerprint !== query.inputFingerprint) return false;
  if (inputFingerprint(artifact.upstreamFingerprints) !== inputFingerprint(query.upstreamFingerprints)) return false;
  return isArtifactComplete(prisma, artifact.id);
}

/**
 * 失效传播策略：产物失效沿 `dependentsOf()` 反向依赖图传递——某阶段被重算后，
 * 其全部下游都必须失效，直到（含）汇点阶段。本函数返回「变更阶段 + 其全部可达下游」，
 * 按 `resolveStageOrder()` 拓扑序稳定输出；不修改任何历史数据，只提供可调用的判定集合。
 */
export function invalidatedStages(stageId: StageId): ReadonlySet<StageId> {
  const affected = new Set<StageId>([stageId]);
  const queue: StageId[] = [stageId];
  while (queue.length > 0) {
    const current = queue.shift() as StageId;
    for (const dependent of dependentsOf(current)) {
      if (affected.has(dependent)) continue;
      affected.add(dependent);
      queue.push(dependent);
    }
  }
  return affected;
}

/** 仅返回下游（不含自身），按拓扑序稳定输出。 */
export function invalidateDependents(stageId: StageId): readonly StageId[] {
  const affected = new Set<StageId>(invalidatedStages(stageId));
  affected.delete(stageId);
  return resolveStageOrder().filter(id => affected.has(id));
}

/** 判定 `candidate` 是否会因 `changedStage` 变化而失效。 */
export function isStageInvalidated(changedStage: StageId, candidate: StageId): boolean {
  if (changedStage === candidate) return true;
  return invalidatedStages(changedStage).has(candidate);
}

/** 阶段 ID 全集，便于调用方做范围校验。 */
export const ALL_STAGE_IDS: readonly StageId[] = STAGE_IDS;
