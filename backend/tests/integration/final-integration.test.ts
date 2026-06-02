import { readFile, writeFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createBackendIntegrationConfig,
  FinalIntegrationHarness,
  type IRawNewsArtifact,
  type IRawNewsArtifactWriter,
} from '../../src/services/index.js';
import type { PrismaClientAdapter } from '../../src/services/prisma-adapter.js';
import type { IPrismaTransactionalClient } from '../../src/repositories/prisma-types.js';

class RecordingRawNewsArtifactWriter implements IRawNewsArtifactWriter {
  public artifact: IRawNewsArtifact | null = null;

  public constructor(private readonly filePath: string) {}

  public async write(artifact: IRawNewsArtifact): Promise<string> {
    this.artifact = artifact;
    return this.filePath;
  }
}

class ThrowingRawNewsArtifactWriter implements IRawNewsArtifactWriter {
  public async write(_artifact: IRawNewsArtifact): Promise<string> {
    throw new Error('raw news artifact disk full');
  }
}

const createPrismaStub = (): PrismaClientAdapter => {
  return {
    newsItem: {
      create: async () => {
        throw new Error('not-implemented');
      },
      delete: async () => {
        throw new Error('not-implemented');
      },
      findUnique: async () => null,
      findMany: async () => [],
    },
    stock: {
      create: async () => {
        throw new Error('not-implemented');
      },
      delete: async () => {
        throw new Error('not-implemented');
      },
      findUnique: async () => null,
      findMany: async () => [],
    },
    $transaction: async <T>(callback: (transaction: IPrismaTransactionalClient) => Promise<T>): Promise<T> => {
      return callback(createPrismaStub());
    },
    $connect: async () => undefined,
    $disconnect: async () => undefined,
  } as unknown as PrismaClientAdapter;
};

describe('final integration harness', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails fast with structured diagnostics when AKTOOLS_BASE_URL is missing', async () => {
    const harness = new FinalIntegrationHarness(createBackendIntegrationConfig({
      DATABASE_URL: 'postgresql://gupiao:password@localhost:5432/gupiaodb?schema=public',
      AKTOOLS_BASE_URL: '',
    }));

    const result = await harness.run({
      cluster: 'cluster-integration',
      query: '银行',
      asOf: new Date('2026-03-17T10:00:00.000Z'),
      timeWindow: {
        start: new Date('2026-03-17T08:00:00.000Z'),
        end: new Date('2026-03-17T10:00:00.000Z'),
      },
      limit: 3,
    });

    expect(result.status).toBe('failure');
    expect(result.failureCategory).toBe('integration_exception');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        cluster: 'cluster-integration',
        provider: 'aktools-news-provider',
        serviceStage: 'integration-exception',
        eventType: 'integration-failed',
        failureCategory: 'integration_exception',
        detail: 'Missing required environment variable: AKTOOLS_BASE_URL',
      }),
    ]);
    expect(result.persistedNews).toEqual([]);
  });

  it('reports structured source-fetch failure when AKTools endpoint is unreachable', async () => {
    const harness = new FinalIntegrationHarness(createBackendIntegrationConfig({
      DATABASE_URL: 'postgresql://gupiao:password@localhost:5432/gupiaodb?schema=public',
      AKTOOLS_BASE_URL: 'http://127.0.0.1:65530',
      AKTOOLS_MAX_RESULTS: '5',
    }), {
      prismaFactory: () => createPrismaStub(),
    });

    const result = await harness.run({
      cluster: 'cluster-integration',
      query: '银行',
      asOf: new Date('2026-03-17T10:00:00.000Z'),
      timeWindow: {
        start: new Date('2026-03-17T08:00:00.000Z'),
        end: new Date('2026-03-17T10:00:00.000Z'),
      },
      limit: 3,
    });

    expect(result.status).toBe('failure');
    expect(result.failureCategory).toBe('unavailable');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        cluster: 'cluster-integration',
        provider: 'aktools-news-provider',
        serviceStage: 'bootstrap',
        eventType: 'integration-started',
      }),
      expect.objectContaining({
        cluster: 'cluster-integration',
        provider: 'aktools-news-provider',
        serviceStage: 'source-fetch',
        eventType: 'source-fetch-failed',
        failureCategory: 'unavailable',
      }),
    ]);
    expect(result.persistedNews).toEqual([]);
  });

  it('includes execution observability fields in failure-safe integration reports', async () => {
    const harness = new FinalIntegrationHarness(createBackendIntegrationConfig({
      DATABASE_URL: 'postgresql://gupiao:password@localhost:5432/gupiaodb?schema=public',
      AKTOOLS_BASE_URL: '',
    }));

    const result = await harness.run({
      cluster: 'cluster-integration',
      query: '银行',
      asOf: new Date('2026-03-17T10:00:00.000Z'),
      timeWindow: {
        start: new Date('2026-03-17T08:00:00.000Z'),
        end: new Date('2026-03-17T10:00:00.000Z'),
      },
      limit: 3,
    });

    expect(result.executionRecord).toBeUndefined();
    expect(result.replayContext).toBeUndefined();
  });

  it('does not attempt raw news artifact writing when provider fetch fails', async () => {
    const artifactWriter = new RecordingRawNewsArtifactWriter('/tmp/final-integration-raw-news.json');
    const harness = new FinalIntegrationHarness(createBackendIntegrationConfig({
      DATABASE_URL: 'postgresql://gupiao:password@localhost:5432/gupiaodb?schema=public',
      AKTOOLS_BASE_URL: 'http://127.0.0.1:65530',
      AKTOOLS_MAX_RESULTS: '5',
    }), {
      prismaFactory: () => createPrismaStub(),
      rawNewsArtifactWriter: artifactWriter,
    });

    const result = await harness.run({
      cluster: 'cluster-integration',
      query: '银行',
      asOf: new Date('2026-03-17T10:00:00.000Z'),
      timeWindow: {
        start: new Date('2026-03-17T08:00:00.000Z'),
        end: new Date('2026-03-17T10:00:00.000Z'),
      },
      limit: 3,
    });

    expect(result.rawNewsFilePath).toBeUndefined();
    expect(artifactWriter.artifact).toBeNull();
  });

  it('persists a raw news json artifact when provider fetch succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-17T10:00:00.000Z'));

    const tempFilePath = `/tmp/final-integration-raw-news-${Date.now()}.json`;
    const harness = new FinalIntegrationHarness(createBackendIntegrationConfig({
      DATABASE_URL: 'postgresql://gupiao:password@localhost:5432/gupiaodb?schema=public',
      AKTOOLS_BASE_URL: 'http://127.0.0.1:65530',
      AKTOOLS_MAX_RESULTS: '5',
    }), {
      prismaFactory: () => createPrismaStub(),
      rawNewsArtifactWriter: {
        async write(artifact): Promise<string> {
          await writeFile(tempFilePath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
          return tempFilePath;
        },
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      const payload = url.includes('stock_info_global_em')
        ? [{ 标题: '银行股走强', 摘要: '银行板块上涨', 链接: 'https://example.com/em', 发布时间: '2026-03-17T09:00:00.000Z' }]
        : url.includes('stock_info_global_ths')
          ? [{ 标题: '银行资金流入', 内容: '资金关注银行', 链接: 'https://example.com/ths', 发布时间: '2026-03-17T08:45:00.000Z' }]
          : [{ 地区: '中国', 事件: '银行信贷数据公布', 公布: '12%', 预期: '11%', 前值: '10%', 日期: '2026-03-17', 时间: '16:30:00', 重要性: 3 }];

      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const result = await harness.run({
        cluster: 'cluster-integration',
        query: '银行',
        asOf: new Date('2026-03-17T10:00:00.000Z'),
        timeWindow: {
          start: new Date('2026-03-17T08:00:00.000Z'),
          end: new Date('2026-03-17T10:00:00.000Z'),
        },
        limit: 3,
      });

      expect(result.rawNewsFilePath).toBe(tempFilePath);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          serviceStage: 'raw-news-artifact',
          eventType: 'raw-news-artifact-written',
          detail: tempFilePath,
        }),
      ]));

      const artifact = JSON.parse(await readFile(tempFilePath, 'utf8')) as IRawNewsArtifact;
      expect(artifact.summary.totalNewsCount).toBe(3);
      expect(artifact.summary.cluster).toBe('cluster-integration');
      expect(artifact.summary.query).toBe('银行');
      expect(artifact.summary.runId).toBe(result.runId);
      expect(artifact.summary.fetchedAt).toBeTypeOf('string');
      expect(artifact.summary.sourcesBreakdown).toEqual({
        akshare_global_em: 1,
        akshare_global_ths: 1,
        akshare_baidu: 1,
      });
      expect(artifact.summary.earliestPublishedAt).toBe('2026-03-17T08:30:00.000Z');
      expect(artifact.summary.latestPublishedAt).toBe('2026-03-17T09:00:00.000Z');
      expect(artifact.provider).toBe('aktools-news-provider');
      expect(artifact.limit).toBe(3);
      expect(artifact.timeWindow).toEqual({
        start: '2026-03-17T08:00:00.000Z',
        end: '2026-03-17T10:00:00.000Z',
      });
      expect(artifact.requestMetadata.providerIdentity).toBe('aktools-news-provider');
      expect(artifact.deduplicationKey).toContain('cluster-integration');
      expect(artifact.rawNews).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('surfaces structured diagnostics when raw news artifact writing fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-17T10:00:00.000Z'));

    const harness = new FinalIntegrationHarness(createBackendIntegrationConfig({
      DATABASE_URL: 'postgresql://gupiao:password@localhost:5432/gupiaodb?schema=public',
      AKTOOLS_BASE_URL: 'http://127.0.0.1:65530',
      AKTOOLS_MAX_RESULTS: '5',
    }), {
      prismaFactory: () => createPrismaStub(),
      rawNewsArtifactWriter: new ThrowingRawNewsArtifactWriter(),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (): Promise<Response> => {
      return new Response(JSON.stringify([
        { 标题: '银行股走强', 摘要: '银行板块上涨', 链接: 'https://example.com/em', 发布时间: '2026-03-17T09:00:00.000Z' },
      ]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const result = await harness.run({
        cluster: 'cluster-integration',
        query: '银行',
        asOf: new Date('2026-03-17T10:00:00.000Z'),
        timeWindow: {
          start: new Date('2026-03-17T08:00:00.000Z'),
          end: new Date('2026-03-17T10:00:00.000Z'),
        },
        limit: 1,
      });

      expect(result.rawNewsFilePath).toBeUndefined();
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          serviceStage: 'raw-news-artifact',
          eventType: 'raw-news-artifact-write-failed',
          failureCategory: 'artifact_write_failed',
          detail: 'raw news artifact disk full',
        }),
      ]));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
