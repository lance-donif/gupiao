import type { IFriendNetworkAiAdapter } from './friend-network-ai-adapter.js';
import type {
  IAiRelationshipCandidate,
  IAiRelationshipDecision,
} from './friend-network-types.js';
import { AiChatClient, createAiOptionsFromEnv, withAiSource } from './ai-chat-client.js';
import { isAiRecord } from './ai-provider-config.js';

interface ILlmAdapterOptions {
  readonly client?: AiChatClient;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
}

interface IRefinedAiDecision extends Partial<IAiRelationshipDecision> {
  readonly shouldKeep?: boolean;
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
  private readonly client: AiChatClient;

  public constructor(options: ILlmAdapterOptions) {
    this.client = AiChatClient.fromOptions(options);
  }

  public async judge(candidates: readonly IAiRelationshipCandidate[]): Promise<readonly IAiRelationshipDecision[]> {
    if (candidates.length === 0) {
      return [];
    }

    const result = await this.client.request({
      label: 'Friend network AI',
      messages: [
        { role: 'system', content: '你是股票图谱关系裁决助手，只返回合法 JSON。' },
        { role: 'user', content: buildPrompt(candidates) },
      ],
      temperature: 0.1,
      timeoutMs: 30000,
      validate: (value): readonly IRefinedAiDecision[] => {
        if (!isAiRecord(value) || !Array.isArray(value.decisions)) throw new Error('Missing decisions');
        for (const decision of value.decisions) {
          if (!isAiRecord(decision) || typeof decision.sourceKeyword !== 'string' || typeof decision.targetKeyword !== 'string'
            || !isRelationType(decision.relationType) || !isDirection(decision.direction)
            || typeof decision.confidence !== 'number' || !Number.isFinite(decision.confidence)
            || typeof decision.weakSignal !== 'boolean' || !Array.isArray(decision.evidence)
            || !decision.evidence.every((item: unknown) => typeof item === 'string') || typeof decision.reasoning !== 'string' || !decision.reasoning.trim()
            || (decision.shouldKeep !== undefined && typeof decision.shouldKeep !== 'boolean')) throw new Error('Invalid decision');
        }
        const decisions = value.decisions;
        if (candidates.some(candidate => !decisions.some((decision: IRefinedAiDecision) => decision.sourceKeyword === candidate.sourceKeyword && decision.targetKeyword === candidate.targetKeyword))) {
          throw new Error('Missing candidate decision');
        }
        return value.decisions;
      },
    });
    const decisions = result.value;

    return withAiSource(candidates.flatMap((candidate) => {
      const matched = decisions.find(decision => decision.sourceKeyword === candidate.sourceKeyword && decision.targetKeyword === candidate.targetKeyword);
      const decision = toDecision(candidate, matched);
      return decision ? [decision] : [];
    }), result.source);
  }
}

export const createFriendNetworkLlmAiAdapterFromEnv = (
  environment: NodeJS.ProcessEnv = process.env,
): FriendNetworkLlmAiAdapter => {
  return new FriendNetworkLlmAiAdapter(createAiOptionsFromEnv(environment));
};
