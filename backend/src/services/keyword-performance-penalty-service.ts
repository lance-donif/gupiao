import { Prisma } from '@prisma/client';
import { toNumberOrNull } from '../lib/number-utils.js';
import { visibleYields } from './yield-visibility.js';
import { DEFAULT_BUSINESS_CONFIG, resolveScoringRecipe } from '../version.js';
import {
  DEFAULT_SMOOTH_PENALTY_CONFIG,
  calculateSmoothPenalty,
  type SmoothPenaltyConfig,
  type SmoothPenaltyObservation,
  type SmoothPenaltyResult,
} from './event-scoring/smooth-penalty.js';

export interface IKeywordPerformancePenaltyRefreshInput {
  readonly asOf: Date;
  readonly clusterKey: string;
  readonly lookbackDays?: number;
  readonly cooldownDays?: number;
  readonly lossThresholdPct?: number;
  readonly penaltyFactor?: number;
}

export interface IKeywordPerformancePenaltyRefreshResult {
  readonly scannedRecommendations: number;
  readonly losingRecommendations: number;
  readonly candidateKeywordCount: number;
  readonly createdPenaltyCount: number;
  readonly lossThresholdPct: number;
  readonly penaltyFactor: number;
  readonly cooldownDays: number;
  /** 实际生效的评分配方（event-v2 走平滑惩罚，baseline-v1 走原有阈值惩罚）。 */
  readonly scoringRecipe?: string;
  /** event-v2 专用：进入平滑惩罚的成熟 5 日观测数。 */
  readonly smoothObservationCount?: number;
  /** event-v2 专用：被平滑惩罚判定的关键词数。 */
  readonly smoothKeywordCount?: number;
}

// 业务配置（lookbackDays/cooldownDays/threshold/factor）的单一真源为 DEFAULT_BUSINESS_CONFIG.penalty，
//  改值需同步递增 RECIPE_VERSION。此处保留同名 const 以便调用方 ?? 兜底不变。
const PENALTY = DEFAULT_BUSINESS_CONFIG.penalty;
const DEFAULT_LOOKBACK_DAYS = PENALTY.lookbackDays;
const DEFAULT_COOLDOWN_DAYS = PENALTY.cooldownDays;
const DEFAULT_LOSS_THRESHOLD_PCT = PENALTY.threshold;
const DEFAULT_PENALTY_FACTOR = PENALTY.factor;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
/** 平滑惩罚最小加权样本量：n<5 不惩罚（与 DEFAULT_SMOOTH_PENALTY_CONFIG 口径一致）。 */
const SMOOTH_MIN_SAMPLES = 5;
/** 审计 JSON 中保留的责任权重明细条数上限（避免 reason 字段无界膨胀）。 */
const AUDIT_RESPONSIBILITY_LIMIT = 6;

const minAvailableYield = (row: Record<string, unknown>, asOf: Date): number | null => {
  const values = visibleYields(row, asOf)
    .map(toNumberOrNull)
    .filter((value): value is number => value !== null);
  return values.length === 0 ? null : Math.min(...values);
};

/**
 * 成熟 5 日收益：只认已到期可见（yield5DayVisibleAt <= asOf）的 yield5Day。
 * 严禁用 yield1Day/yield3Day 顶替，缺失即视为不可用。
 */
const visibleMature5DayYield = (row: Record<string, unknown>, asOf: Date): number | null => {
  const timestamp = row.yield5DayVisibleAt;
  if (timestamp == null) {
    return null;
  }
  const visibleAt = new Date(timestamp as string | Date).getTime();
  if (!Number.isFinite(visibleAt) || visibleAt > asOf.getTime()) {
    return null;
  }
  return toNumberOrNull(row.yield5Day);
};

const normalizeKeyword = (value: unknown): string => {
  return String(value ?? '').trim();
};

const uniqueKeywordsFromEvidence = (row: Record<string, unknown>): readonly string[] => {
  return [...new Set([
    normalizeKeyword(row.keyword),
    normalizeKeyword(row.matchedExposureKeyword),
    normalizeKeyword(row.sourceKeyword),
  ].filter(keyword => keyword.length > 0))];
};

/** 北京时间口径的交易日键（YYYY-MM-DD）。 */
const toTradingDayKey = (value: Date | string): string =>
  new Date(new Date(value).getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);

interface ISessionCalendar {
  readonly sessions: readonly string[];
  readonly source: 'trading_calendar' | 'business_days_fallback';
}

/** 无交易日历表时的确定性退化：周一至周五计为交易日（审计字段会标注来源）。 */
const businessDaySessions = (asOf: Date, count: number): readonly string[] => {
  const days: string[] = [];
  let cursor = new Date(`${toTradingDayKey(asOf)}T00:00:00.000Z`);
  while (days.length < count) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      days.push(cursor.toISOString().slice(0, 10));
    }
    cursor = new Date(cursor.getTime() - ONE_DAY_MS);
  }
  return days.reverse();
};

const loadSessionCalendar = async (
  prisma: any,
  input: { readonly asOf: Date; readonly lookbackSessions: number },
): Promise<ISessionCalendar> => {
  const endDayKey = toTradingDayKey(input.asOf);
  if (typeof prisma?.tradingCalendarDay?.findMany === 'function') {
    const approximateStart = new Date(input.asOf.getTime() - (input.lookbackSessions * 3 + 30) * ONE_DAY_MS);
    const rows = (await prisma.tradingCalendarDay.findMany({
      where: { isOpen: true, date: { lte: input.asOf, gte: approximateStart } },
      select: { date: true },
      orderBy: { date: 'asc' },
    })) as Array<Record<string, unknown>>;
    const sessions = [...new Set(
      rows
        .map(row => (row?.date == null ? null : toTradingDayKey(row.date as Date)))
        .filter((day): day is string => typeof day === 'string' && day.length === 10 && day <= endDayKey),
    )].sort();
    if (sessions.length > 0) {
      return { sessions: sessions.slice(-(input.lookbackSessions + 1)), source: 'trading_calendar' };
    }
  }
  return { sessions: businessDaySessions(input.asOf, input.lookbackSessions + 1), source: 'business_days_fallback' };
};

/** 交易日龄：严格晚于触发日的交易日数量。 */
const sessionAge = (sessions: readonly string[], triggerDayKey: string): number =>
  sessions.reduce((count, session) => (session > triggerDayKey ? count + 1 : count), 0);

interface ISmoothObservation extends SmoothPenaltyObservation {
  readonly traceId: string;
  readonly symbol: string;
}

interface ISmoothPenaltyRow {
  readonly keyword: string;
  readonly factor: number;
  readonly basis: SmoothPenaltyResult;
  readonly observations: readonly ISmoothObservation[];
  readonly worst: ISmoothObservation;
}

const clampFactor = (value: number): number => Math.max(0, Math.min(1, value));

/** 触发观测：收益最差优先，其次按 traceId/symbol 字典序，保证确定性。 */
const compareSmoothObservation = (left: ISmoothObservation, right: ISmoothObservation): number =>
  left.return5DayPct - right.return5DayPct
  || left.traceId.localeCompare(right.traceId)
  || left.symbol.localeCompare(right.symbol);

/**
 * 只落库「有真实亏损样本且加权样本量 n>=5」的关键词，保证 n<5 不惩罚。
 *
 * `calculateSmoothPenalty` 的 factor 由 `1 - upgradeFactor × max(0, p − p0)` 给出：
 * `p0` 取自全局亏损率（跨关键词计算），`p` 为关键词自身的收缩估计，
 * 故 `p ≠ p0`、factor 可小于 1，惩罚机制真实生效（见 `event-scoring/smooth-penalty.ts`）。
 */
const buildSmoothPenaltyRows = (
  results: readonly SmoothPenaltyResult[],
  observations: readonly ISmoothObservation[],
  config: SmoothPenaltyConfig,
): readonly ISmoothPenaltyRow[] => {
  const byKeyword = new Map<string, ISmoothObservation[]>();
  for (const observation of observations) {
    const list = byKeyword.get(observation.keyword) ?? [];
    list.push(observation);
    byKeyword.set(observation.keyword, list);
  }

  const rows: ISmoothPenaltyRow[] = [];
  for (const basis of results) {
    const keywordObservations = [...(byKeyword.get(basis.keyword) ?? [])].sort(compareSmoothObservation);
    const hasLoss = keywordObservations.some(observation => observation.return5DayPct <= config.lossThreshold);
    if (!hasLoss || basis.n < SMOOTH_MIN_SAMPLES) {
      continue;
    }
    const worst = keywordObservations[0];
    if (!worst) {
      continue;
    }
    rows.push({
      keyword: basis.keyword,
      factor: clampFactor(basis.factor),
      basis,
      observations: keywordObservations,
      worst,
    });
  }

  return rows.sort((left, right) => left.factor - right.factor || left.keyword.localeCompare(right.keyword));
};

/**
 * 惩罚行 reason：人类可读说明 + 紧凑审计 JSON（计算基准、责任权重明细）。
 * 当前 schema 的 KeywordPerformancePenalty 没有独立 JSON 列，审计基准写入既有 reason 字段。
 */
const buildSmoothPenaltyReason = (input: {
  readonly penalty: ISmoothPenaltyRow;
  readonly config: SmoothPenaltyConfig;
  readonly calendar: ISessionCalendar;
  readonly windowStart: Date;
  readonly endDayKey: string;
  readonly unattributedPairs: number;
  readonly cooldownDays: number;
}): string => {
  const { penalty, config, calendar } = input;
  const responsibility = [...penalty.observations]
    .sort((left, right) =>
      right.responsibilityWeight - left.responsibilityWeight
      || left.traceId.localeCompare(right.traceId)
      || left.symbol.localeCompare(right.symbol))
    .slice(0, AUDIT_RESPONSIBILITY_LIMIT)
    .map(observation => [
      observation.traceId,
      observation.symbol,
      observation.ageSessions,
      Number(observation.return5DayPct.toFixed(4)),
      Number(observation.responsibilityWeight.toFixed(4)),
    ]);

  const audit = {
    recipe: 'event-v2',
    calendarSource: calendar.source,
    windowStart: calendar.sessions[0] ?? toTradingDayKey(input.windowStart),
    windowEnd: input.endDayKey,
    sessionCount: calendar.sessions.length,
    lookbackSessions: config.lookbackSessions,
    halfLifeSessions: config.halfLifeSessions,
    priorCount: config.priorCount,
    lossThreshold: config.lossThreshold,
    upgradeFactor: config.upgradeFactor,
    n: Number(penalty.basis.n.toFixed(4)),
    p0: Number(penalty.basis.p0.toFixed(4)),
    p: Number(penalty.basis.p.toFixed(4)),
    L: Number(penalty.basis.L.toFixed(4)),
    factor: Number(penalty.factor.toFixed(4)),
    applied: penalty.factor < 1,
    observationCount: penalty.observations.length,
    lossObservationCount: penalty.observations.filter(observation => observation.return5DayPct <= config.lossThreshold).length,
    unattributedPairs: input.unattributedPairs,
    responsibility,
  };

  return [
    `关键词 [${penalty.keyword}] event-v2 平滑惩罚 ${penalty.factor.toFixed(4)}`,
    `（p0=${penalty.basis.p0.toFixed(4)}，p=${penalty.basis.p.toFixed(4)}，n=${penalty.basis.n.toFixed(2)}）`,
    `触发股票 ${penalty.worst.symbol} 成熟 5 日收益 ${(penalty.worst.return5DayPct * 100).toFixed(2)}%`,
    `只用成熟 5 日收益；窗口 ${config.lookbackSessions} 个交易日、半衰期 ${config.halfLifeSessions}、先验 ${config.priorCount}、降权系数 ${config.upgradeFactor}、n<5 不惩罚`,
    `有效 ${input.cooldownDays} 天`,
    `｜smoothAudit=${JSON.stringify(audit)}`,
  ].join('');
};

export class KeywordPerformancePenaltyService {
  /**
   * 关键词表现惩罚刷新入口。
   *
   * event-v2（生产默认）：平滑惩罚，只用成熟 5 日收益，窗口 60 个交易日，
   * 半衰期 20 个交易日、先验 20、升级系数 0.6，n<5 不惩罚。
   * baseline-v1：保持原有「最差可用收益 <= 阈值」的阈值惩罚不变。
   */
  public async refresh(
    prisma: any,
    input: IKeywordPerformancePenaltyRefreshInput,
  ): Promise<IKeywordPerformancePenaltyRefreshResult> {
    const scoringRecipe = resolveScoringRecipe();
    const baseline = await this.refreshBaselinePenalty(prisma, input);
    if (scoringRecipe !== 'event-v2') {
      return { ...baseline, scoringRecipe };
    }

    // event-v2：在既有阈值惩罚之外，追加平滑惩罚（只用成熟 5 日收益）。
    // 两条来源可能命中同一 (clusterKey, triggerTraceId, triggerSymbol, keyword)，
    // 由唯一键 + skipDuplicates 去重；评分侧按关键词取最强惩罚，不会重复相乘。
    const smooth = await this.refreshSmoothPenalty(prisma, input);
    return {
      ...baseline,
      scoringRecipe,
      candidateKeywordCount: baseline.candidateKeywordCount + smooth.candidateKeywordCount,
      createdPenaltyCount: baseline.createdPenaltyCount + smooth.createdPenaltyCount,
      smoothObservationCount: smooth.smoothObservationCount,
      smoothKeywordCount: smooth.smoothKeywordCount,
    };
  }

  private async refreshBaselinePenalty(
    prisma: any,
    input: IKeywordPerformancePenaltyRefreshInput,
  ): Promise<IKeywordPerformancePenaltyRefreshResult> {
    const lookbackDays = input.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    const cooldownDays = input.cooldownDays ?? DEFAULT_COOLDOWN_DAYS;
    const lossThresholdPct = input.lossThresholdPct ?? DEFAULT_LOSS_THRESHOLD_PCT;
    const penaltyFactor = input.penaltyFactor ?? DEFAULT_PENALTY_FACTOR;

    if (!prisma.recommendationSnapshot?.findMany || !prisma.evidenceContribution?.findMany || !prisma.keywordPerformancePenalty?.createMany) {
      return {
        scannedRecommendations: 0,
        losingRecommendations: 0,
        candidateKeywordCount: 0,
        createdPenaltyCount: 0,
        lossThresholdPct,
        penaltyFactor,
        cooldownDays,
      };
    }

    const windowStart = new Date(input.asOf.getTime() - lookbackDays * ONE_DAY_MS);
    const recommendations = await prisma.recommendationSnapshot.findMany({
      where: {
        clusterKey: input.clusterKey,
        isReconciled: true,
        isPublished: true,
        asOf: {
          gte: windowStart,
          lt: input.asOf,
        },
      },
      select: {
        traceId: true,
        asOf: true,
        symbol: true,
        yield1Day: true,
        yield3Day: true,
        yield5Day: true,
        yield1DayVisibleAt: true,
        yield3DayVisibleAt: true,
        yield5DayVisibleAt: true,
      },
    }) as Array<Record<string, unknown>>;

    const losingRecommendations = recommendations
      .map(row => ({
        row,
        lossPct: minAvailableYield(row, input.asOf),
      }))
      .filter((item): item is { row: Record<string, unknown>; lossPct: number } => {
        return item.lossPct !== null && item.lossPct <= lossThresholdPct;
      });

    if (losingRecommendations.length === 0) {
      return {
        scannedRecommendations: recommendations.length,
        losingRecommendations: 0,
        candidateKeywordCount: 0,
        createdPenaltyCount: 0,
        lossThresholdPct,
        penaltyFactor,
        cooldownDays,
      };
    }

    const losingPairs = losingRecommendations.map(item => ({
      traceId: String(item.row.traceId),
      symbol: String(item.row.symbol),
      lossPct: item.lossPct,
      triggerAsOf: item.row.asOf instanceof Date ? item.row.asOf : new Date(String(item.row.asOf)),
    }));
    const lossByPair = new Map(losingPairs.map(pair => [`${pair.traceId}\u0000${pair.symbol}`, pair]));
    const evidenceRows = await prisma.evidenceContribution.findMany({
      where: {
        clusterKey: input.clusterKey,
        OR: losingPairs.map(pair => ({
          traceId: pair.traceId,
          symbol: pair.symbol,
        })),
      },
      select: {
        traceId: true,
        symbol: true,
        keyword: true,
        matchedExposureKeyword: true,
        sourceKeyword: true,
      },
    }) as Array<Record<string, unknown>>;

    const penaltyByKey = new Map<string, Record<string, unknown>>();
    const validTo = new Date(input.asOf.getTime() + cooldownDays * ONE_DAY_MS);
    for (const evidence of evidenceRows) {
      const traceId = String(evidence.traceId);
      const symbol = String(evidence.symbol);
      const pair = lossByPair.get(`${traceId}\u0000${symbol}`);
      if (!pair) {
        continue;
      }
      for (const keyword of uniqueKeywordsFromEvidence(evidence)) {
        const key = `${input.clusterKey}\u0000${traceId}\u0000${symbol}\u0000${keyword}`;
        penaltyByKey.set(key, {
          clusterKey: input.clusterKey,
          keyword,
          factor: new Prisma.Decimal(penaltyFactor),
          lossPct: new Prisma.Decimal(pair.lossPct),
          thresholdPct: new Prisma.Decimal(lossThresholdPct),
          triggerTraceId: traceId,
          triggerSymbol: symbol,
          triggerAsOf: pair.triggerAsOf,
          validFrom: input.asOf,
          validTo,
          reason: `推荐股票 ${symbol} 对账最差收益 ${(pair.lossPct * 100).toFixed(2)}%，低于阈值 ${(lossThresholdPct * 100).toFixed(2)}%，关键词降权 ${cooldownDays} 天`,
        });
      }
    }

    const rows = [...penaltyByKey.values()];
    if (rows.length > 0) {
      const result = await prisma.keywordPerformancePenalty.createMany({
        data: rows,
        skipDuplicates: true,
      });
      return {
        scannedRecommendations: recommendations.length,
        losingRecommendations: losingRecommendations.length,
        candidateKeywordCount: rows.length,
        createdPenaltyCount: Number(result.count ?? rows.length),
        lossThresholdPct,
        penaltyFactor,
        cooldownDays,
      };
    }

    return {
      scannedRecommendations: recommendations.length,
      losingRecommendations: losingRecommendations.length,
      candidateKeywordCount: 0,
      createdPenaltyCount: 0,
      lossThresholdPct,
      penaltyFactor,
      cooldownDays,
    };
  }

  /**
   * event-v2 平滑惩罚：只用成熟 5 日收益，按交易日龄半衰 + 责任权重加权，
   * 损失强度 L=Σ(timeWeight × responsibilityWeight × −r5)，p=(L+prior×p0)/(n+prior)，
   * factor=1−0.6×max(0,p−p0)，n<5 时 factor=1（不惩罚）。
   */
  private async refreshSmoothPenalty(
    prisma: any,
    input: IKeywordPerformancePenaltyRefreshInput,
  ): Promise<IKeywordPerformancePenaltyRefreshResult> {
    const cooldownDays = input.cooldownDays ?? DEFAULT_COOLDOWN_DAYS;
    const config: SmoothPenaltyConfig = {
      ...DEFAULT_SMOOTH_PENALTY_CONFIG,
      ...(input.lossThresholdPct === undefined ? {} : { lossThreshold: input.lossThresholdPct }),
      ...(input.penaltyFactor === undefined ? {} : { upgradeFactor: input.penaltyFactor }),
    };

    if (!prisma?.recommendationSnapshot?.findMany
      || !prisma?.evidenceContribution?.findMany
      || !prisma?.keywordPerformancePenalty?.createMany) {
      return {
        scannedRecommendations: 0,
        losingRecommendations: 0,
        candidateKeywordCount: 0,
        createdPenaltyCount: 0,
        lossThresholdPct: config.lossThreshold,
        penaltyFactor: config.upgradeFactor,
        cooldownDays,
        scoringRecipe: 'event-v2',
        smoothObservationCount: 0,
        smoothKeywordCount: 0,
      };
    }

    const calendar = await loadSessionCalendar(prisma, {
      asOf: input.asOf,
      lookbackSessions: config.lookbackSessions,
    });
    const endDayKey = toTradingDayKey(input.asOf);
    const windowStart = new Date(`${calendar.sessions[0] ?? endDayKey}T00:00:00.000Z`);

    const recommendations = await prisma.recommendationSnapshot.findMany({
      where: {
        clusterKey: input.clusterKey,
        isReconciled: true,
        isPublished: true,
        asOf: {
          gte: windowStart,
          lt: input.asOf,
        },
      },
      select: {
        traceId: true,
        asOf: true,
        symbol: true,
        yield5Day: true,
        yield5DayVisibleAt: true,
      },
    }) as Array<Record<string, unknown>>;

    const matureObservations = recommendations
      .map(row => ({
        row,
        return5DayPct: visibleMature5DayYield(row, input.asOf),
      }))
      .filter((item): item is { row: Record<string, unknown>; return5DayPct: number } => item.return5DayPct !== null);

    const resultBase = {
      scannedRecommendations: recommendations.length,
      losingRecommendations: matureObservations.filter(item => item.return5DayPct <= config.lossThreshold).length,
      lossThresholdPct: config.lossThreshold,
      penaltyFactor: config.upgradeFactor,
      cooldownDays,
      scoringRecipe: 'event-v2',
    };

    if (matureObservations.length === 0) {
      return {
        ...resultBase,
        candidateKeywordCount: 0,
        createdPenaltyCount: 0,
        smoothObservationCount: 0,
        smoothKeywordCount: 0,
      };
    }

    const pairs = matureObservations.map(item => ({
      traceId: String(item.row.traceId),
      symbol: String(item.row.symbol),
      triggerAsOf: item.row.asOf instanceof Date ? item.row.asOf : new Date(String(item.row.asOf)),
      return5DayPct: item.return5DayPct,
    }));
    const pairByKey = new Map(pairs.map(pair => [`${pair.traceId}\u0000${pair.symbol}`, pair]));

    const evidenceRows = await prisma.evidenceContribution.findMany({
      where: {
        clusterKey: input.clusterKey,
        OR: pairs.map(pair => ({
          traceId: pair.traceId,
          symbol: pair.symbol,
        })),
      },
      select: {
        traceId: true,
        symbol: true,
        keyword: true,
        matchedExposureKeyword: true,
        sourceKeyword: true,
        finalContribScore: true,
      },
    }) as Array<Record<string, unknown>>;

    // 责任权重：该关键词在本次推荐里的正向证据质量占该股票全部关键词质量的比例。
    const keywordMassByPair = new Map<string, Map<string, number>>();
    for (const evidence of evidenceRows) {
      const pairKey = `${String(evidence.traceId)}\u0000${String(evidence.symbol)}`;
      if (!pairByKey.has(pairKey)) {
        continue;
      }
      const mass = toNumberOrNull(evidence.finalContribScore) ?? 0;
      if (mass <= 0) {
        continue;
      }
      const byKeyword = keywordMassByPair.get(pairKey) ?? new Map<string, number>();
      for (const keyword of uniqueKeywordsFromEvidence(evidence)) {
        byKeyword.set(keyword, Math.max(byKeyword.get(keyword) ?? 0, mass));
      }
      keywordMassByPair.set(pairKey, byKeyword);
    }

    const observations: ISmoothObservation[] = [];
    let unattributedPairs = 0;
    for (const pair of pairs) {
      const byKeyword = keywordMassByPair.get(`${pair.traceId}\u0000${pair.symbol}`);
      if (!byKeyword || byKeyword.size === 0) {
        unattributedPairs += 1;
        continue;
      }
      const totalMass = [...byKeyword.values()].reduce((sum, value) => sum + value, 0);
      if (totalMass <= 0) {
        unattributedPairs += 1;
        continue;
      }
      const ageSessions = sessionAge(calendar.sessions, toTradingDayKey(pair.triggerAsOf));
      if (ageSessions > config.lookbackSessions) {
        continue;
      }
      for (const keyword of [...byKeyword.keys()].sort()) {
        observations.push({
          keyword,
          traceId: pair.traceId,
          symbol: pair.symbol,
          return5DayPct: pair.return5DayPct,
          ageSessions,
          responsibilityWeight: (byKeyword.get(keyword) ?? 0) / totalMass,
        });
      }
    }

    const penalties = buildSmoothPenaltyRows(calculateSmoothPenalty(observations, config), observations, config);
    const validTo = new Date(input.asOf.getTime() + cooldownDays * ONE_DAY_MS);
    const rows = penalties.map(penalty => ({
      clusterKey: input.clusterKey,
      keyword: penalty.keyword,
      factor: new Prisma.Decimal(penalty.factor.toFixed(4)),
      lossPct: new Prisma.Decimal(penalty.worst.return5DayPct.toFixed(6)),
      thresholdPct: new Prisma.Decimal(config.lossThreshold.toFixed(6)),
      triggerTraceId: penalty.worst.traceId,
      triggerSymbol: penalty.worst.symbol,
      triggerAsOf: input.asOf,
      validFrom: input.asOf,
      validTo,
      reason: buildSmoothPenaltyReason({
        penalty,
        config,
        calendar,
        windowStart,
        endDayKey,
        unattributedPairs,
        cooldownDays,
      }),
    }));

    if (rows.length === 0) {
      return {
        ...resultBase,
        candidateKeywordCount: 0,
        createdPenaltyCount: 0,
        smoothObservationCount: observations.length,
        smoothKeywordCount: 0,
      };
    }

    const created = await prisma.keywordPerformancePenalty.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return {
      ...resultBase,
      candidateKeywordCount: rows.length,
      createdPenaltyCount: Number(created?.count ?? rows.length),
      smoothObservationCount: observations.length,
      smoothKeywordCount: penalties.length,
    };
  }
}
