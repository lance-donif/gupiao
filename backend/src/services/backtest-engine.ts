import { dailyCloseVisibleAt } from './yield-visibility.js';
import { inputFingerprint, artifactFingerprint } from './pipeline-checkpoint.js';
import { Prisma } from '@prisma/client';
import { ScoringContributionEngine } from './scoring-contribution-engine.js';
import { TempStockRecommendationService } from './temp-stock-recommendation-service.js';
import { TraceManager } from './trace-manager.js';
import { StrategyExperimentRunner, type IStrategyExperimentExecutionResult } from './strategy-runner.js';
import { hasDelegate } from './scoring/scoring-helpers.js';
import {
  resolveStockStatusAsOf,
  StockStatusCoverageGapError,
  type StockHistoricalStatus,
} from './market-data/stock-status-history.js';
import {
  assertStrictMarketDataAdmission,
  collectMarketDataAdmission,
  type MarketDataAdmissionReport,
} from './market-data/dataset-contract.js';
import {
  isCandleVisibleAsOf,
  readCandles,
  type ReadCandleRow,
} from './market-data/market-data-reader.js';

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
  /** Separate from the recommendation time; limits observable evaluation prices. */
  readonly evaluationAsOf?: Date;
  /**
   * 显式固定本轮使用的行情数据集版本；省略时不施加 dataset 维度过滤（沿用旧行为）。
   * 恢复/重放必须传入同一 id，保证读到同一份数据修订。
   */
  readonly datasetVersionId?: string | null;
  /**
   * 严格行情准入开关，**默认 false（permissive）**：
   *  - false：不拦截，只把 unknown / 前复权 adjType 计数记入 marketDataAdmission 报告作为数据缺口证据
   *    （生产库 855,961 条 Candle 的 adjType 目前全为 NULL，每日推荐主链路必须继续可用）。
   *  - true：显式要求，窗口内出现 qfq / 未知 adjType 即抛 StrictBacktestRejectedError（M7 评估 / 验收路径）。
   * 两种模式都不放宽可见性边界：readCandles 的业务时间 ∧ 可信可见时间双检始终强制生效。
   */
  readonly strictDataAdmission?: boolean;
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
  readonly strategyResult: IStrategyExperimentExecutionResult;
  /** 本轮行情准入报告：permissive / strict 模式与 unknown adjType 计数（数据缺口证据）。 */
  readonly marketDataAdmission: MarketDataAdmissionReport;
}

const EMPTY_STRATEGY_RESULT: IStrategyExperimentExecutionResult = {
  strategyCount: 0,
  enabledStrategyCount: 0,
  successCount: 0,
  failureCount: 0,
  recommendationCount: 0,
  runs: [],
};

/**
 * 回测可见窗口（以 asOf 为基准的固定窗口）。
 * - 上界 marginAfter：asOf + 20 天；若存在 evaluationAsOf 则取其作为更紧的上界，但绝不回退到 now。
 * - 下界 marginBefore：asOf - 30 天（取历史基准价用）。
 * 该函数被导出以便单测验证「盘中运行不纳入尚未可见的收盘价」且「marginAfter 不回退到 now」。
 */
export const computeMarginWindow = (
  asOf: Date,
  evaluationAsOf?: Date,
): { readonly marginBefore: Date; readonly marginAfter: Date } => {
  const marginBefore = new Date(asOf.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fixedUpperBound = new Date(asOf.getTime() + 20 * 24 * 60 * 60 * 1000);
  const marginAfter = evaluationAsOf
    ? new Date(Math.min(evaluationAsOf.getTime(), fixedUpperBound.getTime()))
    : fixedUpperBound;
  return { marginBefore, marginAfter };
};

/**
 * 回测 K 线窗口切分（纯函数，双重时间边界的最终权威判定）：
 *  - base（特征 / 基准价 p0）：业务时间 tradingDay <= asOf 且可信可见时间 <= asOf。
 *    盘中运行不得纳入当日尚未收盘的完整日线，缺 visibleAt 时回退 15:00 收盘可见时间。
 *  - future（T+1..T+5 收益评估）：业务时间 > asOf 且可见时间 <= evaluationCutoff（= marginAfter）。
 *    评估窗口以 asOf 派生的固定上界为准，绝不回退到 now。
 * 行本身由 readCandles 读出（已施加 SQL 侧粗过滤），此处再做一次权威过滤。
 */
export const partitionReplayCandles = (
  rows: readonly ReadCandleRow[],
  opts: { readonly asOf: Date; readonly evaluationCutoff: Date },
): { readonly base: ReadCandleRow[]; readonly future: ReadCandleRow[] } => {
  const base: ReadCandleRow[] = [];
  const future: ReadCandleRow[] = [];
  for (const row of rows) {
    const tradingDay = row.tradingDay instanceof Date ? row.tradingDay : new Date(row.tradingDay as unknown as string);
    const wrapped: ReadCandleRow = { ...row, tradingDay };
    if (tradingDay.getTime() <= opts.asOf.getTime()) {
      if (isCandleVisibleAsOf(wrapped, opts.asOf)) {
        base.push(wrapped);
      }
      continue;
    }
    if (isCandleVisibleAsOf(wrapped, opts.evaluationCutoff)) {
      future.push(wrapped);
    }
  }
  return { base, future };
};

/**
 * 按 asOf 解析回测所需的股票历史状态，并把「无适用 StockStatusHistory 记录」的标的
 * 单列为数据缺口：缺口标的既不进入 statusBySymbol，也不允许回退到当前名单的
 * ST / 行业，由调用方决定如何处理（本引擎：行业保持 null，不套用当日名单）。
 * 数据源缺少 stockStatusHistory 委托时（轻量测试替身）返回两个空集合。
 */
export const resolveReplayStatusesAsOf = async (
  prisma: any,
  symbols: readonly string[],
  asOf: Date,
): Promise<{
  readonly statusBySymbol: Map<string, StockHistoricalStatus>;
  readonly coverageGapSymbols: Set<string>;
}> => {
  const statusBySymbol = new Map<string, StockHistoricalStatus>();
  const coverageGapSymbols = new Set<string>();
  if (!hasDelegate(prisma, 'stockStatusHistory', 'findMany')) {
    return { statusBySymbol, coverageGapSymbols };
  }
  for (const symbol of symbols) {
    try {
      statusBySymbol.set(symbol, await resolveStockStatusAsOf(prisma, symbol, asOf));
    } catch (err) {
      if (err instanceof StockStatusCoverageGapError) {
        coverageGapSymbols.add(symbol);
        continue;
      }
      throw err;
    }
  }
  return { statusBySymbol, coverageGapSymbols };
};

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

    // M5 行情准入：在读取任何特征 / 对账 K 线之前先统计复权口径缺口。
    // 默认 permissive：只记录 marketDataAdmission 证据（unknown adjType 计数），不阻断回测；
    // strictDataAdmission=true 时才抛 StrictBacktestRejectedError（M7 评估 / 验收路径显式开启）。
    // 注意：无论哪种模式，可见性双时间边界都由 readCandles 强制，与本开关无关。
    const { marginBefore, marginAfter } = computeMarginWindow(asOf, input.evaluationAsOf);
    let marketDataAdmission: MarketDataAdmissionReport;
    try {
      marketDataAdmission = await collectMarketDataAdmission(
        prisma,
        {
          clusterKey,
          datasetVersionId: input.datasetVersionId,
          fromTradingDay: marginBefore,
          toTradingDay: marginAfter,
        },
        {
          strict: input.strictDataAdmission === true,
          versionId: input.datasetVersionId ?? null,
        },
      );
    } catch (err: any) {
      if (manageTrace) {
        await TraceManager.failRunTrace(prisma, traceId, `market-data admission failed: ${err?.message ?? String(err)}`);
      }
      throw err;
    }

    const completedSteps = new Map(await TraceManager.getSuccessfulStepOutputs(prisma, traceId));
    const facts = await Promise.all([
      artifactFingerprint(prisma,{clusterKey,status:'active',validFrom:{lte:asOf},OR:[{validTo:null},{validTo:{gte:asOf}}]},['stockExposureFact']),
      artifactFingerprint(prisma,{clusterKey,publishedAt:{lte:asOf,gte:new Date(asOf.getTime()-replaySummary.maxWindowDays*86400000)}},['normalizedNewsRecord']),
      artifactFingerprint(prisma,{clusterKey,validFrom:{lte:asOf},validTo:{gte:asOf}},['keywordPerformancePenalty']),
    ]);
    const fingerprint = inputFingerprint({version:'backtest-v3',...replaySummary,
      facts,
      upstream:await artifactFingerprint(prisma,{traceId,clusterKey},['causalSignalCandidate','graphSnapshot','expectationGapSnapshot','themeForecast'])});
    const scoreArtifact = (db: any) => artifactFingerprint(db,{traceId,clusterKey},['stockFeatureSnapshot','evidenceContribution','marketSignalSnapshot']);
    const recommendationArtifact = (db: any) => artifactFingerprint(db,{traceId,clusterKey},['recommendationSnapshot'],['symbol','rank','finalScore','reasons']);


    let scoreResult: any;
    const completedScoring = completedSteps.get('scoring');
    if (completedScoring?.inputFingerprint === fingerprint && prisma.stockFeatureSnapshot?.count) {
      const persistedCount = await prisma.stockFeatureSnapshot.count({ where: { traceId, clusterKey } });
      const expectedCount = Number(completedScoring.snapshotCount ?? -1);
      if (expectedCount >= 0 && persistedCount === expectedCount && completedScoring.artifactFingerprint === await scoreArtifact(prisma)) {
        scoreResult = {
          ...completedScoring,
          profileUsed: String(completedScoring.profileUsed ?? replaySummary.profile),
          halfLifeDaysUsed: Number(completedScoring.halfLifeDaysUsed ?? replaySummary.halfLifeDays),
          maxWindowDaysUsed: Number(completedScoring.maxWindowDaysUsed ?? replaySummary.maxWindowDays),
          resumedFromCheckpoint: true,
        };
      }
    }
    if (!scoreResult) try {
      if (await prisma.recommendationSnapshot.count?.({where:{traceId,isPublished:true}})) {
        throw new Error('Published recommendation artifacts cannot be rewritten; use a new trace');
      }
      for (const stage of ['recommendation','reconciliation','strategy_experiment']) completedSteps.delete(stage);
      await prisma.$transaction(async (tx: any) => {
      for (const table of ['stockFeatureSnapshot','evidenceContribution','marketSignalSnapshot','recommendationSnapshot']) {
        await tx[table]?.deleteMany?.({where:{traceId,clusterKey}});
      }
      // 步骤 1：scoring
      await TraceManager.startStepTrace(prisma, traceId, 'scoring', {
        ...replaySummary,
        newsWindowDays,
      });

      scoreResult = await this.scoringEngine.execute(tx, {
        traceId,
        asOf,
        clusterKey,
        newsWindowDays,
        scoringProfile: input.scoringProfile,
        halfLifeDays: input.halfLifeDays,
        maxWindowDays: input.maxWindowDays,
      });

      await TraceManager.completeStepTrace(tx, traceId, 'scoring', {
        inputFingerprint: fingerprint,
        artifactFingerprint: await scoreArtifact(tx),
        contributionCount: scoreResult.contributionCount,
        snapshotCount: scoreResult.snapshotCount,
        profileUsed: scoreResult.profileUsed,
        halfLifeDaysUsed: scoreResult.halfLifeDaysUsed,
        maxWindowDaysUsed: scoreResult.maxWindowDaysUsed,
        metrics: scoreResult.metrics ?? {},
      });
      }, {timeout:300000});
    }
    catch (err: any) {
      await TraceManager.failStepTrace(prisma, traceId, 'scoring', err.message);
      if (manageTrace) {
        await TraceManager.failRunTrace(prisma, traceId, `scoring failed: ${err.message}`);
      }
      throw err;
    }

    let recommendations: any;
    const completedRecommendation = completedSteps.get('recommendation');
    if (completedRecommendation?.inputFingerprint === fingerprint && prisma.recommendationSnapshot?.findMany) {
      const rows = await prisma.recommendationSnapshot.findMany({
        where: { traceId, clusterKey },
        orderBy: { rank: 'asc' },
      });
      const expectedCount = Number(completedRecommendation.recommendationsCreated ?? -1);
      if (expectedCount >= 0 && rows.length === expectedCount && completedRecommendation.artifactFingerprint === await recommendationArtifact(prisma)) {
        recommendations = rows.map((row: any) => ({
          symbol: String(row.symbol),
          score: Number(row.finalScore),
          scoreBreakdown: row.scoreBreakdown,
        }));
      }
    }
    if (!recommendations) try {
      if (await prisma.recommendationSnapshot.count?.({where:{traceId,isPublished:true}})) {
        throw new Error('Published recommendation artifacts cannot be rewritten; use a new trace');
      }
      for (const stage of ['reconciliation','strategy_experiment']) completedSteps.delete(stage);
      await prisma.$transaction(async (tx: any) => {
      await tx.recommendationSnapshot.deleteMany?.({where:{traceId,clusterKey}});
      // 步骤 2：recommendation
      await TraceManager.startStepTrace(prisma, traceId, 'recommendation', {
        ...replaySummary,
        limit,
        maxPerIndustry,
      });

      const recommendationResult = await this.recommendationService.generatePhysicalRecommendationsWithDiagnostics(
        tx,
        traceId,
        asOf,
        clusterKey,
        limit,
        maxPerIndustry,
      );
      recommendations = recommendationResult.recommendations;

      await TraceManager.completeStepTrace(tx, traceId, 'recommendation', {
        inputFingerprint: fingerprint,
        artifactFingerprint: await recommendationArtifact(tx),
        recommendationsCreated: recommendations.length,
        selectionDiagnostics: recommendationResult.diagnostics,
        recommendations: recommendations.map((rec: any, index: number) => ({
          symbol: rec.symbol,
          rank: index + 1,
          finalScore: rec.score,
          scoreBreakdown: rec.scoreBreakdown,
        })),
      });
      }, {timeout:300000});
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
          marketDataAdmission: {
            mode: marketDataAdmission.mode,
            unknownAdjTypeCount: marketDataAdmission.unknownAdjTypeCount,
          },
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
        strategyResult: EMPTY_STRATEGY_RESULT,
        marketDataAdmission,
      };
    }

    let reconciledCount = 0;
    let strategyResult: IStrategyExperimentExecutionResult = EMPTY_STRATEGY_RESULT;
    const completedReconciliation = completedSteps.get('reconciliation');
    if (completedReconciliation?.inputFingerprint === fingerprint && completedReconciliation.strategyResult) {
      reconciledCount = Number(completedReconciliation.reconciledCount ?? 0);
      const persistedStrategyResult = completedReconciliation.strategyResult;
      if (persistedStrategyResult && typeof persistedStrategyResult === 'object' && !Array.isArray(persistedStrategyResult)) {
        strategyResult = {
          ...EMPTY_STRATEGY_RESULT,
          ...persistedStrategyResult,
          runs: Array.isArray((persistedStrategyResult as any).runs) ? (persistedStrategyResult as any).runs : [],
        };
      }
    }
    else try {
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

        // 1b. 按 asOf 解析股票历史状态（isST / 上市退市 / 行业）。数据源为 StockStatusHistory；
        // 无适用记录视为数据缺口（单列，不把当前名单的 ST / 行业套到过去）。
        const { statusBySymbol, coverageGapSymbols } = await resolveReplayStatusesAsOf(prisma, symbols, asOf);

        // 2. 统一行情读取：readCandles 同时施加业务时间（tradingDay <= 窗口上界）与可信可见时间边界，
        //    并对窗口内复权口径做行级准入复核（严格模式下未知 / 前复权立即抛错）。
        //    基准价 = asOf 时点已可见的最后一个交易日收盘；未来价 = (asOf, marginAfter] 内可见日线。
        //    marginAfter 由 computeMarginWindow 以 asOf 为基准派生，绝不回退到 now。
        const windowRows = await readCandles(prisma, {
          clusterKey,
          asOf: marginAfter,
          stockIds,
          fromTradingDay: marginBefore,
          datasetVersionId: input.datasetVersionId,
        });
        // 严格模式下的行级复核（覆盖统计能力不可得的场景）：permissive 路径不拦截，只依赖上面的计数证据。
        if (input.strictDataAdmission === true) {
          assertStrictMarketDataAdmission(windowRows, {
            versionId: input.datasetVersionId ?? null,
            context: `backtest replay window ${marginBefore.toISOString()} ~ ${marginAfter.toISOString()}`,
          });
        }
        const { base: baseReplayCandles, future: futureReplayCandles } = partitionReplayCandles(windowRows, {
          asOf,
          evaluationCutoff: marginAfter,
        });

        const candlesByStockId = new Map<string, any[]>();
        for (const candle of [...baseReplayCandles, ...futureReplayCandles]) {
          const stockId = String(candle.stockId);
          const list = candlesByStockId.get(stockId) ?? [];
          list.push(candle);
          candlesByStockId.set(stockId, list);
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
          statusBySymbol,
          coverageGapSymbols,
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
                yield1DayVisibleAt: item.futureCandles[0] ? dailyCloseVisibleAt(item.futureCandles[0].tradingDay) : null,
                yield3DayVisibleAt: item.futureCandles[2] ? dailyCloseVisibleAt(item.futureCandles[2].tradingDay) : null,
                yield5DayVisibleAt: item.futureCandles[4] ? dailyCloseVisibleAt(item.futureCandles[4].tradingDay) : null,
                isReconciled: true,
              },
            })
          );

          // 收益元数据落到 YieldRecord：1/3/5 日分别记录，禁止用较短周期填充 5 日收益。
          const snapshotId = snapshotMap.get(item.symbol)?.id;
          if (snapshotId) {
            const drafts = buildYieldRecordDrafts({
              snapshotId,
              symbol: item.symbol,
              p0: item.p0,
              futureCandles: item.futureCandles,
              computeVersion: YIELD_COMPUTE_VERSION,
              maturityReferenceTime: asOf,
            });
            for (const draft of drafts) {
              updates.push(
                prisma.yieldRecord.upsert({
                  where: {
                    snapshotId_symbol_horizon_computeVersion: {
                      snapshotId: draft.snapshotId,
                      symbol: draft.symbol,
                      horizon: draft.horizon,
                      computeVersion: draft.computeVersion,
                    },
                  },
                  create: draft,
                  update: {
                    value: draft.value,
                    status: draft.status,
                    plannedExitDay: draft.plannedExitDay,
                    actualExitDay: draft.actualExitDay,
                    maturityAt: draft.maturityAt,
                  },
                })
              );
            }
          }
          reconciledCount++;
        }

        if (updates.length > 0) {
          await prisma.$transaction(updates);
        }

        // 4. 运行所有启用的策略，生成对应的 StrategyRecommendationEvent 事件记录
        const strategyRunner = new StrategyExperimentRunner();
        const savedStrategy = completedSteps.get('strategy_experiment');
        if (savedStrategy?.inputFingerprint === fingerprint) {
          strategyResult = savedStrategy.result as unknown as IStrategyExperimentExecutionResult;
        } else {
          await prisma.$transaction(async (tx: any) => {
            strategyResult = await strategyRunner.runEnabledStrategies(tx, {traceId,asOf,clusterKey});
            await TraceManager.startStepTrace(tx,traceId,'strategy_experiment',{inputFingerprint:fingerprint});
            await TraceManager.completeStepTrace(tx,traceId,'strategy_experiment',{inputFingerprint:fingerprint,result:strategyResult});
          },{timeout:300000});
        }

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
        inputFingerprint: fingerprint,
        reconciledCount,
        strategyResult,
        marketDataAdmission: {
          mode: marketDataAdmission.mode,
          checked: marketDataAdmission.checked,
          unknownAdjTypeCount: marketDataAdmission.unknownAdjTypeCount,
          datasetVersionId: marketDataAdmission.datasetVersionId,
          reasons: marketDataAdmission.reasons,
        },
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
        marketDataAdmission: {
          mode: marketDataAdmission.mode,
          unknownAdjTypeCount: marketDataAdmission.unknownAdjTypeCount,
        },
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
      strategyResult,
      marketDataAdmission,
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
  readonly industry: string | null;
}

/** 收益元数据写入 YieldRecord 时使用的计算版本。 */
export const YIELD_COMPUTE_VERSION = 'm5-yield-v1';

const YIELD_HORIZONS = [1, 3, 5] as const;

/** 卖出受限（涨跌停 / 停牌 / ST 等）的交易状态标记。 */
const RESTRICTED_TRADING_STATUSES = new Set([
  'LIMIT_UP', 'LIMIT_DOWN', 'SUSPEND', 'HALT', 'ST', 'RESUMED_LIMIT_UP', 'RESUMED_LIMIT_DOWN',
]);

export interface YieldRecordDraft {
  readonly snapshotId: string;
  readonly symbol: string;
  readonly horizon: number;
  readonly value: number | null;
  readonly status: string;
  readonly plannedExitDay: Date | null;
  readonly actualExitDay: Date | null;
  readonly maturityAt: Date | null;
  readonly computeVersion: string;
}

/**
 * 为单个标的生成 1/3/5 日 YieldRecord 草稿。
 *  - 不足该周期的 K 线 → status='immature'、value=null，**禁止**用较短周期填充。
 *  - 缺失交易状态 → status='coverage_gap'、actualExitDay=null（明确标注，不默认成交）。
 *  - 卖出受限 → status='pending'、actualExitDay=null（延后到可成交交易日，不在本层默认成交）。
 *  - 可成交且可见时间已过 → status='mature'，否则 'pending'。
 */
export const buildYieldRecordDrafts = (input: {
  readonly snapshotId: string;
  readonly symbol: string;
  readonly p0: number;
  readonly futureCandles: readonly any[];
  readonly computeVersion: string;
  readonly maturityReferenceTime: Date;
}): YieldRecordDraft[] => {
  const drafts: YieldRecordDraft[] = [];
  for (const horizon of YIELD_HORIZONS) {
    const idx = horizon - 1;
    const exitCandle = input.futureCandles.length > idx ? input.futureCandles[idx] : null;

    if (!exitCandle) {
      drafts.push({
        snapshotId: input.snapshotId,
        symbol: input.symbol,
        horizon,
        value: null,
        status: 'immature',
        plannedExitDay: null,
        actualExitDay: null,
        maturityAt: null,
        computeVersion: input.computeVersion,
      });
      continue;
    }

    const plannedExitDay = exitCandle.tradingDay instanceof Date ? exitCandle.tradingDay : new Date(exitCandle.tradingDay);
    const value = (Number(exitCandle.close) - input.p0) / input.p0;
    const maturityAt = dailyCloseVisibleAt(plannedExitDay);
    const tradingStatus = exitCandle.tradingStatus != null ? String(exitCandle.tradingStatus) : null;

    let status: string;
    let actualExitDay: Date | null = plannedExitDay;
    if (tradingStatus == null) {
      status = 'coverage_gap';
      actualExitDay = null;
    } else if (RESTRICTED_TRADING_STATUSES.has(tradingStatus)) {
      status = 'pending';
      actualExitDay = null;
    } else {
      status = maturityAt.getTime() <= input.maturityReferenceTime.getTime() ? 'mature' : 'pending';
    }

    drafts.push({
      snapshotId: input.snapshotId,
      symbol: input.symbol,
      horizon,
      value,
      status,
      plannedExitDay,
      actualExitDay,
      maturityAt,
      computeVersion: input.computeVersion,
    });
  }
  return drafts;
};

/**
 * 生成对账数据（纯函数）。行业来源按 asOf 从 StockStatusHistory 解析；
 * coverageGapSymbols 中的标的属于数据缺口，行业保持 null，绝不回退到当前名单行业。
 */
export const calculateReconciliationData = (params: {
  readonly recommendations: readonly any[];
  readonly stockMap: Map<string, any>;
  readonly candlesByStockId: Map<string, any[]>;
  readonly snapshotMap: Map<string, any>;
  readonly statusBySymbol: Map<string, StockHistoricalStatus>;
  readonly coverageGapSymbols: ReadonlySet<string>;
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

    // 行业来源按 asOf 解析自 StockStatusHistory；无适用记录（数据缺口）时保持 null，
    // 绝不把当前名单的行业套到历史时点。
    const historicalIndustry = params.statusBySymbol.get(rec.symbol)?.industry;
    const industry = historicalIndustry
      ?? (params.coverageGapSymbols.has(rec.symbol)
        ? null
        : (typeof rec.industry === 'string' ? rec.industry : null));

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
      industry,
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
