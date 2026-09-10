/**
 * M3 batch planner benchmark baseline.
 *
 * Generates a fixed synthetic news snapshot + fixed providers and prints:
 *  - fixed 3-per-batch baseline
 *  - planAiBatch (new planner)
 * Report JSON goes to data/reports/batch-benchmark-<ts>.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { planAiBatch } from '../src/services/ai-batch-planner.js';
import type { IAiProviderConfig } from '../src/services/ai-provider-config.js';
import type { ICausalSignalExtractionNews } from '../src/services/causal-signal-extraction-service.js';

interface BenchmarkReportItem {
  readonly name: string;
  readonly requests: number;
  readonly coverage: number;
  readonly latencyMs: number;
  readonly tokens: number;
  readonly retries: number;
}

const seededRand = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const buildMockNews = (count: number, seed: number): readonly ICausalSignalExtractionNews[] => {
  const rand = seededRand(seed);
  const samples = ['库存下降', '政策推进', '装机增长', '价格回落', '供给收紧'];
  return Array.from({ length: count }, (_, i) => ({
    id: `news-${i + 1}`,
    title: `synthetic title ${samples[Math.floor(rand() * samples.length)]} ${i}`,
    content: `synthetic content ${samples[(i + 1) % samples.length]} for ${i}`,
    source: 'mock',
    publishedAt: new Date('2026-01-02T00:00:00Z'),
    reprintWeight: rand() < 0.1 ? 0.15 : 1,
  }));
};

const buildConfig = (): IAiProviderConfig => ({
  providers: [{
    id: 'mock-provider',
    baseUrl: 'http://mock.local',
    apiKey: 'mock',
    limits: { initialConcurrency: 2, maxConcurrency: 5, contextTokens: 128000 },
    models: [{ id: 'mock-model', limits: { contextTokens: 128000 } }],
  }],
  scheduling: { globalConcurrency: 8, runTimeoutMs: 3600000, maxAttempts: 24, initialBatchSize: 8, maxBatchSize: 64 },
  batching: { targetInputTokens: 20000, maxInputTokens: 64000, outputTokens: 8192 },
});

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const seed = Number(args.find(a => a.startsWith('--seed='))?.split('=')[1] ?? 42);
  const count = Number(args.find(a => a.startsWith('--count='))?.split('=')[1] ?? 300);
  const news = buildMockNews(count, seed);
  const config = buildConfig();
  const rand = seededRand(seed + 101);

  const fixedRequests = Math.ceil(news.length / 3);
  const fixedReport: BenchmarkReportItem = {
    name: 'fixed-3',
    requests: fixedRequests,
    coverage: news.length,
    latencyMs: fixedRequests * (900 + rand() * 100),
    tokens: news.length * 20,
    retries: 0,
  };

  let coverage = 0;
  let requests = 0;
  let latencyMs = 0;
  let tokens = 0;
  let cursor = 0;
  const window = news.slice(0, news.length);
  while (cursor < window.length) {
    const plan = planAiBatch(window.slice(cursor), config, [], { now: Date.now() + requests * 250 });
    if (plan.count <= 0) throw new Error('planner returned zero in benchmark');
    coverage += plan.count;
    requests += 1;
    latencyMs += plan.predictedLatencyMs || 900;
    tokens += (plan.outputTokens || 0) + (plan.inputTokens || 0);
    cursor += plan.count;
  }
  const plannerReport: BenchmarkReportItem = {
    name: 'planner-new',
    requests,
    coverage,
    latencyMs,
    tokens,
    retries: 0,
  };

  const summary = {
    generatedAt: new Date().toISOString(),
    deterministic: true,
    seed,
    newsCount: news.length,
    reports: [fixedReport, plannerReport],
  };
  const outDir = path.resolve('data/reports');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `batch-benchmark-${Date.now()}.json`);
  writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`report: ${outFile}`);
};

await main();
