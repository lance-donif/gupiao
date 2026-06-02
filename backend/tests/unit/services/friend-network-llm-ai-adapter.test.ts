import { describe, expect, it, vi } from 'vitest';

import { FriendNetworkLlmAiAdapter } from '../../../src/services/friend-network-llm-ai-adapter.js';

describe('friend-network llm ai adapter', () => {
  it('maps OpenAI-compatible JSON response into relationship decisions', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decisions: [
                  {
                    sourceKeyword: '新能源',
                    targetKeyword: '白银',
                    relationType: 'driver',
                    direction: 'forward',
                    confidence: 0.92,
                    weakSignal: true,
                    evidence: ['新能源扩产带动白银需求'],
                    reasoning: '新能源扩产提升银浆需求，从而驱动白银预期。',
                  },
                ],
              }),
            },
          },
        ],
      }),
    });

    const adapter = new FriendNetworkLlmAiAdapter({
      baseUrl: 'http://localhost:8080/v1',
      apiKey: 'sk-3809aefa0050e57ff804482aed94bc96f5e382fccdf7b76b1f95a08321d8c8cb',
      model: 'gpt-5.4-mini',
      fetchImpl: fetchMock as typeof fetch,
    });

    const result = await adapter.judge([
      {
        sourceKeyword: '新能源',
        targetKeyword: '白银',
        evidence: ['新能源扩产带动白银需求'],
      },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        sourceKeyword: '新能源',
        targetKeyword: '白银',
        relationType: 'driver',
        direction: 'forward',
        confidence: 0.92,
        weakSignal: true,
        evidence: ['新能源扩产带动白银需求'],
        reasoning: '新能源扩产提升银浆需求，从而驱动白银预期。',
      },
    ]);
  });
});
