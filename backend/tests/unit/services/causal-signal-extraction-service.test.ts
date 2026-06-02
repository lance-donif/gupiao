import { describe, expect, it } from 'vitest';
import {
  CausalSignalExtractionService,
  createCausalSignalExtractorFromEnv,
  OpenAiCompatibleCausalSignalExtractor,
  RuleCausalSignalExtractor,
} from '../../../src/services/causal-signal-extraction-service.js';

class MockCausalSignalPrismaClient {
  public rows: any[] = [];

  public readonly causalSignalCandidate = {
    findMany: async (args?: any) => {
      let rows = this.rows;
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.newsId?.in) {
        const newsIds = new Set(args.where.newsId.in);
        rows = rows.filter(row => newsIds.has(row.newsId));
      }
      if (args?.where?.extractorType) {
        rows = rows.filter(row => row.extractorType === args.where.extractorType);
      }
      if (args?.where?.modelVersion) {
        rows = rows.filter(row => row.modelVersion === args.where.modelVersion);
      }
      if (args?.where?.promptVersion) {
        rows = rows.filter(row => row.promptVersion === args.where.promptVersion);
      }
      return rows;
    },
    createMany: async (args: { data: any[] }) => {
      this.rows.push(...args.data);
      return { count: args.data.length };
    },
  };
}

describe('causal signal extraction service', () => {
  it('does not provide implicit rule fallback when extractor env is missing', () => {
    expect(() => createCausalSignalExtractorFromEnv({} as NodeJS.ProcessEnv)).toThrow(
      'Missing CAUSAL_SIGNAL_EXTRACTOR',
    );
  });

  it('extracts structured business-variable candidates without writing facts or scores', async () => {
    const mockDb = new MockCausalSignalPrismaClient();
    const asOf = new Date('2026-05-24T15:59:59.999Z');
    const result = await new CausalSignalExtractionService(new RuleCausalSignalExtractor()).execute(mockDb, {
      traceId: 'trace-1',
      asOf,
      clusterKey: 'global',
      news: [
        {
          id: 'news-1',
          title: '光伏装机需求大增 白银库存下降',
          content: '光伏装机需求大幅增长，白银库存持续下降，供给出现瓶颈。',
          source: 'aktools',
          publishedAt: new Date('2026-05-24T08:00:00.000Z'),
          reprintWeight: 1,
        },
      ],
    });

    expect(result.candidateCount).toBeGreaterThan(0);
    expect(mockDb.rows[0]).toEqual(expect.objectContaining({
      traceId: 'trace-1',
      newsId: 'news-1',
      businessVariable: expect.any(String),
      assetOrThemeKeyword: '白银',
      direction: 'positive',
      extractorType: 'rule',
      modelVersion: 'rule-causal-signal-v1',
      promptVersion: 'rule-pattern-v1',
      status: 'candidate',
    }));
    expect(mockDb.rows[0]).not.toHaveProperty('symbol');
    expect(mockDb.rows[0]).not.toHaveProperty('finalContribScore');
  });

  it('retries retryable LLM failures without switching to rule fallback', async () => {
    const mockDb = new MockCausalSignalPrismaClient();
    const statuses = [502, 200];
    const fetchImpl = async (): Promise<Response> => {
      const status = statuses.shift() ?? 500;
      if (status !== 200) {
        return new Response('bad gateway', { status });
      }
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              signals: [{
                newsId: 'news-llm',
                event: '白银库存下降',
                businessVariable: '供给不足',
                assetOrThemeKeyword: '白银',
                direction: 'positive',
                confidence: 0.82,
                evidenceText: '白银库存下降',
                evidenceOffsetStart: 0,
                evidenceOffsetEnd: 6,
              }],
            }),
          },
        }],
      }), { status: 200 });
    };

    const result = await new CausalSignalExtractionService(new OpenAiCompatibleCausalSignalExtractor({
      baseUrl: 'http://localhost:8080/v1',
      apiKey: 'sk-3809aefa0050e57ff804482aed94bc96f5e382fccdf7b76b1f95a08321d8c8cb',
      model: 'gpt-5.4-mini',
      fetchImpl: fetchImpl as typeof fetch,
      maxRetries: 1,
      retryDelayMs: 0,
    })).execute(mockDb, {
      traceId: 'trace-llm',
      asOf: new Date('2026-05-24T15:59:59.999Z'),
      clusterKey: 'global',
      news: [{
        id: 'news-llm',
        title: '白银库存下降',
        content: '白银库存下降，供给不足。',
        source: 'aktools',
        publishedAt: new Date('2026-05-24T08:00:00.000Z'),
      }],
    });

    expect(statuses).toEqual([]);
    expect(result.extractorType).toBe('llm');
    expect(mockDb.rows[0]).toEqual(expect.objectContaining({
      extractorType: 'llm',
      modelVersion: 'gpt-5.4-mini',
      businessVariable: '供给不足',
      assetOrThemeKeyword: '白银',
    }));
  });

  it('throws after LLM retries are exhausted and does not create rule candidates', async () => {
    const mockDb = new MockCausalSignalPrismaClient();
    let requestCount = 0;
    const fetchImpl = async (): Promise<Response> => {
      requestCount += 1;
      return new Response('bad gateway', { status: 502 });
    };

    await expect(new CausalSignalExtractionService(new OpenAiCompatibleCausalSignalExtractor({
      baseUrl: 'http://localhost:8080/v1',
      apiKey: 'sk-3809aefa0050e57ff804482aed94bc96f5e382fccdf7b76b1f95a08321d8c8cb',
      model: 'gpt-5.4-mini',
      fetchImpl: fetchImpl as typeof fetch,
      maxRetries: 2,
      retryDelayMs: 0,
    })).execute(mockDb, {
      traceId: 'trace-llm-fail',
      asOf: new Date('2026-05-24T15:59:59.999Z'),
      clusterKey: 'global',
      news: [{
        id: 'news-fail',
        title: '白银库存下降',
        content: '白银库存下降，供给不足。',
        source: 'aktools',
        publishedAt: new Date('2026-05-24T08:00:00.000Z'),
      }],
    })).rejects.toThrow('Causal signal AI request failed with HTTP 502');

    expect(requestCount).toBe(3);
    expect(mockDb.rows).toEqual([]);
  });

  it('rejects LLM requests over the configured size before sending them', async () => {
    const mockDb = new MockCausalSignalPrismaClient();
    let requestCount = 0;
    const fetchImpl = async (): Promise<Response> => {
      requestCount += 1;
      return new Response('{}', { status: 200 });
    };

    await expect(new CausalSignalExtractionService(new OpenAiCompatibleCausalSignalExtractor({
      baseUrl: 'https://llm.example/v1',
      apiKey: 'test-key',
      model: 'gpt-5.4-mini',
      fetchImpl: fetchImpl as typeof fetch,
      maxRequestChars: 500,
    })).execute(mockDb, {
      traceId: 'trace-oversize',
      asOf: new Date('2026-05-24T15:59:59.999Z'),
      clusterKey: 'global',
      news: [{
        id: 'news-big',
        title: '白银库存下降',
        content: '白银库存下降，供给不足。'.repeat(200),
        source: 'aktools',
        publishedAt: new Date('2026-05-24T08:00:00.000Z'),
      }],
    })).rejects.toThrow('Causal signal AI request too large');

    expect(requestCount).toBe(0);
    expect(mockDb.rows).toEqual([]);
  });

  it('marks LLM signals rejected when evidence text cannot be located in the news', async () => {
    const mockDb = new MockCausalSignalPrismaClient();
    const fetchImpl = async (): Promise<Response> => {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              signals: [{
                newsId: 'news-bad-evidence',
                event: '白银库存下降',
                businessVariable: '供给不足',
                assetOrThemeKeyword: '白银',
                direction: 'positive',
                confidence: 0.82,
                evidenceText: '原文不存在的白银库存证据',
                evidenceOffsetStart: 0,
                evidenceOffsetEnd: 10,
              }],
            }),
          },
        }],
      }), { status: 200 });
    };

    const result = await new CausalSignalExtractionService(new OpenAiCompatibleCausalSignalExtractor({
      baseUrl: 'http://localhost:8080/v1',
      apiKey: 'test-key',
      model: 'gpt-5.4-mini',
      fetchImpl: fetchImpl as typeof fetch,
      maxRetries: 0,
    })).execute(mockDb, {
      traceId: 'trace-bad-evidence',
      asOf: new Date('2026-05-24T15:59:59.999Z'),
      clusterKey: 'global',
      news: [{
        id: 'news-bad-evidence',
        title: '光伏装机需求增长',
        content: '光伏装机需求增长，组件订单改善。',
        source: 'aktools',
        publishedAt: new Date('2026-05-24T08:00:00.000Z'),
      }],
    });

    expect(result.candidateCount).toBe(1);
    expect(result.acceptedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(mockDb.rows[0]).toEqual(expect.objectContaining({
      status: 'rejected',
      failureReason: 'evidence_text_not_found',
    }));
  });

  it('marks LLM signals rejected when the keyword is unsupported by the source text', async () => {
    const mockDb = new MockCausalSignalPrismaClient();
    const fetchImpl = async (): Promise<Response> => {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              signals: [{
                newsId: 'news-wrong-keyword',
                event: '煤矿事故发布会',
                businessVariable: '风险事件',
                assetOrThemeKeyword: '机器人',
                direction: 'positive',
                confidence: 0.82,
                evidenceText: '煤矿事故发布会召开',
                evidenceOffsetStart: 0,
                evidenceOffsetEnd: 9,
              }],
            }),
          },
        }],
      }), { status: 200 });
    };

    const result = await new CausalSignalExtractionService(new OpenAiCompatibleCausalSignalExtractor({
      baseUrl: 'http://localhost:8080/v1',
      apiKey: 'test-key',
      model: 'gpt-5.4-mini',
      fetchImpl: fetchImpl as typeof fetch,
      maxRetries: 0,
    })).execute(mockDb, {
      traceId: 'trace-wrong-keyword',
      asOf: new Date('2026-05-24T15:59:59.999Z'),
      clusterKey: 'global',
      news: [{
        id: 'news-wrong-keyword',
        title: '煤矿事故发布会召开',
        content: '煤矿事故发布会召开，通报安全生产风险。',
        source: 'aktools',
        publishedAt: new Date('2026-05-24T08:00:00.000Z'),
      }],
    });

    expect(result.candidateCount).toBe(1);
    expect(result.acceptedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(mockDb.rows[0]).toEqual(expect.objectContaining({
      status: 'rejected',
      failureReason: 'keyword_not_supported_by_evidence',
    }));
  });

  it('reuses cached LLM candidates for the same news and model without sending a new request', async () => {
    const mockDb = new MockCausalSignalPrismaClient();
    mockDb.rows.push({
      traceId: 'old-trace',
      asOf: new Date('2026-05-24T12:00:00.000Z'),
      clusterKey: 'global',
      newsId: 'news-cached',
      event: '白银库存下降',
      businessVariable: '供给不足',
      assetOrThemeKeyword: '白银',
      direction: 'positive',
      confidence: '0.8200',
      evidenceText: '白银库存下降',
      evidenceOffsetStart: 0,
      evidenceOffsetEnd: 6,
      extractorType: 'llm',
      modelVersion: 'gpt-5.4-mini',
      promptVersion: 'causal-signal-extraction-v1',
      status: 'candidate',
      failureReason: null,
    });
    let requestCount = 0;
    const fetchImpl = async (): Promise<Response> => {
      requestCount += 1;
      return new Response('{}', { status: 200 });
    };

    const result = await new CausalSignalExtractionService(new OpenAiCompatibleCausalSignalExtractor({
      baseUrl: 'http://localhost:8080/v1',
      apiKey: 'test-key',
      model: 'gpt-5.4-mini',
      fetchImpl: fetchImpl as typeof fetch,
      maxRetries: 0,
    })).execute(mockDb, {
      traceId: 'new-trace',
      asOf: new Date('2026-05-24T15:59:59.999Z'),
      clusterKey: 'global',
      news: [{
        id: 'news-cached',
        title: '白银库存下降',
        content: '白银库存下降，供给不足。',
        source: 'aktools',
        publishedAt: new Date('2026-05-24T08:00:00.000Z'),
      }],
    });

    expect(requestCount).toBe(0);
    expect(result.cacheHitCount).toBe(1);
    expect(mockDb.rows).toContainEqual(expect.objectContaining({
      traceId: 'new-trace',
      newsId: 'news-cached',
      status: 'candidate',
    }));
  });

  it('revalidates cached LLM candidates against the current news text before reuse', async () => {
    const mockDb = new MockCausalSignalPrismaClient();
    mockDb.rows.push({
      traceId: 'old-trace',
      asOf: new Date('2026-05-24T12:00:00.000Z'),
      clusterKey: 'global',
      newsId: 'news-reused-id',
      event: 'DRAM 客户覆盖',
      businessVariable: '客户覆盖范围',
      assetOrThemeKeyword: 'DRAM',
      direction: 'positive',
      confidence: '0.8200',
      evidenceText: '覆盖全球头部DRAM厂商',
      evidenceOffsetStart: 0,
      evidenceOffsetEnd: 12,
      extractorType: 'llm',
      modelVersion: 'gpt-5.4-mini',
      promptVersion: 'causal-signal-extraction-v1',
      status: 'candidate',
      failureReason: null,
    });
    let requestCount = 0;
    const fetchImpl = async (): Promise<Response> => {
      requestCount += 1;
      return new Response('{}', { status: 200 });
    };

    const result = await new CausalSignalExtractionService(new OpenAiCompatibleCausalSignalExtractor({
      baseUrl: 'http://localhost:8080/v1',
      apiKey: 'test-key',
      model: 'gpt-5.4-mini',
      fetchImpl: fetchImpl as typeof fetch,
      maxRetries: 0,
    })).execute(mockDb, {
      traceId: 'new-trace-revalidate',
      asOf: new Date('2026-05-24T15:59:59.999Z'),
      clusterKey: 'global',
      news: [{
        id: 'news-reused-id',
        title: '日本茨城县近海地区发生4.0级地震',
        content: '据日本气象厅消息，日本茨城县近海地区发生4.0级地震。',
        source: 'aktools',
        publishedAt: new Date('2026-05-24T08:00:00.000Z'),
      }],
    });

    expect(requestCount).toBe(0);
    expect(result.cacheHitCount).toBe(1);
    expect(result.acceptedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(mockDb.rows).toContainEqual(expect.objectContaining({
      traceId: 'new-trace-revalidate',
      newsId: 'news-reused-id',
      status: 'rejected',
      failureReason: 'evidence_text_not_found',
    }));
  });
});
