import { describe, expect, it } from 'vitest';
import {
  CausalSignalExtractionService,
  createCausalSignalInputFingerprint,
  createCausalSignalExtractorFromEnv,
  OpenAiCompatibleCausalSignalExtractor,
  RuleCausalSignalExtractor,
} from '../../../src/services/causal-signal-extraction-service.js';

class MockCausalSignalPrismaClient {
  public rows: any[] = [];
  public ledgerRows: any[] = [];

  public commitSeededExtraction(): void {
    const row=this.rows[0];
    this.ledgerRows.push({dataKind:'causal_signal_extraction',source:[row.extractorType,row.modelVersion,row.promptVersion].join(':'),
      clusterKey:row.clusterKey,bucketKey:row.inputFingerprint,status:'success',fetchedAt:row.asOf,expiresAt:new Date('2099-01-01'),
      summary:{protocolVersion:2,promptVersion:row.promptVersion,modelVersion:row.modelVersion,signals:[{...row,confidence:Number(row.confidence)}]}});
  }

  public readonly $queryRawUnsafe = async (_query: string, ...args: any[]) => {
    if (!_query.includes('"DataRefreshLedger"')) {
      return [];
    }
    const [dataKind, source, clusterKey, bucketKeys, status, asOf] = args;
    const allowedBuckets = new Set(bucketKeys);
    return this.ledgerRows.filter(row => row.dataKind === dataKind
      && row.source === source
      && row.clusterKey === clusterKey
      && allowedBuckets.has(row.bucketKey)
      && row.status === status
      && row.expiresAt > asOf
      && row.fetchedAt <= asOf);
  };

  public readonly $executeRawUnsafe = async (query: string, ...args: any[]) => {
    if (!query.includes('INSERT INTO "DataRefreshLedger"')) {
      return 1;
    }
    const [, dataKind, source, clusterKey, bucketKey, status, fetchedAt, expiresAt, traceId, summary, error] = args;
    const index = this.ledgerRows.findIndex(row => row.dataKind === dataKind
      && row.source === source
      && row.clusterKey === clusterKey
      && row.bucketKey === bucketKey);
    const row = {
      dataKind,
      source,
      clusterKey,
      bucketKey,
      status,
      fetchedAt,
      expiresAt,
      traceId,
      summary: JSON.parse(summary),
      error,
    };
    if (index === -1) this.ledgerRows.push(row);
    else this.ledgerRows[index] = row;
    return 1;
  };

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
      if (args?.where?.inputFingerprint?.in) {
        const fingerprints = new Set(args.where.inputFingerprint.in);
        rows = rows.filter(row => fingerprints.has(row.inputFingerprint));
      }
      if (args?.where?.extractorType) {
        rows = rows.filter(row => row.extractorType === args.where.extractorType);
      }
      if (args?.where?.modelVersion) {
        const modelVersions = args.where.modelVersion.in
          ? new Set(args.where.modelVersion.in)
          : new Set([args.where.modelVersion]);
        rows = rows.filter(row => modelVersions.has(row.modelVersion));
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

  it('fails after one attempt of the only model and does not create rule candidates', async () => {
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

    expect(requestCount).toBe(1);
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
              noSignalNewsIds: [],
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
              noSignalNewsIds: [],
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
      promptVersion: new OpenAiCompatibleCausalSignalExtractor({baseUrl:'http://localhost:8080/v1',apiKey:'test-key',model:'gpt-5.4-mini'}).promptVersion,
      status: 'candidate',
      failureReason: null,
      inputFingerprint: createCausalSignalInputFingerprint({
        id: 'news-cached',
        title: '白银库存下降',
        content: '白银库存下降，供给不足。',
        source: 'aktools',
        publishedAt: new Date('2026-05-24T08:00:00.000Z'),
      }),
    });
    mockDb.commitSeededExtraction();
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
      promptVersion: new OpenAiCompatibleCausalSignalExtractor({baseUrl:'http://localhost:8080/v1',apiKey:'test-key',model:'gpt-5.4-mini'}).promptVersion,
      status: 'candidate',
      failureReason: null,
      inputFingerprint: createCausalSignalInputFingerprint({
        id: 'news-reused-id',
        title: '日本茨城县近海地区发生4.0级地震',
        content: '据日本气象厅消息，日本茨城县近海地区发生4.0级地震。',
        source: 'aktools',
        publishedAt: new Date('2026-05-24T08:00:00.000Z'),
      }),
    });
    mockDb.commitSeededExtraction();
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

  it('does not split batches and repeat the chain after all AI candidates fail', async () => {
    const mockDb = new MockCausalSignalPrismaClient();
    let requestCount = 0;
    const extractor = new OpenAiCompatibleCausalSignalExtractor({
      baseUrl: 'https://example.test/v1', apiKey: 'test-key', model: 'model-a',
      fetchImpl: (async () => { requestCount += 1; return new Response('', { status: 503 }); }) as typeof fetch,
    });
    await expect(new CausalSignalExtractionService(extractor).execute(mockDb, {
      traceId: 'trace-dynamic-batch', asOf: new Date('2026-05-24T15:59:59.999Z'), clusterKey: 'global', batchSize: 4,
      news: ['a', 'b', 'c', 'd'].map(id => ({ id, title: '白银库存下降', content: '白银库存下降。', source: 'test', publishedAt: new Date('2026-05-24T08:00:00Z') })),
    })).rejects.toThrow('All AI candidates failed');
    expect(requestCount).toBe(1);
    expect(mockDb.rows).toEqual([]);
  });

  it('reuses an explicit no-signal result for a syndicated article with a new news ID', async () => {
    const mockDb = new MockCausalSignalPrismaClient();
    let requestCount = 0;
    const fetchImpl = async (): Promise<Response> => {
      requestCount += 1;
      return new Response(JSON.stringify({
        choices: [{
          message: { content: JSON.stringify({ signals: [], noSignalNewsIds: ['source-day-one'] }) },
          finish_reason: 'stop',
        }],
      }), { status: 200 });
    };
    const extractor = new OpenAiCompatibleCausalSignalExtractor({
      baseUrl: 'https://llm.example/v1',
      apiKey: 'test-key',
      model: 'test-model',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const service = new CausalSignalExtractionService(extractor);
    const article = {
      title: '白银库存下降',
      content: '白银库存下降，供给不足。',
      source: 'wire',
      publishedAt: new Date('2026-05-24T08:00:00.000Z'),
    };
    await service.execute(mockDb, {
      traceId: 'trace-day-one',
      asOf: new Date('2026-05-24T15:59:59.999Z'),
      clusterKey: 'global',
      news: [{ id: 'source-day-one', ...article }],
    });
    const replay = await service.execute(mockDb, {
      traceId: 'trace-day-two',
      asOf: new Date('2026-05-25T15:59:59.999Z'),
      clusterKey: 'global',
      news: [{ id: 'syndicated-day-two', ...article }],
    });

    expect(requestCount).toBe(1);
    expect(replay).toMatchObject({ candidateCount: 0, cacheHitCount: 1 });
    expect(mockDb.ledgerRows[0]?.summary).toMatchObject({
      protocolVersion: 2,
      outcome: 'no_signal',
    });
  });

  it('rebinds content-cached signals to a syndicated article without trusting the old news ID', async () => {
    const mockDb = new MockCausalSignalPrismaClient();
    let requestCount = 0;
    const fetchImpl = async (): Promise<Response> => {
      requestCount += 1;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              signals: [{
                newsId: 'source-day-one',
                event: '白银库存下降',
                businessVariable: '供给不足',
                assetOrThemeKeyword: '白银',
                direction: 'positive',
                confidence: 0.9,
                evidenceText: '白银库存下降',
              }],
              noSignalNewsIds: [],
            }),
          },
          finish_reason: 'stop',
        }],
      }), { status: 200 });
    };
    const service = new CausalSignalExtractionService(new OpenAiCompatibleCausalSignalExtractor({
      baseUrl: 'https://llm.example/v1',
      apiKey: 'test-key',
      model: 'test-model',
      fetchImpl: fetchImpl as typeof fetch,
    }));
    const article = {
      title: '白银库存下降',
      content: '白银库存下降，供给不足。',
      source: 'wire',
      publishedAt: new Date('2026-05-24T08:00:00.000Z'),
    };
    await service.execute(mockDb, {
      traceId: 'trace-day-one',
      asOf: new Date('2026-05-24T15:59:59.999Z'),
      clusterKey: 'global',
      news: [{ id: 'source-day-one', ...article }],
    });
    const replay = await service.execute(mockDb, {
      traceId: 'trace-day-two',
      asOf: new Date('2026-05-25T15:59:59.999Z'),
      clusterKey: 'global',
      news: [{ id: 'syndicated-day-two', ...article }],
    });

    expect(requestCount).toBe(1);
    expect(replay).toMatchObject({ candidateCount: 1, cacheHitCount: 1 });
    expect(mockDb.rows).toContainEqual(expect.objectContaining({
      traceId: 'trace-day-two',
      newsId: 'syndicated-day-two',
      inputFingerprint: createCausalSignalInputFingerprint({ id: 'syndicated-day-two', ...article }),
    }));
  });
});

describe('causal signal v3 items protocol extractor', () => {
  const asOf = new Date('2026-05-24T15:59:59.999Z');
  const itemsNews = [
    { id: 'n1', title: '白银库存下降', content: '白银库存下降，供给不足。', source: 'test', publishedAt: new Date('2026-05-24T08:00:00Z') },
    { id: 'n2', title: '光伏装机增长', content: '光伏装机需求增长，组件订单改善。', source: 'test', publishedAt: new Date('2026-05-24T08:00:00Z') },
  ];
  const responder = (items: unknown) => {
    const fetchImpl = async (): Promise<Response> => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ items }) }, finish_reason: 'stop' }],
    }), { status: 200 });
    return new OpenAiCompatibleCausalSignalExtractor({
      baseUrl: 'https://llm.example/v1', apiKey: 'test-key', model: 'test-model', protocolMode: 'items', fetchImpl: fetchImpl as typeof fetch,
    });
  };

  it('accepts a valid items response and honors explicit no_signal coverage', async () => {
    const mockDb = new MockCausalSignalPrismaClient();
    const result = await new CausalSignalExtractionService(responder([
      { newsId: 'n1', status: 'signals', signals: [{ event: '白银库存下降', businessVariable: '供给不足', assetOrThemeKeyword: '白银', direction: 'positive', confidence: 0.9, evidenceText: '白银库存下降' }] },
      { newsId: 'n2', status: 'no_signal', signals: [] },
    ])).execute(mockDb, { traceId: 'trace-v3', asOf, clusterKey: 'global', news: itemsNews });

    expect(result).toMatchObject({ candidateCount: 1, acceptedCount: 1 });
    expect(mockDb.rows[0]).toEqual(expect.objectContaining({ newsId: 'n1', status: 'candidate' }));
  });

  it('rejects the whole extraction without any partial commit when a signal violates the contract', async () => {
    const mockDb = new MockCausalSignalPrismaClient();
    await expect(new CausalSignalExtractionService(responder([
      { newsId: 'n1', status: 'signals', signals: [{ event: '白银库存下降', businessVariable: '供给不足', assetOrThemeKeyword: '白银', direction: 'positive', confidence: 0.9, evidenceText: '白银库存下降' }] },
      { newsId: 'n2', status: 'signals', signals: [{ event: '不存在', businessVariable: '供给不足', assetOrThemeKeyword: '白银', direction: 'positive', confidence: 0.9, evidenceText: '原文不存在的证据' }] },
    ])).execute(mockDb, { traceId: 'trace-v3-bad', asOf, clusterKey: 'global', news: itemsNews })).rejects.toThrow('All AI candidates failed');
    expect(mockDb.rows).toEqual([]);
  });

  it('rejects the whole extraction when an item is missing', async () => {
    const mockDb = new MockCausalSignalPrismaClient();
    await expect(new CausalSignalExtractionService(responder([
      { newsId: 'n1', status: 'signals', signals: [{ event: '白银库存下降', businessVariable: '供给不足', assetOrThemeKeyword: '白银', direction: 'positive', confidence: 0.9, evidenceText: '白银库存下降' }] },
    ])).execute(mockDb, { traceId: 'trace-v3-missing', asOf, clusterKey: 'global', news: itemsNews })).rejects.toThrow('All AI candidates failed');
    expect(mockDb.rows).toEqual([]);
  });
});

