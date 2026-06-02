import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { BacktestEngine } from '../src/services/backtest-engine.js';

type ReplaySource = 'run-trace' | 'snapshot-fallback';

interface IReplayParams {
  readonly source: ReplaySource;
  readonly asOf: Date;
  readonly clusterKey: string;
  readonly scoringProfile: 'short_news' | 'industry_cycle' | 'fundamental_theme';
  readonly halfLifeDays: number;
  readonly maxWindowDays: number;
  readonly recommendationLimit: number;
  readonly maxPerIndustry: number;
  readonly fallbackReason?: string;
}

interface IReplayComparisonItem {
  readonly rank: number;
  readonly symbol: string;
  readonly finalScore: number;
  readonly scoreBreakdown: Record<string, unknown>;
}

const DEFAULT_PROFILE = 'short_news';
const DEFAULT_HALF_LIFE_DAYS = 2;
const DEFAULT_MAX_WINDOW_DAYS = 7;
const DEFAULT_LIMIT = 30;
const DEFAULT_MAX_PER_INDUSTRY = 5;

const resolveDatabaseUrl = (): string => {
  const candidate = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5432/gupiaodb';
  return candidate;
};

const parseArgs = (argv: readonly string[]): { traceId: string } => {
  const traceIdIndex = argv.indexOf('--traceId');
  if (traceIdIndex === -1 || !argv[traceIdIndex + 1]) {
    console.error('用法: bun run scripts/replay.ts --traceId <TRACE_ID>');
    process.exit(1);
  }
  return { traceId: argv[traceIdIndex + 1] };
};

const isProfile = (value: unknown): value is IReplayParams['scoringProfile'] => {
  return value === 'short_news' || value === 'industry_cycle' || value === 'fundamental_theme';
};

const readDate = (value: unknown): Date | undefined => {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const readNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const readObject = (value: unknown): Record<string, unknown> => {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
};

const normalizeComparisonItem = (rec: any): IReplayComparisonItem => {
  return {
    rank: rec.rank,
    symbol: rec.symbol,
    finalScore: Number(rec.finalScore),
    scoreBreakdown: readObject(rec.scoreBreakdown),
  };
};

const pickStepSummary = (
  steps: readonly any[],
  stepName: string,
  summaryKind: 'inputSummary' | 'outputSummary',
): Record<string, unknown> => {
  const step = steps.find((item) => item.stepName === stepName);
  return readObject(step?.[summaryKind]);
};

export const resolveReplayParamsFromTrace = (
  runTrace: any,
): IReplayParams | undefined => {
  if (!runTrace) {
    return undefined;
  }

  const steps = Array.isArray(runTrace.steps) ? runTrace.steps : [];
  const scoringInput = pickStepSummary(steps, 'scoring', 'inputSummary');
  const scoringOutput = pickStepSummary(steps, 'scoring', 'outputSummary');
  const recommendationInput = pickStepSummary(steps, 'recommendation', 'inputSummary');

  const asOf = readDate(scoringInput.asOf) ?? readDate(runTrace.asOf);
  const clusterKey = typeof scoringInput.clusterKey === 'string'
    ? scoringInput.clusterKey
    : typeof runTrace.clusterKey === 'string'
      ? runTrace.clusterKey
      : undefined;
  const profileValue = scoringInput.profile ?? scoringInput.scoringProfile ?? scoringOutput.profileUsed;
  const scoringProfile = isProfile(profileValue) ? profileValue : undefined;
  const halfLifeDays = readNumber(scoringInput.halfLifeDays) ?? readNumber(scoringOutput.halfLifeDaysUsed);
  const maxWindowDays = readNumber(scoringInput.maxWindowDays) ?? readNumber(scoringOutput.maxWindowDaysUsed);
  const recommendationLimit = readNumber(recommendationInput.limit);
  const maxPerIndustry = readNumber(recommendationInput.maxPerIndustry);

  if (!asOf || !clusterKey || !scoringProfile || !halfLifeDays || !maxWindowDays || !recommendationLimit || !maxPerIndustry) {
    return undefined;
  }

  return {
    source: 'run-trace',
    asOf,
    clusterKey,
    scoringProfile,
    halfLifeDays,
    maxWindowDays,
    recommendationLimit,
    maxPerIndustry,
  };
};

export const resolveReplayParamsFromSnapshot = (historicalRecs: readonly any[]): IReplayParams | undefined => {
  const baseRec = historicalRecs[0];
  if (!baseRec) {
    return undefined;
  }

  const scoreBreakdown = readObject(baseRec.scoreBreakdown);
  const profileValue = scoreBreakdown.scoringProfile;

  return {
    source: 'snapshot-fallback',
    asOf: baseRec.asOf,
    clusterKey: baseRec.clusterKey,
    scoringProfile: isProfile(profileValue) ? profileValue : DEFAULT_PROFILE,
    halfLifeDays: readNumber(scoreBreakdown.halfLifeDaysUsed) ?? DEFAULT_HALF_LIFE_DAYS,
    maxWindowDays: readNumber(scoreBreakdown.maxWindowDaysUsed) ?? DEFAULT_MAX_WINDOW_DAYS,
    recommendationLimit: historicalRecs.length || DEFAULT_LIMIT,
    maxPerIndustry: DEFAULT_MAX_PER_INDUSTRY,
    fallbackReason: 'RunTrace 或 PipelineStepTrace 不完整，已降级使用 RecommendationSnapshot.scoreBreakdown',
  };
};

export const resolveReplayParams = (
  runTrace: any,
  historicalRecs: readonly any[],
): IReplayParams | undefined => {
  return resolveReplayParamsFromTrace(runTrace) ?? resolveReplayParamsFromSnapshot(historicalRecs);
};

export const createReplayComparisonSnapshot = (records: readonly any[]): IReplayComparisonItem[] => {
  return records.map(normalizeComparisonItem);
};

async function main() {
  const { traceId } = parseArgs(process.argv);
  const databaseUrl = resolveDatabaseUrl();

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });

  try {
    console.log(`\n========================================`);
    console.log(`开始执行 TraceId 全链路幂等 Replay 追溯`);
    console.log(`   原始 TraceId: ${traceId}`);
    console.log(`========================================\n`);

    const [runTrace, historicalRecs] = await Promise.all([
      prisma.runTrace.findUnique({
        where: { traceId },
        include: { steps: true },
      }),
      prisma.recommendationSnapshot.findMany({
        where: { traceId },
        orderBy: { rank: 'asc' },
      }),
    ]);

    if (historicalRecs.length === 0) {
      console.error(`未能在数据库中找到 TraceId: ${traceId} 的推荐快照。无法 Replay。`);
      process.exit(1);
    }

    const replayParams = resolveReplayParams(runTrace, historicalRecs);
    if (!replayParams) {
      console.error(`未能从 RunTrace 或 RecommendationSnapshot 恢复 Replay 参数。`);
      process.exit(1);
    }

    if (replayParams.source === 'snapshot-fallback') {
      console.warn(`提示: ${replayParams.fallbackReason}`);
    }

    console.log(`提取到 Replay 配置 (${replayParams.source}):`);
    console.log(`   - 集团隔离键 (clusterKey): ${replayParams.clusterKey}`);
    console.log(`   - 回测时间基准 (asOf): ${replayParams.asOf.toISOString()}`);
    console.log(`   - 固化评分模式 (profile): ${replayParams.scoringProfile}`);
    console.log(`   - 固化半衰期天数 (halfLife): ${replayParams.halfLifeDays}天`);
    console.log(`   - 固化历史窗口天数 (window): ${replayParams.maxWindowDays}天`);
    console.log(`   - 推荐数量上限 (limit): ${replayParams.recommendationLimit}`);
    console.log(`   - 单主信号类型上限 (maxPerIndustry): ${replayParams.maxPerIndustry}`);
    console.log(`----------------------------------------`);

    const replayTraceId = `replay-temp-${Date.now()}`;
    const backtestEngine = new BacktestEngine();

    console.log(`\n重新拉起 Backtest 时间沙盒 Pipeline 计算...`);
    const replayResult = await backtestEngine.runBacktest(prisma, {
      traceId: replayTraceId,
      asOf: replayParams.asOf,
      clusterKey: replayParams.clusterKey,
      scoringProfile: replayParams.scoringProfile,
      halfLifeDays: replayParams.halfLifeDays,
      maxWindowDays: replayParams.maxWindowDays,
      recommendationLimit: replayParams.recommendationLimit,
      maxPerIndustry: replayParams.maxPerIndustry,
    });

    console.log(`Pipeline 计算完成。生成了 ${replayResult.recommendationsCreated} 个重放推荐记录。`);

    const replayedRecs = await prisma.recommendationSnapshot.findMany({
      where: { traceId: replayTraceId },
      orderBy: { rank: 'asc' },
    });

    await prisma.recommendationSnapshot.deleteMany({ where: { traceId: replayTraceId } });
    await prisma.stockFeatureSnapshot.deleteMany({ where: { traceId: replayTraceId } });
    await prisma.evidenceContribution.deleteMany({ where: { traceId: replayTraceId } });
    await prisma.runTrace.deleteMany({ where: { traceId: replayTraceId } });

    console.log(`\n开始执行 symbol/rank/finalScore/scoreBreakdown 幂等校验...`);

    const historicalSnapshot = createReplayComparisonSnapshot(historicalRecs);
    const replayedSnapshot = createReplayComparisonSnapshot(replayedRecs);

    if (historicalSnapshot.length !== replayedSnapshot.length) {
      console.error(`Replay 校验失败: 推荐股票数量不一致。历史: ${historicalSnapshot.length} 只, 重放: ${replayedSnapshot.length} 只。`);
      process.exit(1);
    }

    let allMatch = true;
    for (let i = 0; i < historicalSnapshot.length; i++) {
      const hist = historicalSnapshot[i];
      const repl = replayedSnapshot[i];
      const scoreDiff = Math.abs(hist.finalScore - repl.finalScore);
      const breakdownMatch = JSON.stringify(hist.scoreBreakdown) === JSON.stringify(repl.scoreBreakdown);

      if (hist.symbol === repl.symbol && hist.rank === repl.rank && scoreDiff < 0.0001 && breakdownMatch) {
        console.log(`   [Pass] Rank #${hist.rank}: ${hist.symbol} -> 历史分: ${hist.finalScore.toFixed(4)} | 重放分: ${repl.finalScore.toFixed(4)}`);
      }
      else {
        console.error(`   [FAIL] Rank #${hist.rank} 出现偏差。`);
        console.error(`          历史: ${hist.symbol} 得分: ${hist.finalScore.toFixed(4)}`);
        console.error(`          重放: ${repl.symbol} 得分: ${repl.finalScore.toFixed(4)}`);
        console.error(`          scoreBreakdown 是否一致: ${breakdownMatch}`);
        allMatch = false;
      }
    }

    if (allMatch) {
      console.log(`\n========================================`);
      console.log(`Replay Match Successfully.`);
      console.log(`   历史 symbol/rank/finalScore/scoreBreakdown 与重放结果一致。`);
      console.log(`========================================\n`);
    }
    else {
      console.error(`\nReplay 失败: 数据发生漂移偏差，请排查状态或未来函数泄漏。`);
      process.exit(1);
    }
  }
  catch (error) {
    console.error('Replay 执行遭遇异常:', error);
    process.exit(1);
  }
  finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
