/**
 * 抽取缓存（原文 + 结果 + 并发领取租约）。
 *
 * 缓存键 = (cacheKey, contentVersion)：
 *   - `cacheKey` 只覆盖抽取语义版本 + prompt/schema 版本 + 协议版本 + 有效输入哈希；
 *     **不含** newsId / traceId / 批次划分，调度配置（并发、超时、供应商顺序、凭证）一律不进入。
 *   - `contentVersion` = 有效输入哈希（`createCausalSignalInputFingerprint`），
 *     配合唯一键 `(cacheKey, contentVersion)`，不同 contentVersion 不覆盖已有记录。
 *
 * 领取租约使用**单条原子 SQL**（`INSERT ... ON CONFLICT ... WHERE`）完成，无需外层事务：
 * 只有「不存在 / 已提交可跳过 / 租约已过期」时才可能拿到 owner，天然排他。
 */

import { createHash, randomUUID } from 'node:crypto';
import { EXTRACTION_SEMANTIC_VERSION, PROMPT_SCHEMA_VERSION } from '../version.js';

export const CONTENT_CACHE_STATUS_CLAIMED = 'CLAIMED';
export const CONTENT_CACHE_STATUS_SUCCESS = 'success';
export const CONTENT_CACHE_STATUS_NO_SIGNAL = 'no_signal';
const COMMITTED_STATUSES = [CONTENT_CACHE_STATUS_SUCCESS, CONTENT_CACHE_STATUS_NO_SIGNAL] as const;

/** 输入哈希必须由调用方用 `createCausalSignalInputFingerprint` 计算后传入。 */
export interface CausalCacheKeyInput {
  readonly inputFingerprint: string;
  readonly promptVersion: string;
  readonly protocolVersion: number;
  readonly extractionSemanticVersion?: string;
  readonly schemaVersion?: string;
}

export interface CausalCacheKey {
  readonly cacheKey: string;
  readonly contentVersion: string;
}

export const buildCausalCacheKey = (input: CausalCacheKeyInput): CausalCacheKey => {
  const extractionSemanticVersion = input.extractionSemanticVersion ?? EXTRACTION_SEMANTIC_VERSION;
  const schemaVersion = input.schemaVersion ?? PROMPT_SCHEMA_VERSION;
  const cacheKey = createHash('sha256').update(JSON.stringify({
    extractionSemanticVersion,
    promptVersion: input.promptVersion,
    schemaVersion,
    protocolVersion: input.protocolVersion,
    inputFingerprint: input.inputFingerprint,
  })).digest('hex');
  return { cacheKey, contentVersion: input.inputFingerprint };
};

export interface ClaimCacheEntryInput extends CausalCacheKey {
  readonly extractionSemanticVersion?: string;
  readonly promptVersion: string;
  readonly schemaVersion?: string;
  readonly rawText: string;
}

export type CacheClaimResult =
  | { readonly kind: 'claimed'; readonly id: string }
  | { readonly kind: 'committed'; readonly id: string; readonly status: string; readonly resultJson: unknown; readonly sourceModel: string | null }
  | { readonly kind: 'busy'; readonly id: string; readonly leaseOwner: string | null; readonly leaseUntil: Date | null };

interface CacheRow {
  readonly id: string;
  readonly status: string;
  readonly resultJson: unknown;
  readonly sourceModel: string | null;
  readonly leaseOwner: string | null;
  readonly leaseUntil: Date | null;
}

const asRow = (row: Record<string, unknown>): CacheRow => ({
  id: String(row.id),
  status: String(row.status),
  resultJson: row.resultJson ?? null,
  sourceModel: row.sourceModel == null ? null : String(row.sourceModel),
  leaseOwner: row.leaseOwner == null ? null : String(row.leaseOwner),
  leaseUntil: row.leaseUntil == null ? null : new Date(row.leaseUntil as string | number | Date),
});

/**
 * 原子领取缓存租约。返回 `claimed` 表示本次真正执行；`committed` 表示已有结果可直接复用；
 * `busy` 表示他人持有未过期租约，调用方应等待其提交（绝不重复付费）。
 */
export async function claimCacheEntry(
  prisma: any,
  input: ClaimCacheEntryInput,
  owner: string,
  ttlMs: number,
): Promise<CacheClaimResult> {
  const inserted = await prisma.$queryRawUnsafe(
    'INSERT INTO "ContentCacheEntry"("id","cacheKey","contentVersion","extractionSemanticVersion","promptVersion","schemaVersion","rawText","status","leaseOwner","leaseUntil") '
    + "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + ($10::int * interval '1 millisecond')) "
    + 'ON CONFLICT ("cacheKey","contentVersion") DO UPDATE '
    + 'SET "leaseOwner"=EXCLUDED."leaseOwner","leaseUntil"=EXCLUDED."leaseUntil",status=$8 '
    + 'WHERE "ContentCacheEntry".status NOT IN (\'success\',\'no_signal\') '
    + 'AND ("ContentCacheEntry"."leaseOwner" IS NULL OR "ContentCacheEntry"."leaseUntil" < now()) '
    + 'RETURNING id,status,"resultJson","sourceModel","leaseUntil"',
    randomUUID(),
    input.cacheKey,
    input.contentVersion,
    input.extractionSemanticVersion ?? EXTRACTION_SEMANTIC_VERSION,
    input.promptVersion,
    input.schemaVersion ?? PROMPT_SCHEMA_VERSION,
    input.rawText,
    CONTENT_CACHE_STATUS_CLAIMED,
    owner,
    ttlMs,
  ) as readonly Record<string, unknown>[];
  if (inserted.length > 0) return { kind: 'claimed', id: String(inserted[0].id) };

  const existing = await prisma.$queryRawUnsafe(
    'SELECT id,status,"resultJson","sourceModel","leaseOwner","leaseUntil" FROM "ContentCacheEntry" WHERE "cacheKey"=$1 AND "contentVersion"=$2',
    input.cacheKey,
    input.contentVersion,
  ) as readonly Record<string, unknown>[];
  if (existing.length === 0) {
    // 唯一键竞争失败但行又不可见：并发的提交事务尚未落定，交给调用方重试。
    throw new Error('content cache entry disappeared during claim');
  }
  const row = asRow(existing[0]);
  if ((COMMITTED_STATUSES as readonly string[]).includes(row.status)) {
    return { kind: 'committed', id: row.id, status: row.status, resultJson: row.resultJson, sourceModel: row.sourceModel };
  }
  return { kind: 'busy', id: row.id, leaseOwner: row.leaseOwner, leaseUntil: row.leaseUntil };
}

export interface CommitCacheEntryInput {
  readonly id: string;
  readonly status: typeof CONTENT_CACHE_STATUS_SUCCESS | typeof CONTENT_CACHE_STATUS_NO_SIGNAL;
  readonly resultJson: unknown;
  readonly evidenceOffsetsJson?: unknown;
  readonly sourceModel?: string | null;
}

/** 提交缓存结果并释放租约；只有持有租约的 owner 能提交（返回 false 表示租约已丢失）。 */
export async function commitCacheEntry(
  prisma: any,
  input: CommitCacheEntryInput,
  owner: string,
): Promise<boolean> {
  const updated = await prisma.$executeRawUnsafe(
    'UPDATE "ContentCacheEntry" SET status=$3,"resultJson"=$4::jsonb,"evidenceOffsetsJson"=$5::jsonb,"sourceModel"=$6,"committedAt"=now(),"leaseOwner"=NULL,"leaseUntil"=NULL WHERE id=$1 AND "leaseOwner"=$2',
    input.id,
    owner,
    input.status,
    JSON.stringify(input.resultJson ?? []),
    input.evidenceOffsetsJson === undefined ? null : JSON.stringify(input.evidenceOffsetsJson),
    input.sourceModel ?? null,
  );
  return updated > 0;
}

/** 失败/拆分时主动释放租约，允许重试；不影响已提交结果。 */
export async function releaseCacheLease(prisma: any, ids: readonly string[], owner: string): Promise<void> {
  if (ids.length === 0) return;
  await prisma.$executeRawUnsafe(
    'UPDATE "ContentCacheEntry" SET "leaseOwner"=NULL,"leaseUntil"=NULL,status=$3 WHERE id=ANY($1::text[]) AND "leaseOwner"=$2',
    [...ids],
    owner,
    CONTENT_CACHE_STATUS_CLAIMED,
  );
}

export interface CommittedCacheRecord {
  readonly id: string;
  readonly cacheKey: string;
  readonly contentVersion: string;
  readonly status: string;
  readonly resultJson: unknown;
  readonly sourceModel: string | null;
}

/** 批量读取已提交的缓存记录（不含被领取中的）。 */
export async function readCommittedCacheEntries(
  prisma: any,
  keys: readonly CausalCacheKey[],
): Promise<readonly CommittedCacheRecord[]> {
  if (keys.length === 0) return [];
  const rows = await prisma.$queryRawUnsafe(
    'SELECT id,"cacheKey","contentVersion",status,"resultJson","sourceModel" FROM "ContentCacheEntry" WHERE "cacheKey"=ANY($1::text[]) AND "contentVersion"=ANY($2::text[]) AND status IN (\'success\',\'no_signal\')',
    keys.map(key => key.cacheKey),
    keys.map(key => key.contentVersion),
  ) as readonly Record<string, unknown>[];
  return rows.map(row => ({
    id: String(row.id),
    cacheKey: String(row.cacheKey),
    contentVersion: String(row.contentVersion),
    status: String(row.status),
    resultJson: row.resultJson ?? null,
    sourceModel: row.sourceModel == null ? null : String(row.sourceModel),
  }));
}

/**
 * 等待他人提交同键结果。超时返回 null（调用方随后可重试领取，绝不静默跳过该新闻）。
 */
export async function waitForCommittedCacheEntry(
  prisma: any,
  key: CausalCacheKey,
  timeoutMs: number,
  pollIntervalMs = 200,
): Promise<CommittedCacheRecord | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const rows = await readCommittedCacheEntries(prisma, [key]);
    const hit = rows.find(row => row.cacheKey === key.cacheKey && row.contentVersion === key.contentVersion);
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
  }
}
