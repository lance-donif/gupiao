import crypto from 'node:crypto';

/**
 * 稳定序列化：键排序、Date 转 UTC ISO、bigint 转字符串，不依赖属性插入顺序。
 *
 * 这是本仓哈希的唯一实现。此前stableHash 直接 `JSON.stringify(value)`，
 * 对键顺序敏感 —— 同一份逻辑数据只要字段顺序不同就会产生不同指纹，
 * 用于缓存键/运行指纹时是潜在 bug。
 */
export function canonicalize(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.toJSON === 'function') return canonicalize((record as { toJSON(): unknown }).toJSON());
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonicalize(record[key])]));
  }
  return value;
}

/** 键序无关的 SHA-256 十六进制摘要，用于缓存键与指纹。 */
export const stableHash = (value: unknown): string => {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
};

/** 任意文本/缓冲的 SHA-256 十六进制摘要。 */
export const sha256Text = (text: string): string => {
  return crypto.createHash('sha256').update(text).digest('hex');
};

/**
 * 对字面量对象做摘要，**保持属性插入顺序**。
 *
 * 与 stableHash 的区别：不做键排序。仅适用于 key 顺序由源码字面量固定、
 * 需要与既有缓存键/manifest 版本保持一致的场景（改动会让历史键全部失效）。
 */
export const sha256Json = (value: unknown): string => {
  return sha256Text(JSON.stringify(value));
};