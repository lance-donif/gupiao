/**
 * 产物完整性判据（纯函数，无副作用/无依赖）。
 *
 * 判据**不是**「分片记录数大于零」，而是：
 *  1. 分片记录数严格等于清单声明的 `shardCount`；
 *  2. 分片索引恰好覆盖 `0 .. shardCount-1`，且不重复、不越界；
 *  3. 每条分片都带有内容哈希。
 * 缺任意一片即判定为不完整；`assertArtifactComplete` 据此抛错。
 */

export interface ArtifactManifestLike {
  readonly shardCount: number;
}

export interface ArtifactShardLike {
  readonly shardIndex: number;
  readonly contentHash?: string | null;
}

export interface ArtifactCompleteness {
  readonly complete: boolean;
  readonly reason?: string;
}

export function evaluateArtifactCompleteness(
  artifact: ArtifactManifestLike | null | undefined,
  shards: readonly ArtifactShardLike[],
): ArtifactCompleteness {
  if (!artifact) return { complete: false, reason: '产物清单不存在' };
  const expected = artifact.shardCount;
  if (!Number.isInteger(expected) || expected < 1) {
    return { complete: false, reason: `非法的分片数量 ${expected}` };
  }
  if (shards.length !== expected) {
    return { complete: false, reason: `分片数量 ${shards.length} != ${expected}` };
  }
  const seen = new Set<number>();
  for (const shard of shards) {
    if (!Number.isInteger(shard.shardIndex) || shard.shardIndex < 0 || shard.shardIndex >= expected) {
      return { complete: false, reason: `分片索引越界 ${shard.shardIndex}` };
    }
    if (seen.has(shard.shardIndex)) {
      return { complete: false, reason: `分片索引重复 ${shard.shardIndex}` };
    }
    if (!shard.contentHash) {
      return { complete: false, reason: `分片 ${shard.shardIndex} 缺少内容哈希` };
    }
    seen.add(shard.shardIndex);
  }
  if (seen.size !== expected) return { complete: false, reason: '分片覆盖不完整' };
  return { complete: true };
}
