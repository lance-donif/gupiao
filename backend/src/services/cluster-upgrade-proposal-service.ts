/**
 * 集团自提升闭环：监控 + 升级建议
 *
 * 监控集团版本的"推荐盈利率 + 主题预测命中率"双指标。
 * 连续N天低于阈值时生成升级建议（pending_user_confirmation），不自动升级。
 *
 * 数据来源：
 * - autopilot_policies（runtime-state）：策略参数
 * - RecommendationSnapshot（isReconciled=true）：yield5Day 对账结果
 * - ThemeForecast（isReconciled=true）：direction 命中 realizedDirection
 */
import { hasPrismaDelegateMethod } from './prisma-utils.js';

export interface IUpgradeProposalInput {
  readonly groupId: string;
  readonly asOf: Date;
  readonly clusterKey: string;
}

export interface IUpgradeProposalTrigger {
  readonly indicator: 'recommendation_yield' | 'theme_forecast_hitrate';
  readonly threshold: number;
  readonly actualValue: number;
  readonly consecutiveDays: number;
  readonly requiredDays: number;
}

export interface IUpgradeProposalResult {
  readonly groupId: string;
  readonly enabled: boolean;
  readonly shouldPropose: boolean;
  readonly triggers: readonly IUpgradeProposalTrigger[];
  readonly failureReasons: readonly string[];
  readonly recommendationStats: {
    readonly avgYield5Day: number | null;
    readonly reconciledCount: number;
    readonly consecutiveLowDays: number;
  };
  readonly themeForecastStats: {
    readonly hitRate: number | null;
    readonly reconciledCount: number;
    readonly consecutiveLowDays: number;
  };
  readonly proposal?: {
    readonly reason: string;
    readonly suggestedPromptImprovements: readonly string[];
    readonly proposedAt: string;
  };
}

interface IMutableUpgradeProposalResult {
  readonly groupId: string;
  readonly enabled: boolean;
  readonly shouldPropose: boolean;
  readonly triggers: readonly IUpgradeProposalTrigger[];
  readonly failureReasons: readonly string[];
  readonly recommendationStats: {
    readonly avgYield5Day: number | null;
    readonly reconciledCount: number;
    readonly consecutiveLowDays: number;
  };
  readonly themeForecastStats: {
    readonly hitRate: number | null;
    readonly reconciledCount: number;
    readonly consecutiveLowDays: number;
  };
  proposal?: {
    readonly reason: string;
    readonly suggestedPromptImprovements: readonly string[];
    readonly proposedAt: string;
  };
}

// 经验阈值
const RECOMMENDATION_YIELD_THRESHOLD = -0.03;  // 5日平均收益 < -3% 触发
const THEME_FORECAST_HITRATE_THRESHOLD = 0.50;  // 命中率 < 50% 触发

interface IAutopilotPolicy {
  readonly enabled: boolean;
  readonly kill_switch: boolean;
  readonly promote_consecutive_days: number;
  readonly rollback_cooldown_days: number;
  readonly guard_consecutive_fail_days: number;
  readonly guard_window_days: number;
}

const hasDelegate = (prisma: any, delegateName: string, methodName: string): boolean => {
  return hasPrismaDelegateMethod(prisma, delegateName, methodName);
};

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 统计最近 windowDays 天内，连续低于阈值的天数。
 */
const countConsecutiveLowDays = (
  dailyValues: ReadonlyArray<{ date: Date; value: number }>,
  threshold: number,
  isLow: (value: number, threshold: number) => boolean,
): number => {
  if (dailyValues.length === 0) {
    return 0;
  }
  const sorted = [...dailyValues].sort((left, right) => right.date.getTime() - left.date.getTime());
  let count = 0;
  for (const item of sorted) {
    if (isLow(item.value, threshold)) {
      count += 1;
    }
    else {
      break;
    }
  }
  return count;
};

export class ClusterUpgradeProposalService {
  public constructor(
    private readonly runtimeStateStore: {
      read: () => Promise<{ readonly autopilot_policies: Readonly<Record<string, Record<string, unknown>>> }>;
    },
  ) {}

  public async evaluateAndPropose(prisma: any, input: IUpgradeProposalInput): Promise<IUpgradeProposalResult> {
    const state = await this.runtimeStateStore.read();
    const rawPolicy: Record<string, unknown> = state.autopilot_policies[input.groupId] ?? {};
    const policy: IAutopilotPolicy = {
      enabled: Boolean(rawPolicy.enabled),
      kill_switch: Boolean(rawPolicy.kill_switch),
      promote_consecutive_days: Number(rawPolicy.promote_consecutive_days ?? 5),
      rollback_cooldown_days: Number(rawPolicy.rollback_cooldown_days ?? 3),
      guard_consecutive_fail_days: Number(rawPolicy.guard_consecutive_fail_days ?? 2),
      guard_window_days: Number(rawPolicy.guard_window_days ?? 5),
    };

    if (!policy.enabled || policy.kill_switch) {
      return {
        groupId: input.groupId,
        enabled: false,
        shouldPropose: false,
        triggers: [],
        failureReasons: ['autopilot 未启用或 kill_switch 已触发'],
        recommendationStats: { avgYield5Day: null, reconciledCount: 0, consecutiveLowDays: 0 },
        themeForecastStats: { hitRate: null, reconciledCount: 0, consecutiveLowDays: 0 },
      };
    }

    const windowMs = policy.guard_window_days * ONE_DAY_MS;
    const windowStart = new Date(input.asOf.getTime() - windowMs);

    // 1. 推荐收益统计
    const recommendationStats = await this.evaluateRecommendationYield(prisma, {
      clusterKey: input.clusterKey,
      windowStart,
      asOf: input.asOf,
    });

    // 2. 主题预测命中率统计
    const themeForecastStats = await this.evaluateThemeForecastHitRate(prisma, {
      clusterKey: input.clusterKey,
      windowStart,
      asOf: input.asOf,
    });

    // 3. 判定触发条件
    const triggers: IUpgradeProposalTrigger[] = [];
    const failureReasons: string[] = [];

    if (recommendationStats.avgYield5Day !== null
      && recommendationStats.avgYield5Day < RECOMMENDATION_YIELD_THRESHOLD
      && recommendationStats.consecutiveLowDays >= policy.promote_consecutive_days) {
      triggers.push({
        indicator: 'recommendation_yield',
        threshold: RECOMMENDATION_YIELD_THRESHOLD,
        actualValue: recommendationStats.avgYield5Day,
        consecutiveDays: recommendationStats.consecutiveLowDays,
        requiredDays: policy.promote_consecutive_days,
      });
      failureReasons.push(
        `推荐收益触发：5日平均收益 ${recommendationStats.avgYield5Day.toFixed(4)} < ${RECOMMENDATION_YIELD_THRESHOLD}，连续 ${recommendationStats.consecutiveLowDays} 天（要求 ${policy.promote_consecutive_days} 天）`,
      );
    }

    if (themeForecastStats.hitRate !== null
      && themeForecastStats.hitRate < THEME_FORECAST_HITRATE_THRESHOLD
      && themeForecastStats.consecutiveLowDays >= policy.promote_consecutive_days) {
      triggers.push({
        indicator: 'theme_forecast_hitrate',
        threshold: THEME_FORECAST_HITRATE_THRESHOLD,
        actualValue: themeForecastStats.hitRate,
        consecutiveDays: themeForecastStats.consecutiveLowDays,
        requiredDays: policy.promote_consecutive_days,
      });
      failureReasons.push(
        `主题预测触发：命中率 ${themeForecastStats.hitRate.toFixed(4)} < ${THEME_FORECAST_HITRATE_THRESHOLD}，连续 ${themeForecastStats.consecutiveLowDays} 天（要求 ${policy.promote_consecutive_days} 天）`,
      );
    }

    const shouldPropose = triggers.length > 0;

    const result: IMutableUpgradeProposalResult = {
      groupId: input.groupId,
      enabled: true,
      shouldPropose,
      triggers,
      failureReasons,
      recommendationStats,
      themeForecastStats,
    };

    if (shouldPropose) {
      result.proposal = {
        reason: failureReasons.join('; '),
        suggestedPromptImprovements: this.generatePromptImprovements(triggers, recommendationStats, themeForecastStats),
        proposedAt: input.asOf.toISOString(),
      };
    }

    return result;
  }

  private async evaluateRecommendationYield(
    prisma: any,
    input: { readonly clusterKey: string; readonly windowStart: Date; readonly asOf: Date },
  ): Promise<{ readonly avgYield5Day: number | null; readonly reconciledCount: number; readonly consecutiveLowDays: number }> {
    if (!hasDelegate(prisma, 'recommendationSnapshot', 'findMany')) {
      return { avgYield5Day: null, reconciledCount: 0, consecutiveLowDays: 0 };
    }

    const recommendations = await prisma.recommendationSnapshot.findMany({
      where: {
        clusterKey: input.clusterKey,
        isReconciled: true,
        asOf: { gte: input.windowStart, lte: input.asOf },
      },
      select: { asOf: true, yield5Day: true },
    });

    if (recommendations.length === 0) {
      return { avgYield5Day: null, reconciledCount: 0, consecutiveLowDays: 0 };
    }

    // 按天聚合平均 yield5Day
    const byDay = new Map<string, { date: Date; values: number[] }>();
    const emptyDayValue = (): { date: Date; values: number[] } => ({ date: new Date(), values: [] });
    for (const rec of recommendations) {
      const yield5Day = rec.yield5Day !== null && rec.yield5Day !== undefined ? toNumber(rec.yield5Day) : null;
      if (yield5Day === null) {
        continue;
      }
      const dateKey = (rec.asOf instanceof Date ? rec.asOf : new Date(String(rec.asOf))).toISOString().slice(0, 10);
      const existing = byDay.get(dateKey) ?? emptyDayValue();
      existing.date = rec.asOf instanceof Date ? rec.asOf : new Date(String(rec.asOf));
      existing.values.push(yield5Day);
      byDay.set(dateKey, existing);
    }

    const dailyAverages = [...byDay.values()].map(item => ({
      date: item.date,
      value: item.values.reduce((sum, v) => sum + v, 0) / item.values.length,
    }));

    const allYields = dailyAverages.map(item => item.value);
    const avgYield5Day = allYields.length > 0
      ? allYields.reduce((sum, v) => sum + v, 0) / allYields.length
      : null;

    const consecutiveLowDays = countConsecutiveLowDays(
      dailyAverages,
      RECOMMENDATION_YIELD_THRESHOLD,
      (value, threshold) => value < threshold,
    );

    return { avgYield5Day, reconciledCount: recommendations.length, consecutiveLowDays };
  }

  private async evaluateThemeForecastHitRate(
    prisma: any,
    input: { readonly clusterKey: string; readonly windowStart: Date; readonly asOf: Date },
  ): Promise<{ readonly hitRate: number | null; readonly reconciledCount: number; readonly consecutiveLowDays: number }> {
    if (!hasDelegate(prisma, 'themeForecast', 'findMany')) {
      return { hitRate: null, reconciledCount: 0, consecutiveLowDays: 0 };
    }

    const forecasts = await prisma.themeForecast.findMany({
      where: {
        clusterKey: input.clusterKey,
        isReconciled: true,
        asOf: { gte: input.windowStart, lte: input.asOf },
      },
      select: { asOf: true, direction: true, realizedDirection: true },
    });

    if (forecasts.length === 0) {
      return { hitRate: null, reconciledCount: 0, consecutiveLowDays: 0 };
    }

    // 按天聚合命中率
    const byDay = new Map<string, { date: Date; hits: number; total: number }>();
    const emptyHitValue = (): { date: Date; hits: number; total: number } => ({ date: new Date(), hits: 0, total: 0 });
    for (const forecast of forecasts) {
      const dateKey = (forecast.asOf instanceof Date ? forecast.asOf : new Date(String(forecast.asOf))).toISOString().slice(0, 10);
      const existing = byDay.get(dateKey) ?? emptyHitValue();
      existing.date = forecast.asOf instanceof Date ? forecast.asOf : new Date(String(forecast.asOf));
      existing.total += 1;
      const isHit = (String(forecast.direction) === 'bullish' && String(forecast.realizedDirection) === 'up')
        || (String(forecast.direction) === 'bearish' && String(forecast.realizedDirection) === 'down')
        || (String(forecast.direction) === 'neutral' && String(forecast.realizedDirection) === 'flat');
      if (isHit) {
        existing.hits += 1;
      }
      byDay.set(dateKey, existing);
    }

    const dailyHitRates = [...byDay.values()].map(item => ({
      date: item.date,
      value: item.total > 0 ? item.hits / item.total : 0,
    }));

    const totalHits = [...byDay.values()].reduce((sum: number, item) => sum + item.hits, 0);
    const totalCount = [...byDay.values()].reduce((sum: number, item) => sum + item.total, 0);
    const hitRate = totalCount > 0 ? totalHits / totalCount : null;

    const consecutiveLowDays = countConsecutiveLowDays(
      dailyHitRates,
      THEME_FORECAST_HITRATE_THRESHOLD,
      (value, threshold) => value < threshold,
    );

    return { hitRate, reconciledCount: forecasts.length, consecutiveLowDays };
  }

  private generatePromptImprovements(
    triggers: readonly IUpgradeProposalTrigger[],
    recommendationStats: { readonly avgYield5Day: number | null },
    themeForecastStats: { readonly hitRate: number | null },
  ): readonly string[] {
    const improvements: string[] = [];
    if (triggers.some(t => t.indicator === 'recommendation_yield')) {
      improvements.push(
        '推荐亏损过多：加强对"无 EvidenceContribution 股票"的排除，提高 KeywordPerformancePenalty 惩罚系数（建议从0.6降至0.5）',
        '考虑收窄暴露词匹配范围，减少 false positive（当前 fuzzy overlap 0.72 阈值偏低）',
      );
    }
    if (triggers.some(t => t.indicator === 'theme_forecast_hitrate')) {
      improvements.push(
        '主题预测不准：提高 CausalSignal 抽取的置信度阈值（建议从0.55提升至0.65）',
        '增加 direction 一致性校验，mixed/neutral 信号不参与 bullish 判定',
      );
    }
    improvements.push(
      `当前推荐平均5日收益：${recommendationStats.avgYield5Day?.toFixed(4) ?? 'N/A'}，主题命中率：${themeForecastStats.hitRate?.toFixed(4) ?? 'N/A'}`,
    );
    return improvements;
  }
}
