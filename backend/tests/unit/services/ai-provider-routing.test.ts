import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CausalSignalExtractionService, createCausalSignalExtractorFromEnv } from '../../../src/services/causal-signal-extraction-service.js';
import { AiStockKeywordGenerationService, createAiStockKeywordRequesterFromEnv } from '../../../src/services/ai-stock-keyword-generation-service.js';
import { createFriendNetworkLlmAiAdapterFromEnv } from '../../../src/services/friend-network-llm-ai-adapter.js';
import { createExposureCandidateExtractorFromEnv } from '../../../src/services/limitup-evidence-initialization.js';

const dirs: string[] = [];
const providers = [1, 2, 3].map(i => ({ id: `p${i}`, baseUrl: `https://p${i}.example/v1`, apiKey: `test-secret-${i}`, models: [{ id: 'm1' }, { id: 'm2' }] }));
function environment(reverse = false): NodeJS.ProcessEnv {
  const dir = mkdtempSync(path.join(tmpdir(), 'gupiao-ai-routing-')); dirs.push(dir);
  const file = path.join(dir, 'ai.json');
  writeFileSync(file, JSON.stringify({ providers: reverse ? [...providers].reverse() : providers }));
  return { AI_CONFIG_FILE: file, CAUSAL_SIGNAL_EXTRACTOR: 'llm', LLM_SMART_MODEL: 'ignored', LLM_SMART_API_KEY: 'ignored', OPENAI_MODEL: 'ignored', OPENAI_API_KEY: 'ignored' };
}
afterEach(() => { vi.unstubAllGlobals(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
const asOf = new Date('2026-06-01T12:00:00Z');
const news = { id: 'n1', title: '白银库存下降', content: '白银库存下降，供给不足。', source: 'test', publishedAt: new Date('2026-06-01T08:00:00Z') };
const input = { traceId: 'trace-1', asOf, clusterKey: 'global', news: [news] };
const signal = { newsId: 'n1', event: news.title, businessVariable: '供给不足', assetOrThemeKeyword: '白银', direction: 'positive', confidence: 0.9, evidenceText: news.title };
const stock = { symbol: '600001', name: '测试股份', industry: '白银' };
const keywordPayload = { stocks: [{ symbol: stock.symbol, keywords: [{ keyword: '白银', exposureType: 'industry_exposure', confidence: 0.9, reason: '行业' }] }] };
const relationship = { sourceKeyword: '光伏', targetKeyword: '白银', evidence: ['光伏拉动白银需求'] };
const decision = { ...relationship, relationType: 'driver', direction: 'forward', confidence: 0.9, weakSignal: false, reasoning: '需求传导', shouldKeep: true };
const completion = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] }));

const cases = [
  // causal 抽取默认走 v3 逐条协议（CAUSAL_PROTOCOL_MODE 未设置 = items）。
  { name: 'causal', value: { items: [{ newsId: 'n1', status: 'signals', signals: [signal] }] }, invoke: (env: NodeJS.ProcessEnv) => createCausalSignalExtractorFromEnv(env).extract(input) },
  { name: 'keywords', value: keywordPayload, invoke: (env: NodeJS.ProcessEnv) => createAiStockKeywordRequesterFromEnv(env).requestKeywords({ stocks: [stock], prompt: 'keywords', model: 'ignored', promptVersion: 'test' }) },
  { name: 'relationships', value: { decisions: [decision] }, invoke: (env: NodeJS.ProcessEnv) => createFriendNetworkLlmAiAdapterFromEnv(env).judge([relationship]) },
  { name: 'exposures', value: { candidates: [{ keyword: '白银', exposureType: 'industry_exposure', sourceId: 'n1', evidenceText: news.title, confidence: 0.9 }] }, invoke: (env: NodeJS.ProcessEnv) => createExposureCandidateExtractorFromEnv(env).extract({ limitUpCase: { symbol: stock.symbol, stockName: stock.name, tradeDate: asOf }, news: [news] }) },
];

describe('all four AI entrypoints', () => {
  it.each(cases)('$name uses the shared file and switches on malformed output', async item => {
    const fetchMock = vi.fn().mockResolvedValueOnce(completion({})).mockResolvedValueOnce(completion(item.value));
    vi.stubGlobal('fetch', fetchMock);
    const result = await item.invoke(environment());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(call => JSON.parse(call[1].body).model)).toEqual(['m1', 'm2']);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://p1.example/v1/chat/completions');
    expect((result as { aiSource?: unknown }).aiSource).toEqual({ providerId: 'p1', model: 'm2', modelVersion: '["p1","m2"]' });
  });

  it.each(cases)('$name exhausts the same six candidates once', async item => {
    const fetchMock = vi.fn().mockImplementation(async () => completion({}));
    vi.stubGlobal('fetch', fetchMock);
    await expect(item.invoke(environment())).rejects.toThrow('All AI candidates failed');
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each([
    { index: 0, invalid: { items: [{ newsId: 'n1', status: 'signals', signals: [{ ...signal, evidenceOffsetStart: 'bad' }] }] } },
    { index: 1, invalid: { stocks: [{ symbol: stock.symbol, keywords: [] }] } },
    { index: 2, invalid: { decisions: [{ ...decision, reasoning: '' }] } },
    { index: 3, invalid: { candidates: [{ keyword: '白银', exposureType: 'industry_exposure', sourceId: 'n1', evidenceText: news.title, confidence: 0.9, aliasSuggestions: [null] }] } },
  ])('switches instead of manufacturing defaults for malformed nested output ($index)', async ({ index, invalid }) => {
    const item = cases[index]!;
    const fetchMock = vi.fn().mockResolvedValueOnce(completion(invalid)).mockResolvedValueOnce(completion(item.value));
    vi.stubGlobal('fetch', fetchMock);
    await item.invoke(environment());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not split stock batches or write facts after chain exhaustion', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const prisma = { stock: { findMany: async () => [stock, { ...stock, symbol: '600002' }] }, stockExposureFact: { createMany: vi.fn() } };
    await expect(new AiStockKeywordGenerationService(createAiStockKeywordRequesterFromEnv(environment())).generate(prisma, { clusterKey: 'global', asOf })).rejects.toThrow('All AI candidates failed');
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(prisma.stockExposureFact.createMany).not.toHaveBeenCalled();
  });

  it('records the actual successful model in stock facts and the result summary', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(completion({})).mockResolvedValueOnce(completion(keywordPayload));
    vi.stubGlobal('fetch', fetchMock);
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = { stock: { findMany: async () => [stock] }, stockExposureFact: { createMany } };
    const result = await new AiStockKeywordGenerationService(createAiStockKeywordRequesterFromEnv(environment())).generate(prisma, { clusterKey: 'global', asOf });
    expect(result.modelVersion).toBe('["p1","m2"]');
    expect(createMany.mock.calls[0]?.[0].data[0].evidenceJson).toMatchObject({ providerId: 'p1', model: 'm2', modelVersion: '["p1","m2"]' });
  });

  it('keeps alternate model provenance on cache hits and invalidates cache when the chain changes', async () => {
    const rows: any[] = [];
    const prisma = { causalSignalCandidate: {
      findMany: vi.fn(async ({ where }: any) => rows.filter(row => row.clusterKey === where.clusterKey && where.inputFingerprint.in.includes(row.inputFingerprint)
        && where.modelVersion.in.includes(row.modelVersion) && row.promptVersion === where.promptVersion && row.asOf <= where.asOf.lte)),
      createMany: vi.fn(async ({ data }: any) => { rows.push(...data); return { count: data.length }; }),
    } };
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockImplementation(async () => completion({ items: [{ newsId: 'n1', status: 'signals', signals: [signal] }] }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new CausalSignalExtractionService(createCausalSignalExtractorFromEnv(environment()));
    await service.execute(prisma, input);
    expect(rows[0].modelVersion).toBe('["p1","m2"]');
    const cached = await service.execute(prisma, { ...input, traceId: 'trace-2' });
    expect(cached.cacheHitCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rows[1].modelVersion).toBe('["p1","m2"]');
    const changed = new CausalSignalExtractionService(createCausalSignalExtractorFromEnv(environment(true)));
    expect((await changed.execute(prisma, input)).cacheHitCount).toBe(1);
    expect(rows[2].modelVersion).toBe('["p1","m2"]');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // A later extraction must not satisfy an earlier asOf replay.
    await changed.execute(prisma, { ...input, asOf: new Date('2026-06-01T10:00:00Z') });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('records source metadata for successful empty extractions and bounds ledger reads by asOf', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(completion({})).mockResolvedValueOnce(completion({ items: [{ newsId: 'n1', status: 'no_signal', signals: [] }] }));
    vi.stubGlobal('fetch', fetchMock);
    const execute = vi.fn().mockResolvedValue(1);
    const query = vi.fn().mockResolvedValue([]);
    const prisma = { $queryRawUnsafe: query, $executeRawUnsafe: execute, causalSignalCandidate: { findMany: async () => [], createMany: vi.fn() } };
    const result = await new CausalSignalExtractionService(createCausalSignalExtractorFromEnv(environment())).execute(prisma, input);
    expect(result.candidateCount).toBe(0);
    expect(query.mock.calls[0]?.[0]).toContain('"fetchedAt" <= $6');
    const serializedArguments = JSON.stringify(execute.mock.calls[0]);
    expect(serializedArguments).toContain('providerId');
    expect(serializedArguments).toContain('m2');
    expect(prisma.causalSignalCandidate.createMany).not.toHaveBeenCalled();
  });
});
