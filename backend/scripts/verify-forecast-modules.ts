/**
 * 验证脚本：用已有历史 trace 跑预期差 + 主题预测，检查数据流是否正确。
 * 不重新抓新闻，只复用已落库的 GraphSnapshot + CausalSignalCandidate。
 *
 * 用法：bun run scripts/verify-forecast-modules.ts --trace-id <traceId>
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { ExpectationGapService } from '../src/services/expectation-gap-service.js';
import { ThemeForecastService } from '../src/services/theme-forecast-service.js';
import { loadBackendEnv } from '../src/services/load-backend-env.js';

loadBackendEnv();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('错误：缺少 DATABASE_URL 环境变量');
  process.exit(1);
}

const parseArgs = (): Record<string, string> => {
  const parsed: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i += 1) {
    const token = process.argv[i];
    if (!token.startsWith('--')) continue;
    parsed[token.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
      ? process.argv[++i]
      : 'true';
  }
  return parsed;
};

async function main(): Promise<void> {
  const args = parseArgs();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });

  // 找最近的含 CausalSignal 的成功 trace
  let traceId = args['trace-id'];
  let asOf: Date;
  let clusterKey: string;

  if (traceId) {
    const trace = await prisma.runTrace.findUnique({ where: { traceId } });
    if (!trace) {
      console.error(`trace ${traceId} 不存在`);
      process.exit(1);
    }
    asOf = trace.asOf ?? new Date();
    clusterKey = trace.clusterKey ?? 'global';
  } else {
    // 自动找最近含 CausalSignal + GraphSnapshot 的 trace
    const traces = await prisma.runTrace.findMany({
      where: { status: 'SUCCESS', kind: 'DAILY_RECOMMENDATION' },
      orderBy: { asOf: 'desc' },
      take: 10,
    });
    for (const t of traces) {
      const [signalCount, graphCount] = await Promise.all([
        prisma.causalSignalCandidate.count({ where: { traceId: t.traceId, status: 'candidate' } }),
        prisma.graphSnapshot.count({ where: { traceId: t.traceId } }),
      ]);
      if (signalCount > 0 && graphCount > 0) {
        traceId = t.traceId;
        asOf = t.asOf ?? new Date();
        clusterKey = t.clusterKey ?? 'global';
        console.log(`自动选择 trace: ${traceId} (signals=${signalCount}, graphs=${graphCount})`);
        break;
      }
    }
    if (!traceId) {
      console.error('未找到同时含 CausalSignal 和 GraphSnapshot 的成功 trace');
      process.exit(1);
    }
  }

  console.log(`\n=== 验证 traceId=${traceId} asOf=${asOf.toISOString()} cluster=${clusterKey} ===\n`);

  // 1. 检查前置数据
  const [signalCount, graphCount, exposureCount, candleCount] = await Promise.all([
    prisma.causalSignalCandidate.count({ where: { traceId, status: 'candidate' } }),
    prisma.graphSnapshot.count({ where: { traceId } }),
    prisma.stockExposureFact.count({ where: { clusterKey, status: 'active' } }),
    prisma.candle.count(),
  ]);
  console.log(`前置数据：CausalSignal=${signalCount} GraphSnapshot=${graphCount} ExposureFact=${exposureCount} Candle=${candleCount}`);

  // 2. 跑预期差
  console.log('\n--- 预期差（ExpectationGap）---');
  const gapResult = await new ExpectationGapService().calculate(prisma, { traceId, asOf, clusterKey });
  console.log(`snapshotCount=${gapResult.snapshotCount} weakSignalCount=${gapResult.weakSignalCount}`);
  if (gapResult.topGaps.length > 0) {
    console.log('Top 5 预期差关键词：');
    for (const gap of gapResult.topGaps.slice(0, 5)) {
      console.log(`  ${gap.keyword}: graphStrength=${gap.graphStrength.toFixed(3)} priceReaction=${(gap.priceReaction * 100).toFixed(2)}% gap=${gap.expectationGap.toFixed(3)} weak=${gap.isWeakSignal} symbols=${gap.relatedSymbols.length}`);
    }
  }

  // 3. 跑主题预测
  console.log('\n--- 主题预测（ThemeForecast）---');
  const forecastResult = await new ThemeForecastService().generate(prisma, { traceId, asOf, clusterKey });
  console.log(`forecastCount=${forecastResult.forecastCount} bullish=${forecastResult.bullishCount} bearish=${forecastResult.bearishCount}`);
  if (forecastResult.topForecasts.length > 0) {
    console.log('Top 5 主题预测：');
    for (const f of forecastResult.topForecasts.slice(0, 5)) {
      const arrow = f.direction === 'bullish' ? '↑' : f.direction === 'bearish' ? '↓' : '→';
      console.log(`  ${arrow} ${f.theme}: direction=${f.direction} probability=${(f.probability * 100).toFixed(0)}% signalStrength=${f.signalStrength.toFixed(3)} gap=${f.expectationGap.toFixed(3)} weak=${f.evidenceChain.weakSignal} symbols=${f.relatedSymbols.slice(0, 3).join(',')}`);
    }
  }

  // 4. 验证落库
  const [persistedGaps, persistedForecasts] = await Promise.all([
    prisma.expectationGapSnapshot.count({ where: { traceId } }),
    prisma.themeForecast.count({ where: { traceId } }),
  ]);
  console.log(`\n=== 落库验证：ExpectationGapSnapshot=${persistedGaps} ThemeForecast=${persistedForecasts} ===`);

  await prisma.$disconnect();
}

void main().catch((error) => {
  console.error('验证失败：', error);
  process.exitCode = 1;
});
