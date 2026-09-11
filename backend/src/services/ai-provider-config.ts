import { createHash } from 'node:crypto';

export interface IAiModelParameters {
  readonly stream?: boolean;
  readonly response_format?: { readonly type: 'json_object' | 'text' } | null;
  readonly reasoning_effort?: string;
  readonly temperature?: number | null;
  readonly max_tokens?: number;
  readonly max_completion_tokens?: number;
}

export interface IAiProvider {
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly quotaGroup?: string;
  readonly limits?: IAiLimits;
  readonly models: readonly {
    readonly id: string;
    readonly timeoutMs?: number;
    readonly parameters?: IAiModelParameters;
    readonly limits?: IAiLimits;
    readonly timeouts?: { readonly firstResponseMs?: number; readonly idleMs?: number; readonly totalMs?: number };
  }[];
}

export interface IAiProviderConfig {
  readonly providers: readonly IAiProvider[];
  readonly scheduling?: { readonly globalConcurrency?: number; readonly runTimeoutMs?: number; readonly maxAttempts?: number; readonly initialBatchSize?: number; readonly maxBatchSize?: number };
  readonly quotaGroups?: Readonly<Record<string, IAiLimits>>;
  readonly batching?: IAiBatchingConfig;
}

export interface IAiBatchingConfig {
  readonly targetInputTokens?: number;
  readonly maxInputTokens?: number;
  readonly outputTokens?: number;
  readonly estimatedOutputTokensPerNews?: number;
  readonly targetLatencyMs?: number;
  readonly maxNews?: number;
}

export interface IAiLimits {
  readonly initialConcurrency?: number;
  readonly maxConcurrency?: number;
  readonly rpm?: number;
  readonly tpm?: number;
  readonly dailyRequests?: number;
  readonly dailyTokens?: number;
  readonly minSpacingMs?: number;
  /** Combined input + reserved output tokens, not an independent output-token cap. */
  readonly contextTokens?: number;
}

function validateLimits(value: unknown): void {
  if (value === undefined) return;
  if (!isAiRecord(value)) throw new Error('AI limits must be an object');
  const allowed = ['initialConcurrency','maxConcurrency','rpm','tpm','dailyRequests','dailyTokens','minSpacingMs','contextTokens'];
  for (const [key, number] of Object.entries(value)) {
    if (!allowed.includes(key) || !positiveInteger(number)) throw new Error('Invalid AI limit');
  }
  if (Number(value.initialConcurrency ?? 1) > Number(value.maxConcurrency ?? 5)) throw new Error('Initial AI concurrency exceeds maximum');
}

export const isAiRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const positiveInteger = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function validateAiConfig(value: unknown): IAiProviderConfig {
  if (!isAiRecord(value) || !Array.isArray(value.providers) || value.providers.length === 0) {
    throw new Error('AI config requires a non-empty providers array');
  }
  const ids = new Set<string>();
  if(value.batching!==undefined) {
    if(!isAiRecord(value.batching) || Object.entries(value.batching).some(([key,n])=>!['targetInputTokens','maxInputTokens','outputTokens','estimatedOutputTokensPerNews','targetLatencyMs','maxNews'].includes(key) || !positiveInteger(n))) throw new Error('Invalid AI batching configuration');
    if(Number(value.batching.targetInputTokens ?? 16000)>Number(value.batching.maxInputTokens ?? 64000))throw new Error('AI batch target exceeds maximum input tokens');
  }
  if (value.scheduling !== undefined) {
    if (!isAiRecord(value.scheduling)) throw new Error('Invalid AI scheduling');
    for (const [key, number] of Object.entries(value.scheduling)) {
      if (!['globalConcurrency','runTimeoutMs','maxAttempts','initialBatchSize','maxBatchSize'].includes(key) || !positiveInteger(number)) throw new Error('Invalid AI scheduling limit');
    }
    if (Number(value.scheduling.runTimeoutMs ?? 3600000) > 3600000) throw new Error('AI run timeout exceeds one hour');
    if (Number(value.scheduling.initialBatchSize ?? 3) > Number(value.scheduling.maxBatchSize ?? 5)) throw new Error('Invalid AI batch sizes');
  }
  if (value.quotaGroups !== undefined) {
    if (!isAiRecord(value.quotaGroups)) throw new Error('Invalid AI quota groups');
    Object.values(value.quotaGroups).forEach(validateLimits);
  }
  for (const [index, provider] of value.providers.entries()) {
    const label = `AI providers[${index}]`;
    if (!isAiRecord(provider) || !nonEmpty(provider.id) || !nonEmpty(provider.baseUrl) || !nonEmpty(provider.apiKey)) {
      throw new Error(`${label} requires id, baseUrl and apiKey`);
    }
    if (ids.has(provider.id)) throw new Error(`${label} has a duplicate id`);
    ids.add(provider.id);
    validateLimits(provider.limits);
    if (provider.quotaGroup !== undefined && (!nonEmpty(provider.quotaGroup) || !isAiRecord(value.quotaGroups) || !(provider.quotaGroup in value.quotaGroups))) throw new Error(`${label} references an unknown quota group`);
    let url: URL;
    try { url = new URL(provider.baseUrl); } catch { throw new Error(`${label} has an invalid baseUrl`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error(`${label} baseUrl must be an HTTP(S) API prefix without credentials, query or fragment`);
    }
    if (!Array.isArray(provider.models) || provider.models.length === 0) throw new Error(`${label} requires models`);
    const modelIds = new Set<string>();
    for (const model of provider.models) {
      if (!isAiRecord(model) || !nonEmpty(model.id)) throw new Error(`${label} contains a model without id`);
      if (modelIds.has(model.id)) throw new Error(`${label} contains a duplicate model`);
      modelIds.add(model.id);
      validateLimits(model.limits);
      if (model.timeouts !== undefined) {
        if (!isAiRecord(model.timeouts) || Object.entries(model.timeouts).some(([key, ms]) => !['firstResponseMs','idleMs','totalMs'].includes(key) || !positiveInteger(ms) || Number(ms)>2147483647)) throw new Error(`${label} invalid model timeouts`);
      }
      if (model.timeoutMs !== undefined && (!positiveInteger(model.timeoutMs) || Number(model.timeoutMs) > 2147483647)) throw new Error(`${label} model timeoutMs must be an integer from 1 to 2147483647`);
      const parameters = model.parameters;
      if (parameters === undefined) continue;
      if (!isAiRecord(parameters)) throw new Error(`${label} model parameters must be an object`);
      const allowed = new Set(['stream', 'response_format', 'reasoning_effort', 'temperature', 'max_tokens', 'max_completion_tokens']);
      if (Object.keys(parameters).some(key => !allowed.has(key))) throw new Error(`${label} model contains unsupported parameters`);
      if (parameters.stream !== undefined && typeof parameters.stream !== 'boolean') throw new Error(`${label} stream must be boolean`);
      const format = parameters.response_format;
      if (format !== undefined && format !== null && (!isAiRecord(format) || !['json_object', 'text'].includes(String(format.type)))) {
        throw new Error(`${label} response_format must be json_object, text or null`);
      }
      if (parameters.reasoning_effort !== undefined && !nonEmpty(parameters.reasoning_effort)) throw new Error(`${label} reasoning_effort must be a string`);
      if (parameters.temperature !== undefined && parameters.temperature !== null && (typeof parameters.temperature !== 'number' || !Number.isFinite(parameters.temperature))) {
        throw new Error(`${label} temperature must be a finite number or null`);
      }
      for (const key of ['max_tokens', 'max_completion_tokens']) {
        if (parameters[key] !== undefined && !positiveInteger(parameters[key])) throw new Error(`${label} token limit must be a positive integer`);
      }
      if (parameters.max_tokens !== undefined && parameters.max_completion_tokens !== undefined) throw new Error(`${label} specifies two token limits`);
    }
  }
  return value as unknown as IAiProviderConfig;
}

// AI 配置唯一来源：根目录 .env（模板与说明见 .env.example）。
// 子目录不再存放任何配置文件；缺配直接抛错，不降级（见 AGENTS.md Core Rules）。
const loadedConfigs = new Map<string, IAiProviderConfig>();

/** 提供商/分组 id 规范化为环境变量键段：大写，非字母数字统一转下划线。 */
const normalizeEnvKey = (id: string): string => id.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');

const readEnvText = (environment: NodeJS.ProcessEnv, key: string): string | undefined => {
  const raw = environment[key];
  if (raw === undefined) return undefined;
  const text = String(raw).trim();
  return text.length > 0 ? text : undefined;
};

const readEnvInt = (environment: NodeJS.ProcessEnv, key: string, max = Number.MAX_SAFE_INTEGER): number | undefined => {
  const text = readEnvText(environment, key);
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`AI 配置 ${key} 必须是 1~${max} 的整数`);
  }
  return value;
};

const readEnvBool = (environment: NodeJS.ProcessEnv, key: string): boolean | undefined => {
  const text = readEnvText(environment, key);
  if (text === undefined) return undefined;
  if (/^(true|1)$/iu.test(text)) return true;
  if (/^(false|0)$/iu.test(text)) return false;
  throw new Error(`AI 配置 ${key} 必须是 true/false`);
};

const readEnvList = (environment: NodeJS.ProcessEnv, key: string): string[] => {
  const text = readEnvText(environment, key);
  if (text === undefined) return [];
  return text.split(',').map(item => item.trim()).filter(item => item.length > 0);
};

const LIMIT_SUFFIXES = [
  ['INITIAL_CONCURRENCY', 'initialConcurrency'],
  ['MAX_CONCURRENCY', 'maxConcurrency'],
  ['RPM', 'rpm'],
  ['TPM', 'tpm'],
  ['DAILY_REQUESTS', 'dailyRequests'],
  ['DAILY_TOKENS', 'dailyTokens'],
  ['MIN_SPACING_MS', 'minSpacingMs'],
  ['CONTEXT_TOKENS', 'contextTokens'],
] as const;

const readEnvLimits = (environment: NodeJS.ProcessEnv, prefix: string): IAiLimits | undefined => {
  const limits: Record<string, number> = {};
  for (const [suffix, field] of LIMIT_SUFFIXES) {
    const value = readEnvInt(environment, `${prefix}_${suffix}`);
    if (value !== undefined) limits[field] = value;
  }
  return Object.keys(limits).length > 0 ? (limits as IAiLimits) : undefined;
};

const SCHEDULING_FIELDS = [
  ['AI_SCHEDULING_GLOBAL_CONCURRENCY', 'globalConcurrency'],
  ['AI_SCHEDULING_RUN_TIMEOUT_MS', 'runTimeoutMs'],
  ['AI_SCHEDULING_MAX_ATTEMPTS', 'maxAttempts'],
  ['AI_SCHEDULING_INITIAL_BATCH_SIZE', 'initialBatchSize'],
  ['AI_SCHEDULING_MAX_BATCH_SIZE', 'maxBatchSize'],
] as const;

const BATCHING_FIELDS = [
  ['AI_BATCHING_TARGET_INPUT_TOKENS', 'targetInputTokens'],
  ['AI_BATCHING_MAX_INPUT_TOKENS', 'maxInputTokens'],
  ['AI_BATCHING_OUTPUT_TOKENS', 'outputTokens'],
  ['AI_BATCHING_ESTIMATED_OUTPUT_TOKENS_PER_NEWS', 'estimatedOutputTokensPerNews'],
  ['AI_BATCHING_TARGET_LATENCY_MS', 'targetLatencyMs'],
  ['AI_BATCHING_MAX_NEWS', 'maxNews'],
] as const;

const readEnvSection = (
  environment: NodeJS.ProcessEnv,
  fields: readonly (readonly [string, string])[],
): Record<string, number> | undefined => {
  const section: Record<string, number> = {};
  for (const [key, field] of fields) {
    const value = readEnvInt(environment, key);
    if (value !== undefined) section[field] = value;
  }
  return Object.keys(section).length > 0 ? section : undefined;
};

type AiModelConfig = IAiProvider['models'][number];

const buildEnvModel = (environment: NodeJS.ProcessEnv, providerKey: string, modelId: string, index: number): AiModelConfig => {
  const prefix = `AI_PROVIDER_${providerKey}_MODEL_${index + 1}`;
  const firstResponseMs = readEnvInt(environment, `${prefix}_FIRST_RESPONSE_MS`, 2147483647);
  const idleMs = readEnvInt(environment, `${prefix}_IDLE_MS`, 2147483647);
  const totalMs = readEnvInt(environment, `${prefix}_TOTAL_MS`, 2147483647);
  const timeouts = firstResponseMs === undefined && idleMs === undefined && totalMs === undefined
    ? undefined
    : {
      ...(firstResponseMs !== undefined ? { firstResponseMs } : {}),
      ...(idleMs !== undefined ? { idleMs } : {}),
      ...(totalMs !== undefined ? { totalMs } : {}),
    };
  const stream = readEnvBool(environment, `${prefix}_STREAM`);
  const formatText = readEnvText(environment, `${prefix}_RESPONSE_FORMAT`);
  const reasoningEffort = readEnvText(environment, `${prefix}_REASONING_EFFORT`);
  const temperatureText = readEnvText(environment, `${prefix}_TEMPERATURE`);
  let temperature: number | null | undefined;
  if (temperatureText !== undefined) {
    temperature = temperatureText.toLowerCase() === 'null' ? null : Number(temperatureText);
    if (temperature !== null && (typeof temperature !== 'number' || !Number.isFinite(temperature))) {
      throw new Error(`AI 配置 ${prefix}_TEMPERATURE 必须是数字或 null`);
    }
  }
  const maxTokens = readEnvInt(environment, `${prefix}_MAX_TOKENS`);
  const maxCompletionTokens = readEnvInt(environment, `${prefix}_MAX_COMPLETION_TOKENS`);
  const parameters = stream === undefined && formatText === undefined && reasoningEffort === undefined
    && temperature === undefined && maxTokens === undefined && maxCompletionTokens === undefined
    ? undefined
    : {
      ...(stream !== undefined ? { stream } : {}),
      ...(formatText !== undefined ? { response_format: formatText.toLowerCase() === 'null' ? null : { type: formatText } } : {}),
      ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      ...(maxCompletionTokens !== undefined ? { max_completion_tokens: maxCompletionTokens } : {}),
    };
  const timeoutMs = readEnvInt(environment, `${prefix}_TIMEOUT_MS`, 2147483647);
  const modelLimits = readEnvLimits(environment, prefix);
  return {
    id: modelId,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(parameters !== undefined ? { parameters: parameters as AiModelConfig['parameters'] } : {}),
    ...(modelLimits !== undefined ? { limits: modelLimits } : {}),
    ...(timeouts !== undefined ? { timeouts } : {}),
  };
};

export function loadAiProviderConfig(environment: NodeJS.ProcessEnv = process.env): IAiProviderConfig {
  const cacheKey = JSON.stringify(
    Object.keys(environment).filter(key => key.startsWith('AI_')).sort().map(key => [key, environment[key]]),
  );
  const existing = loadedConfigs.get(cacheKey);
  if (existing) return existing;
  const providerIds = readEnvList(environment, 'AI_PROVIDER_IDS');
  if (providerIds.length === 0) {
    throw new Error('AI 未配置：请在根目录 .env 设置 AI_PROVIDER_IDS（逗号分隔，顺序即优先级），完整说明见 .env.example');
  }
  const seenKeys = new Set<string>();
  const providers: IAiProvider[] = providerIds.map(rawId => {
    const providerKey = normalizeEnvKey(rawId);
    if (providerKey.length === 0 || seenKeys.has(providerKey)) {
      throw new Error(`AI 提供商 id 非法或规范化后重名：${rawId}`);
    }
    seenKeys.add(providerKey);
    const baseUrl = readEnvText(environment, `AI_PROVIDER_${providerKey}_BASE_URL`);
    if (!baseUrl) throw new Error(`AI 提供商 ${rawId} 缺少 AI_PROVIDER_${providerKey}_BASE_URL`);
    const apiKey = readEnvText(environment, `AI_PROVIDER_${providerKey}_API_KEY`);
    if (!apiKey) throw new Error(`AI 提供商 ${rawId} 缺少 AI_PROVIDER_${providerKey}_API_KEY`);
    const modelIds = readEnvList(environment, `AI_PROVIDER_${providerKey}_MODELS`);
    if (modelIds.length === 0) throw new Error(`AI 提供商 ${rawId} 缺少 AI_PROVIDER_${providerKey}_MODELS（逗号分隔的模型 id）`);
    const quotaGroup = readEnvText(environment, `AI_PROVIDER_${providerKey}_QUOTA_GROUP`);
    const providerLimits = readEnvLimits(environment, `AI_PROVIDER_${providerKey}`);
    return {
      id: rawId,
      baseUrl,
      apiKey,
      ...(quotaGroup !== undefined ? { quotaGroup } : {}),
      ...(providerLimits !== undefined ? { limits: providerLimits } : {}),
      models: modelIds.map((modelId, index) => buildEnvModel(environment, providerKey, modelId, index)),
    };
  });
  const quotaGroupIds = readEnvList(environment, 'AI_QUOTA_GROUPS');
  const quotaGroups = quotaGroupIds.length === 0
    ? undefined
    : Object.fromEntries(quotaGroupIds.map(rawId => {
      const groupKey = normalizeEnvKey(rawId);
      return [rawId, readEnvLimits(environment, `AI_QUOTA_GROUP_${groupKey}`) ?? {}];
    }));
  const scheduling = readEnvSection(environment, SCHEDULING_FIELDS);
  const batching = readEnvSection(environment, BATCHING_FIELDS);
  const config = validateAiConfig({
    providers,
    ...(scheduling !== undefined ? { scheduling } : {}),
    ...(quotaGroups !== undefined ? { quotaGroups } : {}),
    ...(batching !== undefined ? { batching } : {}),
  });
  loadedConfigs.set(cacheKey, config);
  return config;
}

export function aiConfigFingerprint(config: IAiProviderConfig): string {
  // Scheduling and credentials do not change extraction semantics. Sort routes
  // so operational reordering retains completed work.
  const publicConfig = config.providers.map(provider => ({
    id: provider.id,
    baseUrl: provider.baseUrl.replace(/\/+$/u, ''),
    models: provider.models.map(model => ({ id: model.id, parameters: model.parameters ?? {} }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  })).sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify(publicConfig)).digest('hex').slice(0, 24);
}
