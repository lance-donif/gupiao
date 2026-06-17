import { Prisma } from '@prisma/client';
import { ScoringContributionEngine } from './scoring-contribution-engine.js';
import { TempStockRecommendationService } from './temp-stock-recommendation-service.js';
import { TraceManager } from './trace-manager.js';
import { StrategyExperimentRunner } from './strategy-runner.js';

export interface IBacktestRunInput {
  readonly traceId: string;
  readonly asOf: Date;
  readonly clusterKey: string;
  readonly manageTrace?: boolean;
  readonly newsWindowDays?: number;
  readonly recommendationLimit?: number;
  readonly maxPerIndustry?: number;

  // 动态打分 Profile 配置
  readonly scoringProfile?: 'short_news' | 'industry_cycle' | 'fundamental_theme';
  readonly halfLifeDays?: number;
  readonly maxWindowDays?: number;
}

export interface IBacktestReplayTraceSummary {
  readonly asOf: Date;
  readonly clusterKey: string;
  readonly profile: string;
  readonly halfLifeDays: number;
  readonly maxWindowDays: number;
  readonly limit: number;
  readonly maxPerIndustry: number;
  readonly newsWindowDays: number;
}

export interface IBacktestRunResult {
  readonly traceId: string;
  readonly asOf: Date;
  readonly recommendationsCreated: number;
  readonly reconciledCount: number;
  readonly profileUsed: string;
  readonly halfLifeDaysUsed: number;
  readonly maxWindowDaysUsed: number;
}

const resolveBacktestReplayTraceSummary = (input: IBacktestRunInput): IBacktestReplayTraceSummary => {
  const newsWindowDays = input.newsWindowDays ?? 7;
  const limit = input.recommendationLimit ?? 30;
  const maxPerIndustry = input.maxPerIndustry ?? 5;

  let profile = input.scoringProfile ?? 'short_news';
  let halfLifeDays = input.halfLifeDays;
  let maxWindowDays = input.maxWindowDays;

  if (!halfLifeDays || !maxWindowDays) {
    switch (profile) {
      case 'industry_cycle':
        halfLifeDays = halfLifeDays ?? 10;
        maxWindowDays = maxWindowDays ?? 30;
        break;
      case 'fundamental_theme':
        halfLifeDays = halfLifeDays ?? 30;
        maxWindowDays = maxWindowDays ?? 90;
        break;
      case 'short_news':
      default:
        profile = 'short_news';
        halfLifeDays = halfLifeDays ?? 2;
        maxWindowDays = maxWindowDays ?? 7;
        break;
    }
  }
  return {
    asOf: input.asOf,
    clusterKey: input.clusterKey,
    profile,
    halfLifeDays,
    maxWindowDays,
    limit,
    maxPerIndustry,
    newsWindowDays,
  };
};

export class BacktestEngine {
  private readonly scoringEngine = new ScoringContributionEngine();
  private readonly recommendationService = new TempStockRecommendationService();

  /**
   * 运行特定历史时点 asOf 下的隔离回测，防范未来函数漏水，并执行 T+1, T+3, T+5 行情对账
   */
  public async runBacktest(prisma: any, input: IBacktestRunInput): Promise<IBacktestRunResult> {
    const { traceId, asOf, clusterKey } = input;
    const replaySummary = resolveBacktestReplayTraceSummary(input);
    const { newsWindowDays, limit, maxPerIndustry } = replaySummary;
    const manageTrace = input.manageTrace ?? true;

    // 启动全局 RunTrace
    if (manageTrace) {
      await TraceManager.startRunTrace(prisma, traceId, clusterKey, 'BACKTEST', asOf);
    }

    let scoreResult: any;
    try {
      // 步骤 1：scoring
      await TraceManager.startStepTrace(prisma, traceId, 'scoring', {
        ...replaySummary,
        newsWindowDays,
      });

      scoreResult = await this.scoringEngine.execute(prisma, {
        traceId,
        asOf,
        clusterKey,
        newsWindowDays,
        scoringProfile: input.scoringProfile,
        halfLifeDays: input.halfLifeDays,
        maxWindowDays: input.maxWindowDays,
      });

      await TraceManager.completeStepTrace(prisma, traceId, 'scoring', {
        contributionCount: scoreResult.contributionCount,
        snapshotCount: scoreResult.snapshotCount,
        profileUsed: scoreResult.profileUsed,
        halfLifeDaysUsed: scoreResult.halfLifeDaysUsed,
        maxWindowDaysUsed: scoreResult.maxWindowDaysUsed,
        metrics: scoreResult.metrics ?? {},
      });
    }
    catch (err: any) {
      await TraceManager.failStepTrace(prisma, traceId, 'scoring', err.message);
      if (manageTrace) {
        await TraceManager.failRunTrace(prisma, traceId, `scoring failed: ${err.message}`);
      }
      throw err;
    }

    let recommendations: any;
    try {
      // 步骤 2：recommendation
      await TraceManager.startStepTrace(prisma, traceId, 'recommendation', {
        ...replaySummary,
        limit,
        maxPerIndustry,
      });

      const recommendationResult = await this.recommendationService.generatePhysicalRecommendationsWithDiagnostics(
        prisma,
        traceId,
        asOf,
        clusterKey,
        limit,
        maxPerIndustry,
      );
      recommendations = recommendationResult.recommendations;

      await TraceManager.completeStepTrace(prisma, traceId, 'recommendation', {
        recommendationsCreated: recommendations.length,
        selectionDiagnostics: recommendationResult.diagnostics,
        recommendations: recommendations.map((rec: any, index: number) => ({
          symbol: rec.symbol,
          rank: index + 1,
          finalScore: rec.score,
          scoreBreakdown: rec.scoreBreakdown,
        })),
      });
    }
    catch (err: any) {
      await TraceManager.failStepTrace(prisma, traceId, 'recommendation', err.message);
      if (manageTrace) {
        await TraceManager.failRunTrace(prisma, traceId, `recommendation failed: ${err.message}`);
      }
      throw err;
    }

    if (recommendations.length === 0) {
      if (manageTrace) {
        await TraceManager.completeRunTrace(prisma, traceId, {
          recommendationsCreated: 0,
          reconciledCount: 0,
          profileUsed: scoreResult.profileUsed,
        });
      }
      return {
        traceId,
        asOf,
        recommendationsCreated: 0,
        reconciledCount: 0,
        profileUsed: scoreResult.profileUsed,
        halfLifeDaysUsed: scoreResult.halfLifeDaysUsed,
        maxWindowDaysUsed: scoreResult.maxWindowDaysUsed,
      };
    }

    let reconciledCount = 0;
    try {
      // 步骤 3：reconciliation
      await TraceManager.startStepTrace(prisma, traceId, 'reconciliation', {
        ...replaySummary,
        recommendationsCount: recommendations.length,
      });

      const symbols = recommendations.map((rec: any) => String(rec.symbol));
      if (symbols.length > 0) {
        // 1. 批量查询股票记录
        const stocks = await prisma.stock.findMany({
          where: {
            clusterKey,
            symbol: { in: symbols },
          },
        });
        const stockMap = new Map<string, any>(stocks.map((s: any) => [s.symbol, s]));
        const stockIds = stocks.map((s: any) => s.id);

        // 2. 批量查询历史与未来 K 线 (基准价为 <= asOf 最后一天，未来价为 > asOf 5个交易日以内)
        const marginBefore = new Date(asOf.getTime() - 30 * 24 * 60 * 60 * 1000);
        const marginAfter = new Date(asOf.getTime() + 20 * 24 * 60 * 60 * 1000);
        const allCandles = await prisma.candle.findMany({
          where: {
            stockId: { in: stockIds },
            tradingDay: { gte: marginBefore, lte: marginAfter },
          },
          orderBy: { tradingDay: 'asc' },
        });

        const candlesByStockId = new Map<string, any[]>();
        for (const candle of allCandles) {
          const list = candlesByStockId.get(candle.stockId) ?? [];
          list.push(candle);
          candlesByStockId.set(candle.stockId, list);
        }

        // 3. 批量查询 Snapshots 详情以合并 scoreBreakdown
        const existingSnapshots = await prisma.recommendationSnapshot.findMany({
          where: {
            traceId,
            symbol: { in: symbols },
          },
        });
        const snapshotMap = new Map<string, any>(existingSnapshots.map((s: any) => [s.symbol, s]));

        const finalYieldsMap = new Map<string, number>(); // 用于后续计算策略统计指标
        const basePriceMap = new Map<string, number>();
        const futureCandlesMap = new Map<string, any[]>();
        const updates: any[] = [];

        const reconItems = calculateReconciliationData({
          recommendations,
          stockMap,
          candlesByStockId,
          snapshotMap,
          asOf,
          scoreResult,
        });

        for (const item of reconItems) {
          basePriceMap.set(item.symbol, item.p0);
          futureCandlesMap.set(item.symbol, item.futureCandles);
          if (item.finalYield !== null) {
            finalYieldsMap.set(item.symbol, item.finalYield);
          }

          updates.push(
            prisma.recommendationSnapshot.update({
              where: {
                traceId_symbol: {
                  traceId,
                  symbol: item.symbol,
                },
              },
              data: {
                realizedPrice: new Prisma.Decimal(item.p0),
                realizedPriceTarget: new Prisma.Decimal(item.realizedPriceTarget),
                yield1Day: item.yield1Day !== null ? new Prisma.Decimal(item.yield1Day) : null,
                yield3Day: item.yield3Day !== null ? new Prisma.Decimal(item.yield3Day) : null,
                yield5Day: item.yield5Day !== null ? new Prisma.Decimal(item.yield5Day) : null,
                scoreBreakdown: item.updatedBreakdown,
                isReconciled: true,
              },
            })
          );
          reconciledCount++;
        }

        if (updates.length > 0) {
          await prisma.$transaction(updates);
        }

        // 4. 运行所有启用的策略，生成对应的 StrategyRecommendationEvent 事件记录
        const strategyRunner = new StrategyExperimentRunner();
        await strategyRunner.runEnabledStrategies(prisma, {
          traceId,
          asOf,
          clusterKey,
        });

        // 5. 生成绩效评估报告 (StrategyPerformanceReport) 并持久化
        await generatePerformanceReports(prisma, {
          traceId,
          asOf,
          clusterKey,
          defaultYieldsMap: finalYieldsMap,
          basePriceMap,
          futureCandlesMap,
        });
      }

      await TraceManager.completeStepTrace(prisma, traceId, 'reconciliation', {
        reconciledCount,
      });
    }
    catch (err: any) {
      await TraceManager.failStepTrace(prisma, traceId, 'reconciliation', err.message);
      if (manageTrace) {
        await TraceManager.failRunTrace(prisma, traceId, `reconciliation failed: ${err.message}`);
      }
      throw err;
    }

    // 完成全局 RunTrace
    if (manageTrace) {
      await TraceManager.completeRunTrace(prisma, traceId, {
        recommendationsCreated: recommendations.length,
        reconciledCount,
        profileUsed: scoreResult.profileUsed,
      });
    }

    return {
      traceId,
      asOf,
      recommendationsCreated: recommendations.length,
      reconciledCount,
      profileUsed: scoreResult.profileUsed,
      halfLifeDaysUsed: scoreResult.halfLifeDaysUsed,
      maxWindowDaysUsed: scoreResult.maxWindowDaysUsed,
    };
  }
}

export interface IReconciliationItem {
  readonly symbol: string;
  readonly p0: number;
  readonly realizedPriceTarget: number;
  readonly yield1Day: number | null;
  readonly yield3Day: number | null;
  readonly yield5Day: number | null;
  readonly updatedBreakdown: any;
  readonly finalYield: number | null;
  readonly futureCandles: any[];
}

const calculateReconciliationData = (params: {
  readonly recommendations: readonly any[];
  readonly stockMap: Map<string, any>;
  readonly candlesByStockId: Map<string, any[]>;
  readonly snapshotMap: Map<string, any>;
  readonly asOf: Date;
  readonly scoreResult: {
    readonly profileUsed: string;
    readonly halfLifeDaysUsed: number;
    readonly maxWindowDaysUsed: number;
  };
}): IReconciliationItem[] => {
  const results: IReconciliationItem[] = [];
  for (const rec of params.recommendations) {
    const stock = params.stockMap.get(rec.symbol);
    if (!stock) continue;

    const stockCandles = params.candlesByStockId.get(stock.id) ?? [];
    const baseCandles = stockCandles
      .filter(c => c.tradingDay.getTime() <= params.asOf.getTime())
      .sort((left, right) => right.tradingDay.getTime() - left.tradingDay.getTime());
    const futureCandles = stockCandles
      .filter(c => c.tradingDay.getTime() > params.asOf.getTime())
      .sort((left, right) => left.tradingDay.getTime() - right.tradingDay.getTime());

    if (baseCandles.length === 0 || futureCandles.length === 0) {
      continue;
    }

    const p0 = Number(baseCandles[0].close);
    const p1Candle = futureCandles[0];
    const p3Candle = futureCandles.length >= 3 ? futureCandles[2] : null;
    const p5Candle = futureCandles.length >= 5 ? futureCandles[4] : null;

    const yield1Day = p1Candle ? (Number(p1Candle.close) - p0) / p0 : null;
    const yield3Day = p3Candle ? (Number(p3Candle.close) - p0) / p0 : null;
    const yield5Day = p5Candle ? (Number(p5Candle.close) - p0) / p0 : null;

    const realizedPriceTarget = p5Candle
      ? Number(p5Candle.close)
      : p3Candle
      ? Number(p3Candle.close)
      : Number(p1Candle.close);

    const finalYield = yield5Day !== null ? yield5Day : (yield3Day !== null ? yield3Day : (yield1Day !== null ? yield1Day : null));

    const currentSnapshot = params.snapshotMap.get(rec.symbol);
    const originalBreakdown = currentSnapshot ? (currentSnapshot.scoreBreakdown as any) : {};
    const updatedBreakdown = {
      ...originalBreakdown,
      scoringProfile: params.scoreResult.profileUsed,
      halfLifeDaysUsed: params.scoreResult.halfLifeDaysUsed,
      maxWindowDaysUsed: params.scoreResult.maxWindowDaysUsed,
    };

    results.push({
      symbol: rec.symbol,
      p0,
      realizedPriceTarget,
      yield1Day,
      yield3Day,
      yield5Day,
      updatedBreakdown,
      finalYield,
      futureCandles,
    });
  }
  return results;
};

async function generatePerformanceReports(
  prisma: any,
  input: {
    readonly traceId: string;
    readonly asOf: Date;
    readonly clusterKey: string;
    readonly defaultYieldsMap: Map<string, number>;
    readonly basePriceMap: Map<string, number>;
    readonly futureCandlesMap: Map<string, any[]>;
  }
): Promise<void> {
  if (!prisma.strategyPerformanceReport?.create) {
    return;
  }
  const { traceId, asOf, clusterKey, defaultYieldsMap, basePriceMap, futureCandlesMap } = input;

  // 1. 获取当天运行成功的所有 StrategyRun
  const strategyRuns = await prisma.strategyRun.findMany({
    where: {
      traceId,
      clusterKey,
      status: 'SUCCESS',
    },
    include: {
      recommendations: true,
    },
  });

  const reportsToUpsertArgs: any[] = [];

  // 2. 为每个策略运行计算指标
  for (const run of strategyRuns) {
    const recs = run.recommendations;
    if (recs.length === 0) {
      continue;
    }

    const yields: number[] = [];
    for (const rec of recs) {
      let y = defaultYieldsMap.get(rec.symbol);
      if (y === undefined) {
        const basePrice = basePriceMap.get(rec.symbol) ?? Number(rec.basePrice);
        const future = futureCandlesMap.get(rec.symbol) ?? [];
        if (basePrice > 0 && future.length > 0) {
          const p1 = future[0];
          const p3 = future.length >= 3 ? future[2] : null;
          const p5 = future.length >= 5 ? future[4] : null;
          const lastCandle = p5 ?? p3 ?? p1;
          if (lastCandle) {
            y = (Number(lastCandle.close) - basePrice) / basePrice;
          }
        }
      }
      if (y !== undefined && y !== null) {
        yields.push(y);
      }
    }

    const recCount = recs.length;
    if (yields.length === 0) {
      continue;
    }

    const winCount = yields.filter(y => y > 0).length;
    const winRate = winCount / yields.length;
    const avgReturn = yields.reduce((a, b) => a + b, 0) / yields.length;

    const positiveYields = yields.filter(y => y > 0);
    const negativeYields = yields.filter(y => y < 0);
    const avgPositive = positiveYields.length > 0 ? (positiveYields.reduce((a, b) => a + b, 0) / positiveYields.length) : 0;
    const avgNegative = negativeYields.length > 0 ? (negativeYields.reduce((a, b) => a + b, 0) / negativeYields.length) : 0;
    const profitRatio = avgNegative !== 0 ? avgPositive / Math.abs(avgNegative) : null;

    // 计算最大回撤 Max Drawdown
    const portfolioValues = [1.0];
    for (let t = 0; t < 5; t++) {
      let sumRatios = 0;
      let count = 0;
      for (const rec of recs) {
        const future = futureCandlesMap.get(rec.symbol) ?? [];
        const base = basePriceMap.get(rec.symbol) ?? Number(rec.basePrice);
        if (future[t] && base > 0) {
          sumRatios += Number(future[t].close) / base;
          count++;
        }
      }
      if (count > 0) {
        portfolioValues.push(sumRatios / count);
      }
    }

    let maxVal = 1.0;
    let maxDD = 0.0;
    for (const val of portfolioValues) {
      if (val > maxVal) {
        maxVal = val;
      }
      const dd = (maxVal - val) / maxVal;
      if (dd > maxDD) {
        maxDD = dd;
      }
    }

    reportsToUpsertArgs.push({
      where: {
        strategyId_asOf: {
          strategyId: run.strategyId,
          asOf,
        },
      },
      create: {
        strategyId: run.strategyId,
        strategyNameSnapshot: run.strategyNameSnapshot,
        clusterKey,
        asOf,
        winRate: new Prisma.Decimal(winRate.toFixed(4)),
        profitRatio: profitRatio !== null ? new Prisma.Decimal(profitRatio.toFixed(4)) : null,
        avgReturnPct: new Prisma.Decimal(avgReturn.toFixed(6)),
        maxDrawdown: new Prisma.Decimal(maxDD.toFixed(6)),
        recommendationCount: recCount,
      },
      update: {
        strategyNameSnapshot: run.strategyNameSnapshot,
        winRate: new Prisma.Decimal(winRate.toFixed(4)),
        profitRatio: profitRatio !== null ? new Prisma.Decimal(profitRatio.toFixed(4)) : null,
        avgReturnPct: new Prisma.Decimal(avgReturn.toFixed(6)),
        maxDrawdown: new Prisma.Decimal(maxDD.toFixed(6)),
        recommendationCount: recCount,
      },
    });
  }

  if (reportsToUpsertArgs.length === 1) {
    await prisma.strategyPerformanceReport.upsert(reportsToUpsertArgs[0]);
  } else if (reportsToUpsertArgs.length > 1) {
    const queries = reportsToUpsertArgs.map((arg) => prisma.strategyPerformanceReport.upsert(arg));
    await prisma.$transaction(queries);
  }
}
