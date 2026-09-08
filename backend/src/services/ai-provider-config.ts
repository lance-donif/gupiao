import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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

// Never mix credentials from different environment variable families. One file is the source of truth.
const loadedConfigs = new Map<string, IAiProviderConfig>();
export function loadAiProviderConfig(environment: NodeJS.ProcessEnv = process.env): IAiProviderConfig {
  const filePath = path.resolve(environment.AI_CONFIG_FILE ?? 'tmp/ai-config.json');
  const existing = loadedConfigs.get(filePath);
  if (existing) return existing;
  let raw: string;
  try { raw = readFileSync(filePath, 'utf8'); } catch {
    throw new Error('Cannot read AI_CONFIG_FILE (default: tmp/ai-config.json). Configure providers before running AI.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('AI_CONFIG_FILE must contain valid JSON'); }
  const config = validateAiConfig(parsed);
  loadedConfigs.set(filePath, config);
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
