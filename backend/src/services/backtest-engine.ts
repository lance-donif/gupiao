import { Prisma } from '@prisma/client';
import { ScoringContributionEngine } from './scoring-contribution-engine.js';
import { TempStockRecommendationService } from './temp-stock-recommendation-service.js';
import { TraceManager } from './trace-manager.js';

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

export const resolveBacktestReplayTraceSummary = (input: IBacktestRunInput): IBacktestReplayTraceSummary => {
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

      for (const rec of recommendations) {
        // 1. 查询股票记录 (必须包含 clusterKey 隔离)
        const stock = await prisma.stock.findUnique({
          where: {
            clusterKey_symbol: {
              clusterKey,
              symbol: rec.symbol,
            },
          },
        });

        if (!stock) {
          continue;
        }

        // 2. 隔离查询历史行情 (P_0 基准价: <= asOf 的最后一天收盘价)
        const baseCandles = await prisma.candle.findMany({
          where: {
            stockId: stock.id,
            tradingDay: { lte: asOf },
          },
          orderBy: { tradingDay: 'desc' },
          take: 1,
        });

        if (baseCandles.length === 0) {
          continue; // 缺乏历史基准价，跳过对账
        }

        const p0Candle = baseCandles[0];
        const p0 = Number(p0Candle.close);

        // 3. 查询未来的行情 (T+1, T+3, T+5 收盘价: > asOf 按时间升序排序)
        const futureCandles = await prisma.candle.findMany({
          where: {
            stockId: stock.id,
            tradingDay: { gt: asOf },
          },
          orderBy: { tradingDay: 'asc' },
          take: 5, // 拿 5 个交易日的行情
        });

        if (futureCandles.length === 0) {
          continue; // 未来未发生或无价格，暂无法对账
        }

        // 提取 T+1, T+3, T+5 的价格
        const p1Candle = futureCandles[0]; // 第 1 个未来交易日
        const p3Candle = futureCandles.length >= 3 ? futureCandles[2] : null; // 第 3 个未来交易日
        const p5Candle = futureCandles.length >= 5 ? futureCandles[4] : null; // 第 5 个未来交易日

        const yield1Day = p1Candle ? (Number(p1Candle.close) - p0) / p0 : null;
        const yield3Day = p3Candle ? (Number(p3Candle.close) - p0) / p0 : null;
        const yield5Day = p5Candle ? (Number(p5Candle.close) - p0) / p0 : null;

        // 4. 获取当时生成的 Snapshot 以合并并固化本次使用的 Profile 数据
        const currentSnapshot = await prisma.recommendationSnapshot.findUnique({
          where: {
            traceId_symbol: {
              traceId,
              symbol: rec.symbol,
            },
          },
        });

        const originalBreakdown = currentSnapshot ? (currentSnapshot.scoreBreakdown as any) : {};
        const updatedBreakdown = {
          ...originalBreakdown,
          scoringProfile: scoreResult.profileUsed,
          halfLifeDaysUsed: scoreResult.halfLifeDaysUsed,
          maxWindowDaysUsed: scoreResult.maxWindowDaysUsed,
        };

        // 5. 更新 RecommendationSnapshot 快照表中的收益率与 profile 参数
        await prisma.recommendationSnapshot.update({
          where: {
            traceId_symbol: {
              traceId,
              symbol: rec.symbol,
            },
          },
          data: {
            realizedPrice: new Prisma.Decimal(p0),
            realizedPriceTarget: p5Candle ? new Prisma.Decimal(Number(p5Candle.close)) : (p3Candle ? new Prisma.Decimal(Number(p3Candle.close)) : new Prisma.Decimal(Number(p1Candle.close))),
            yield1Day: yield1Day !== null ? new Prisma.Decimal(yield1Day) : null,
            yield3Day: yield3Day !== null ? new Prisma.Decimal(yield3Day) : null,
            yield5Day: yield5Day !== null ? new Prisma.Decimal(yield5Day) : null,
            scoreBreakdown: updatedBreakdown,
            isReconciled: true,
          },
        });

        reconciledCount++;
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
