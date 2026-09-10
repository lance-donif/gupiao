/**
 * M6 smooth keyword performance penalty candidate.
 * Pure calculations; production wiring lives in KeywordPerformancePenaltyService.
 */

export interface SmoothPenaltyConfig {
  readonly lookbackSessions: number;
  readonly lossThreshold: number;
  readonly halfLifeSessions: number;
  readonly priorCount: number;
  readonly upgradeFactor: number;
}

export interface SmoothPenaltyObservation {
  readonly keyword: string;
  readonly return5DayPct: number;
  readonly ageSessions: number;
  /** Responsibility weight assigned to this keyword from positive evidence share. */
  readonly responsibilityWeight: number;
}

export interface SmoothPenaltyResult {
  readonly keyword: string;
  readonly p0: number;
  readonly n: number;
  readonly L: number;
  readonly p: number;
  readonly factor: number;
  readonly observations: ReadonlyArray<{
    readonly return5DayPct: number;
    readonly timeWeight: number;
    readonly responsibilityWeight: number;
    readonly lossWeight: number;
  }>;
}

export const DEFAULT_SMOOTH_PENALTY_CONFIG: SmoothPenaltyConfig = {
  lookbackSessions: 60,
  lossThreshold: -0.03,
  halfLifeSessions: 20,
  priorCount: 20,
  upgradeFactor: 0.6,
};

const timeWeight = (ageSessions: number, halfLifeSessions: number): number =>
  Math.pow(0.5, Math.max(0, ageSessions) / halfLifeSessions);

export const calculateSmoothPenalty = (
  observations: readonly SmoothPenaltyObservation[],
  config: SmoothPenaltyConfig = DEFAULT_SMOOTH_PENALTY_CONFIG,
): SmoothPenaltyResult[] => {
  /**
   * 权重 = 时间权重 × 责任权重；亏损量 = 命中亏损阈值的权重（0/1 指示，不是收益幅度）。
   * 全局亏损率 p0 = 全部观测的亏损量 / 全部观测权重，必须跨关键词计算；
   * 若用关键词自身的 L/n 当基准，`p=(L+prior·p0)/(n+prior)` 会恒等于 p0、factor 恒为 1。
   */
  const toDetail = (o: SmoothPenaltyObservation) => {
    const tw = timeWeight(o.ageSessions, config.halfLifeSessions);
    const rw = Math.max(0, o.responsibilityWeight);
    const weight = tw * rw;
    const isLoss = Number(o.return5DayPct) <= config.lossThreshold;
    return {
      return5DayPct: Number(o.return5DayPct),
      timeWeight: tw,
      responsibilityWeight: rw,
      weight,
      lossWeight: isLoss ? weight : 0,
    };
  };

  const allDetails = observations.map(toDetail);
  const globalWeight = allDetails.reduce((sum, d) => sum + d.weight, 0);
  const globalLoss = allDetails.reduce((sum, d) => sum + d.lossWeight, 0);
  const globalLossRate = globalWeight > 0 ? globalLoss / globalWeight : 0;

  const keywordMap = new Map<string, SmoothPenaltyObservation[]>();
  for (const o of observations) {
    const list = keywordMap.get(o.keyword) ?? [];
    list.push(o);
    keywordMap.set(o.keyword, list);
  }
  const results: SmoothPenaltyResult[] = [];
  for (const [keyword, rows] of keywordMap) {
    const det = rows.map(toDetail);
    const n = det.reduce((sum, d) => sum + d.weight, 0);
    const L = det.reduce((sum, d) => sum + d.lossWeight, 0);
    const p0 = globalLossRate;
    const p = (L + config.priorCount * p0) / (n + config.priorCount);
    const factor = n < 5 ? 1 : 1 - config.upgradeFactor * Math.max(0, p - p0);
    results.push({
      keyword,
      p0,
      n,
      L,
      p,
      factor,
      observations: det.map(d => ({
        return5DayPct: d.return5DayPct,
        timeWeight: d.timeWeight,
        responsibilityWeight: d.responsibilityWeight,
        lossWeight: d.lossWeight,
      })),
    });
  }
  return results.sort((a, b) => a.keyword.localeCompare(b.keyword));
};
