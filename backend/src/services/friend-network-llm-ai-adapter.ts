import type { IFriendNetworkAiAdapter } from './friend-network-ai-adapter.js';
import type {
  IAiRelationshipCandidate,
  IAiRelationshipDecision,
} from './friend-network-types.js';
import { requireEnvironmentValue } from './integration-config.js';
import { fetchWithRetry } from './ai-client-utils.js';
import { extractJsonObject } from '../lib/openai-utils.js';
import { normalizeBaseUrl } from '../lib/url-utils.js';

interface IOpenAiCompatibleMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

interface IOpenAiCompatibleChoice {
  readonly message?: {
    readonly content?: string;
  };
}

interface IOpenAiCompatibleResponse {
  readonly choices?: readonly IOpenAiCompatibleChoice[];
}

interface ILlmAdapterOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
}

interface IRefinedAiDecision extends Partial<IAiRelationshipDecision> {
  readonly shouldKeep?: boolean;
}

interface IRefinedAiDecisionEnvelope {
  readonly decisions?: readonly IRefinedAiDecision[];
}

const buildPrompt = (candidates: readonly IAiRelationshipCandidate[]): string => {
  return [
    '你是股票亲友关系图谱裁决器。',
    '请根据候选关系输出 JSON。',
    '字段必须包含：sourceKeyword,targetKeyword,relationType,direction,confidence,weakSignal,evidence,reasoning,shouldKeep。',
    'relationType 只能是 driver/transmission/derived/synchronous/reverse。',
    'direction 只能是 forward/reverse/bidirectional。',
    'confidence 取 0 到 1。',
    '如果关系只是文本共现、没有明确经济逻辑，请 shouldKeep=false。',
    '优先保留：政策->银行/融资，行业->商品，商品->公司，技术/制造->需求。',
    '返回格式：{"decisions":[...]}。',
    JSON.stringify(candidates, null, 2),
  ].join('\n');
};

const isRelationType = (value: unknown): value is IAiRelationshipDecision['relationType'] => {
  return value === 'driver' || value === 'transmission' || value === 'derived' || value === 'synchronous' || value === 'reverse';
};

const isDirection = (value: unknown): value is IAiRelationshipDecision['direction'] => {
  return value === 'forward' || value === 'reverse' || value === 'bidirectional';
};

const toDecision = (
  candidate: IAiRelationshipCandidate,
  raw: IRefinedAiDecision | undefined,
): IAiRelationshipDecision | null => {
  if (raw?.shouldKeep === false) {
    return null;
  }

  const confidence = typeof raw?.confidence === 'number' && Number.isFinite(raw.confidence)
    ? Math.max(0, Math.min(raw.confidence, 1))
    : 0.7;

  return {
    sourceKeyword: typeof raw?.sourceKeyword === 'string' ? raw.sourceKeyword : candidate.sourceKeyword,
    targetKeyword: typeof raw?.targetKeyword === 'string' ? raw.targetKeyword : candidate.targetKeyword,
    relationType: isRelationType(raw?.relationType) ? raw.relationType : 'driver',
    direction: isDirection(raw?.direction) ? raw.direction : 'forward',
    confidence,
    weakSignal: typeof raw?.weakSignal === 'boolean' ? raw.weakSignal : confidence < 0.75,
    evidence: Array.isArray(raw?.evidence) && raw.evidence.every(item => typeof item === 'string')
      ? raw.evidence
      : candidate.evidence,
    reasoning: typeof raw?.reasoning === 'string' && raw.reasoning.trim().length > 0
      ? raw.reasoning
      : `${candidate.sourceKeyword} 与 ${candidate.targetKeyword} 存在待验证传导关系。`,
  };
};

export class FriendNetworkLlmAiAdapter implements IFriendNetworkAiAdapter {
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly options: ILlmAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async judge(candidates: readonly IAiRelationshipCandidate[]): Promise<readonly IAiRelationshipDecision[]> {
    if (candidates.length === 0) {
      return [];
    }

    let response: Response;
    try {
      response = await fetchWithRetry(
        `${normalizeBaseUrl(this.options.baseUrl)}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify({
            model: this.options.model,
            response_format: { type: 'json_object' },
            ...(process.env.LLM_SMART_REASONING_EFFORT ? { reasoning_effort: process.env.LLM_SMART_REASONING_EFFORT } : { temperature: 0.1 }),
            messages: [
              {
                role: 'system',
                content: '你是股票图谱关系裁决助手，只返回合法 JSON。',
              } satisfies IOpenAiCompatibleMessage,
              {
                role: 'user',
                content: buildPrompt(candidates),
              } satisfies IOpenAiCompatibleMessage,
            ],
          }),
        },
        {
          maxRetries: 3,
          requestTimeoutMs: process.env.LLM_SMART_REASONING_EFFORT ? 600000 : 30000,
          fetchImpl: this.fetchImpl,
        }
      );
    } catch (error) {
      const match = error instanceof Error ? error.message.match(/Retryable HTTP status:\s*(\d+)/) : null;
      if (match) {
        throw new Error(`Friend network AI request failed with HTTP ${match[1]}`);
      }
      throw error;
    }

    if (!response.ok) {
      throw new Error(`Friend network AI request failed with HTTP ${response.status}`);
    }

    const payload = await response.json() as IOpenAiCompatibleResponse;
    const content = payload.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('Friend network AI response missing message content');
    }

    const parsed = JSON.parse(extractJsonObject(content)) as IRefinedAiDecisionEnvelope;
    const decisions = parsed.decisions ?? [];

    return candidates.flatMap((candidate) => {
      const matched = decisions.find(decision => decision.sourceKeyword === candidate.sourceKeyword && decision.targetKeyword === candidate.targetKeyword);
      const decision = toDecision(candidate, matched);
      return decision ? [decision] : [];
    });
  }
}

export const createFriendNetworkLlmAiAdapterFromEnv = (
  environment: NodeJS.ProcessEnv = process.env,
): FriendNetworkLlmAiAdapter => {
  return new FriendNetworkLlmAiAdapter({
    baseUrl: requireEnvironmentValue(environment.LLM_SMART_BASE_URL, 'LLM_SMART_BASE_URL'),
    apiKey: requireEnvironmentValue(environment.LLM_SMART_API_KEY, 'LLM_SMART_API_KEY'),
    model: requireEnvironmentValue(environment.LLM_SMART_MODEL, 'LLM_SMART_MODEL'),
  });
};
