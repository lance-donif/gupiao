import { extractJsonObject } from '../lib/openai-utils.js';
import { readOpenAiStream } from '../lib/openai-stream.js';
import { aiConfigFingerprint, isAiRecord, loadAiProviderConfig, validateAiConfig, type IAiProviderConfig } from './ai-provider-config.js';
import { AiAdaptiveScheduler } from './ai-adaptive-scheduler.js';
import { aiStoreFromDatabase } from './ai-scheduler-store.js';
import { performAiRequest } from './ai-transport.js';
import { aiRequestContext } from './ai-request-context.js';

export interface IAiSource {
  readonly providerId: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly performance?: {inputTokens:number;outputTokens:number;latencyMs:number;tokenSource?:'usage'|'byte_bound'};
}

export interface IAiArrayMetadata {
  /**
   * Inputs for which the model returned an explicit outcome.  It is required
   * by causal extraction so an empty result cannot be confused with a dropped
   * input while caching or resuming a batch.
   */
  readonly completedNewsIds?: readonly string[];
}

export type AiSourcedArray<T> = readonly T[] & {
  readonly aiSource?: IAiSource;
  readonly completedNewsIds?: readonly string[];
};

export function withAiSource<T>(
  items: readonly T[],
  source: IAiSource,
  metadata: IAiArrayMetadata = {},
): AiSourcedArray<T> {
  // Preserve the array contract; metadata also exists for a successful empty result.
  return Object.defineProperties(items, {
    aiSource: { value: source, enumerable: false },
    ...(metadata.completedNewsIds
      ? { completedNewsIds: { value: [...metadata.completedNewsIds], enumerable: false } }
      : {}),
  }) as AiSourcedArray<T>;
}

export class AiInputError extends Error {}
export class AiRequestTooLargeError extends AiInputError {}
export class AiCandidatesExhaustedError extends Error {
  public constructor(public readonly attempts: readonly { providerId: string; model: string; error: string }[]) {
    super(`All AI candidates failed: ${attempts.map(item => `${item.providerId}/${item.model}: ${item.error}`).join('; ')}`);
    this.name = 'AiCandidatesExhaustedError';
  }
}

class AiAttemptError extends Error {}

export interface IAiSingleModelOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
  readonly client?: AiChatClient;
}

export class AiChatClient {
  public readonly fingerprint: string;
  public readonly modelVersions: readonly string[];
  private readonly config: IAiProviderConfig;

  public constructor(config: IAiProviderConfig, private readonly fetchImpl: typeof fetch = fetch, private readonly singleModelVersion = false, private readonly scheduler?: AiAdaptiveScheduler) {
    // Take a private snapshot so callers cannot change credentials/ordering during concurrent calls.
    this.config = validateAiConfig(JSON.parse(JSON.stringify(config)));
    this.fingerprint = aiConfigFingerprint(this.config);
    this.modelVersions = this.config.providers.flatMap(provider => provider.models.map(model => this.source(provider.id, model.id).modelVersion));
  }

  public static fromOptions(options: IAiSingleModelOptions): AiChatClient {
    return options.client ?? new AiChatClient({ providers: [{ id: 'explicit', baseUrl: options.baseUrl, apiKey: options.apiKey, models: [{ id: options.model }] }] }, options.fetchImpl, true);
  }

  private source(providerId: string, model: string): IAiSource {
    return { providerId, model, modelVersion: this.singleModelVersion ? model : JSON.stringify([providerId, model]) };
  }

  public async request<T>(input: {
    readonly label: string;
    readonly messages: readonly { readonly role: 'system' | 'user'; readonly content: string }[];
    readonly temperature: number;
    readonly timeoutMs: number;
    readonly maxRequestChars?: number;
    readonly signal?: AbortSignal;
    readonly validate: (value: unknown) => T;
  }): Promise<{ readonly value: T; readonly source: IAiSource }> {
    const maxChars = Math.min(240000, input.maxRequestChars ?? 240000);
    if (!Number.isFinite(maxChars) || maxChars <= 0 || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 2147483647) throw new AiInputError('Invalid AI request limits');
    input.signal?.throwIfAborted();
    const promptChars = input.messages.reduce((sum, message) => sum + message.content.length, 0);
    // Preflight the entire chain before making any request, including longer model IDs and parameters.
    const candidates = this.config.providers.flatMap(provider => provider.models.map(model => {
      const parameters = model.parameters ?? {};
      const body: Record<string, unknown> = {
        temperature: parameters.reasoning_effort ? undefined : input.temperature,
        response_format: { type: 'json_object' },
        ...parameters,
        model: model.id,
        messages: input.messages,
      };
      if (body.temperature === null) delete body.temperature;
      if (body.response_format === null) delete body.response_format;
      const budget=aiRequestContext.getStore()?.outputTokenBudget;
      if(budget) {
        const key=body.max_completion_tokens!==undefined?'max_completion_tokens':'max_tokens';
        body[key]=Math.min(budget,Number(body[key] ?? budget));
      }
      const serialized = JSON.stringify(body);
      if (promptChars > maxChars || serialized.length > maxChars) throw new AiRequestTooLargeError(`${input.label} request too large: promptChars=${promptChars}, bodyChars=${serialized.length}, maxRequestChars=${maxChars}`);
      return { provider, model, serialized };
    }));
    const attempts: { providerId: string; model: string; error: string }[] = [];
    if(this.scheduler) {
      const result=await this.scheduler.execute(candidates,(candidate,metrics,signal)=>performAiRequest(candidate,this.fetchImpl,input.validate,metrics,signal),input.signal);
      return {value:result.value,source:{...this.source(result.candidate.provider.id,result.candidate.model.id),performance:result.metrics.performance}};
    }
    for (const { provider, model, serialized } of candidates) {
      input.signal?.throwIfAborted();
      const controller = new AbortController();
      const timeoutMs = model.timeoutMs ?? input.timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let response: Response | undefined;
      let cancel: (() => void) | undefined;
      try {
        const deadline = new Promise<never>((_resolve, reject) => {
          cancel = () => { controller.abort(); reject(input.signal?.reason ?? new AiInputError('AI request cancelled')); };
          input.signal?.addEventListener('abort', cancel, { once: true });
          timer = setTimeout(() => { controller.abort(); reject(new AiAttemptError('request timed out')); }, timeoutMs);
        });
        const perform = async (): Promise<T> => {
          response = await this.fetchImpl(`${provider.baseUrl.replace(/\/+$/u, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
            body: serialized,
            signal: controller.signal,
          });
          if (controller.signal.aborted) {
            if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
            controller.signal.throwIfAborted();
          }
          if (!response.ok) throw new AiAttemptError(`request failed with HTTP ${response.status}`);
          let content: unknown;
          if (model.parameters?.stream) {
            content = await readOpenAiStream(response, timeoutMs);
          } else {
            const payload: unknown = await response.json();
            const choice = isAiRecord(payload) && Array.isArray(payload.choices) ? payload.choices[0] : undefined;
            if (!isAiRecord(payload) || payload.error || !isAiRecord(choice)) throw new AiAttemptError('invalid completion response');
            if (choice.finish_reason != null && choice.finish_reason !== 'stop') throw new AiAttemptError('incomplete completion response');
            content = isAiRecord(choice.message) ? choice.message.content : undefined;
          }
          if (typeof content !== 'string' || !content.trim()) throw new AiAttemptError('response missing content');
          let value: T;
          try { value = input.validate(JSON.parse(extractJsonObject(content))); } catch {
            throw new AiAttemptError('invalid JSON or output structure');
          }
          return value;
        };
        const value = await Promise.race([perform(), deadline]);
        input.signal?.throwIfAborted();
        return { value, source: this.source(provider.id, model.id) };
      } catch (error) {
        input.signal?.throwIfAborted();
        if (error instanceof AiInputError) throw error;
        // Never include raw responses, URLs, fetch error messages, prompts or API keys in diagnostics.
        attempts.push({ providerId: provider.id, model: model.id, error: `${input.label} ${error instanceof AiAttemptError ? error.message : 'network or response read failed'}` });
      } finally {
        clearTimeout(timer);
        if (cancel) input.signal?.removeEventListener('abort', cancel);
        controller.abort();
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
      }
    }
    const redact = (value: string): string => this.config.providers.reduce((text, provider) => text.replaceAll(provider.apiKey, '[redacted]'), value);
    throw new AiCandidatesExhaustedError(attempts.map(item => ({ providerId: redact(item.providerId), model: redact(item.model), error: redact(item.error) })));
  }
}

export function createAiOptionsFromEnv(environment: NodeJS.ProcessEnv = process.env): IAiSingleModelOptions {
  const config = loadAiProviderConfig(environment);
  const provider = config.providers[0]!;
  const scheduler=environment.DATABASE_URL ? new AiAdaptiveScheduler(config,aiStoreFromDatabase(environment.DATABASE_URL)) : undefined;
  return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.models[0]!.id, client: new AiChatClient(config,fetch,false,scheduler) };
}
