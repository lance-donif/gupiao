/**
 * 集中版本常量与业务配置指纹。
 *
 * 运行键 = clusterKey + mode + asOf + recipeVersion + businessConfigHash。
 * 供应商顺序、凭证、并发和超时属于调度配置，不进入业务配置指纹。
 */

import { createHash } from 'node:crypto';

/** 业务配方版本：算法、权重、策略口径或门槛语义变化时必须递增。 */
export const RECIPE_VERSION = 'recipe-v1';

/** 产物 Schema 版本：持久化结构变化时必须递增。 */
export const SCHEMA_VERSION = 'schema-v1';

/**
 * AI 逐条结果协议版本号（数值）。
 * 2 = 旧协议 `{signals, noSignalNewsIds}`；3 = 计划要求的 `{items:[{newsId,status,signals}]}`。
 */
export const CAUSAL_PROTOCOL_VERSION = 2;
export const CAUSAL_PROTOCOL_VERSION_ITEMS = 3;

/** 抽取语义版本：进入抽取缓存键，语义变化会整体失效旧缓存。 */
export const EXTRACTION_SEMANTIC_VERSION = 'extraction-semantic-v1';

/** Prompt 家族版本与输出 schema 版本。 */
export const PROMPT_SCHEMA_VERSION = 'outcome-schema-v1';
export const CAUSAL_PROMPT_FAMILY = 'causal-signal-extraction-v2';
export const RULE_PROMPT_VERSION = 'rule-pattern-v1';

/** 组装线上抽取 Prompt 版本（模型指纹参与，不同模型结果不互相复用）。 */
export function causalPromptVersion(modelFingerprint: string): string {
  return `${CAUSAL_PROMPT_FAMILY}:${PROMPT_SCHEMA_VERSION}:${modelFingerprint}`;
}

export interface IScoringConfig {
  readonly evidenceMax: number;
  readonly graphMax: number;
  readonly exposureMax: number;
  readonly marketMax: number;
  readonly graphRelationMax: number;
  readonly graphWeakMax: number;
}

export interface IRecommendationConfig {
  readonly targetCount: number;
  readonly excludeStarMarket: boolean;
  readonly excludeSt: boolean;
  readonly maxPrice: number;
  readonly maxFiveDayGain: number;
}

export interface IPenaltyConfig {
  readonly factor: number;
  readonly cooldownDays: number;
  readonly threshold: number;
  readonly lookbackDays: number;
}

export interface IBusinessConfig {
  readonly recipeVersion: string;
  readonly scoring: IScoringConfig;
  readonly recommendation: IRecommendationConfig;
  readonly penalty: IPenaltyConfig;
}

/** 与当前代码基线一致的业务配置默认值（改动此处等同于改动配方，须递增 RECIPE_VERSION）。 */
export const DEFAULT_BUSINESS_CONFIG: IBusinessConfig = {
  recipeVersion: RECIPE_VERSION,
  scoring: {
    evidenceMax: 45,
    graphMax: 20,
    exposureMax: 15,
    marketMax: 20,
    graphRelationMax: 12,
    graphWeakMax: 8,
  },
  recommendation: {
    targetCount: 30,
    excludeStarMarket: true,
    excludeSt: true,
    maxPrice: 40,
    maxFiveDayGain: 0.2,
  },
  penalty: { factor: 0.6, cooldownDays: 7, threshold: -0.03, lookbackDays: 30 },
};

/** 稳定序列化：键排序、Date 转 UTC ISO、bigint 转字符串，不依赖属性插入顺序。 */
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

export async function sha256Hex(value: unknown): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

/**
 * 同步版本的 SHA-256 十六进制摘要。
 * `createTraceId` 等同步构造运行身份的路径必须使用它——不能为了一个哈希把整条链路改成异步。
 */
export function sha256HexSync(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

/** 业务配置指纹：只覆盖影响产物的业务参数。 */
export async function businessConfigHash(config: IBusinessConfig = DEFAULT_BUSINESS_CONFIG): Promise<string> {
  return (await sha256Hex(config)).slice(0, 16);
}

/** 默认业务配置的同步指纹，供同步路径复用。 */
export function businessConfigHashSync(config: IBusinessConfig = DEFAULT_BUSINESS_CONFIG): string {
  return sha256HexSync(config).slice(0, 16);
}

/** 当前默认业务配置指纹常量；修改 `DEFAULT_BUSINESS_CONFIG` 会同时改变它。 */
export const DEFAULT_BUSINESS_CONFIG_HASH = businessConfigHashSync();

export type ScoringRecipe = 'baseline-v1' | 'event-v2';

/**
 * 解析评分配方版本：读 `SCORING_RECIPE`，未设置默认 `baseline-v1`，
 * 非法值抛错（不静默回退）。`env` 可注入，默认取 `process.env`。
 */
export function resolveScoringRecipe(env: Record<string, string | undefined> = process.env): ScoringRecipe {
  const raw = env.SCORING_RECIPE;
  if (raw === undefined) return 'baseline-v1';
  if (raw === 'baseline-v1' || raw === 'event-v2') return raw;
  throw new Error(`Invalid SCORING_RECIPE: ${raw}`);
}

export type StageExecutor = 'legacy' | 'registry';

/**
 * 解析阶段执行器：读 `PIPELINE_STAGE_EXECUTOR`，未设置默认 `legacy`，
 * 非法值抛错（不静默回退）。`env` 可注入，默认取 `process.env`。
 */
export function resolveStageExecutor(env: Record<string, string | undefined> = process.env): StageExecutor {
  const raw = env.PIPELINE_STAGE_EXECUTOR;
  if (raw === undefined) return 'legacy';
  if (raw === 'legacy' || raw === 'registry') return raw;
  throw new Error(`Invalid PIPELINE_STAGE_EXECUTOR: ${raw}`);
}
