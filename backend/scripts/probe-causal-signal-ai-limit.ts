import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';

import {
  createCausalSignalExtractorFromEnv,
  type ICausalSignalExtractionNews,
} from '../src/services/causal-signal-extraction-service.js';
import { loadBackendEnv } from '../src/services/load-backend-env.js';

loadBackendEnv();

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://gupiao:password@localhost:5432/gupiaodb';
const DEFAULT_AS_OF = '2026-05-24T15:59:59.999Z';
const DEFAULT_CLUSTER_KEY = 'global';
const DEFAULT_BATCH_SIZES = [1, 2, 3, 4, 5, 6, 8, 10, 12];
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_SAMPLE_LIMIT = 24;
const DEFAULT_SCAN_LIMIT = 500;
const CAUSAL_EXTRACTION_KEYWORD_PATTERN = /(需求|订单|销量|销售|消费|装机|采购|交付|出口|中标|库存|产量|产能|供应|供给|不足|下降|减少|紧张|短缺|瓶颈|受限|价格|报价|现货|期货|上涨|涨价|大涨|突破|新高|资金|成交|融资|增持|回购|政策|补贴|支持|推进|促进|审批|准入|许可|白银|黄金|铜|铝|锂|镍|稀土|煤炭|石油|天然气|电力|光伏|新能源|储能|电池|芯片|半导体|机器人|算力|医药|创新药|化工|航运|航空|军工)/u;

const parseArgs = (): Record<string, string> => {
  const parsed: Record<string, string> = {};
  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    parsed[token.slice(2)] = process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
      ? process.argv[++index]
      : 'true';
  }
  return parsed;
};

const parseBatchSizes = (raw: string | undefined): readonly number[] => {
  if (!raw) {
    return DEFAULT_BATCH_SIZES;
  }
  const values = raw.split(',').map(value => Number(value.trim())).filter(value => Number.isInteger(value) && value > 0);
  if (values.length === 0) {
    throw new Error(`Invalid --batch-sizes: ${raw}`);
  }
  return values;
};

const getAsOf = (raw: string | undefined): Date => {
  const asOf = new Date(raw ?? DEFAULT_AS_OF);
  if (Number.isNaN(asOf.getTime())) {
    throw new Error(`Invalid --as-of: ${raw}`);
  }
  return asOf;
};

const truncateContent = (value: string): string => value.length > 240 ? value.slice(0, 240) : value;

const estimateRequestChars = (news: readonly ICausalSignalExtractionNews[]): number => {
  const payload = news.map(item => ({
    newsId: item.id,
    title: item.title,
    content: truncateContent(item.content),
    source: item.source,
  }));
  return JSON.stringify(payload, null, 2).length;
};

async function main(): Promise<void> {
  const args = parseArgs();
  const asOf = getAsOf(args['as-of']);
  const clusterKey = args.cluster ?? DEFAULT_CLUSTER_KEY;
  const batchSizes = parseBatchSizes(args['batch-sizes']);
  const sampleLimit = Number(args['sample-limit'] ?? DEFAULT_SAMPLE_LIMIT);
  const scanLimit = Number(args['scan-limit'] ?? DEFAULT_SCAN_LIMIT);
  const timeoutMs = Number(args.timeoutMs ?? process.env.CAUSAL_SIGNAL_LLM_REQUEST_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  if (process.env.CAUSAL_SIGNAL_EXTRACTOR !== 'llm') {
    throw new Error('AI 上限探测必须显式设置 CAUSAL_SIGNAL_EXTRACTOR=llm，禁止隐式降级。');
  }
  process.env.CAUSAL_SIGNAL_LLM_REQUEST_TIMEOUT_MS = String(Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS);

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL }),
  });
  const pgClient = new pg.Client({ connectionString: DATABASE_URL });
  await pgClient.connect();

  try {
    const rows = await prisma.normalizedNewsRecord.findMany({
      where: {
        clusterKey,
        publishedAt: { lte: asOf },
      },
      orderBy: { publishedAt: 'desc' },
      take: Number.isFinite(scanLimit) ? scanLimit : DEFAULT_SCAN_LIMIT,
    });
    const candidates: ICausalSignalExtractionNews[] = rows
      .filter(row => CAUSAL_EXTRACTION_KEYWORD_PATTERN.test(`${row.title} ${row.content}`))
      .slice(0, Number.isFinite(sampleLimit) ? sampleLimit : DEFAULT_SAMPLE_LIMIT)
      .map(row => ({
        id: row.id,
        title: row.title,
        content: row.content,
        source: row.source,
        publishedAt: row.publishedAt,
        reprintWeight: row.reprintWeight,
      }));

    if (candidates.length === 0) {
      throw new Error('没有可用于 AI 上限探测的候选新闻。请先完成新闻落库和清洗。');
    }

    const extractor = createCausalSignalExtractorFromEnv();
    const results: Array<Record<string, unknown>> = [];

    console.log(`AI 上限探测开始`);
    console.log(`asOf=${asOf.toISOString()} cluster=${clusterKey} model=${extractor.modelVersion} timeoutMs=${process.env.CAUSAL_SIGNAL_LLM_REQUEST_TIMEOUT_MS}`);
    console.log(`候选新闻=${candidates.length} batchSizes=${batchSizes.join(',')}`);

    for (const batchSize of batchSizes) {
      const news = candidates.slice(0, Math.min(batchSize, candidates.length));
      const startedAt = Date.now();
      try {
        const signals = await extractor.extract({
          traceId: `probe-${Date.now()}-${batchSize}`,
          asOf,
          clusterKey,
          news,
          batchSize,
        });
        const elapsedMs = Date.now() - startedAt;
        const row = {
          batchSize,
          status: 'ok',
          elapsedMs,
          requestChars: estimateRequestChars(news),
          signalCount: signals.length,
        };
        results.push(row);
        console.log(JSON.stringify(row));
      }
      catch (error) {
        const elapsedMs = Date.now() - startedAt;
        const row = {
          batchSize,
          status: 'failed',
          elapsedMs,
          requestChars: estimateRequestChars(news),
          error: error instanceof Error ? error.message : String(error),
        };
        results.push(row);
        console.log(JSON.stringify(row));
        break;
      }
    }

    const successful = results.filter(row => row.status === 'ok');
    const stableThresholdMs = (Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS) * 0.6;
    const stable = successful.filter(row =>
      typeof row.elapsedMs === 'number' && row.elapsedMs <= stableThresholdMs,
    );
    const recommended = stable.length > 0
      ? stable[stable.length - 1]?.batchSize
      : successful[0]?.batchSize ?? null;
    console.log(JSON.stringify({
      recommendedBatchSize: recommended,
      stableThresholdMs,
      rule: '固定为 elapsedMs <= timeoutMs * 0.6 的最大成功 batchSize；所有成功项都超阈值时取最小成功 batchSize。',
      results,
    }, null, 2));

    const dbCheck = await pgClient.query(
      'SELECT count(*)::int AS normalized_news FROM "NormalizedNewsRecord" WHERE "clusterKey" = $1 AND "publishedAt" <= $2',
      [clusterKey, asOf],
    );
    console.log(`DB 核验 normalized_news=${dbCheck.rows[0]?.normalized_news}`);
  }
  finally {
    await pgClient.end();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
