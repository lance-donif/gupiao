import { describe, expect, it } from 'vitest';
import {
  buildEventEvidenceFeatures,
  contributionEvidenceId,
  resolveEvidenceDirection,
  toEventEvidenceItem,
} from '../../../src/services/scoring/scoring-helpers.js';
import { calculateEvidenceComponentScore } from '../../../src/services/scoring-contribution-engine.js';
import { KeywordPerformancePenaltyService } from '../../../src/services/keyword-performance-penalty-service.js';

const contribution = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  traceId: 'trace-1',
  newsId: 'news-1',
  symbol: '600111',
  keyword: '白银',
  matchedExposureKeyword: '白银',
  exposureFactId: 'exp-1',
  matchMethod: 'exact_keyword',
  finalContribScore: 0.5,
  __signalEvent: '库存下降',
  __businessVariable: '供给不足',
  __direction: 'positive',
  ...over,
});

/** 评分配方由 SCORING_RECIPE 驱动（生产默认 event-v2），断言时必须显式锁定口径。 */
const withRecipe = async <T>(
  recipe: 'baseline-v1' | 'event-v2',
  run: () => Promise<T>,
): Promise<T> => {
  const previous = process.env.SCORING_RECIPE;
  process.env.SCORING_RECIPE = recipe;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.SCORING_RECIPE;
    } else {
      process.env.SCORING_RECIPE = previous;
    }
  }
};

const shuffledCopies = <T>(items: readonly T[]): readonly (readonly T[])[] => [
  [...items].reverse(),
  [...items.slice(2), ...items.slice(0, 2)],
  [...items.slice(1), ...items.slice(0, 1)],
];

describe('event-v2 evidence features', () => {
  it('keeps the max effective contribution for the same event and tie-breaks by evidence id', () => {
    const rows = [
      contribution({ newsId: 'news-a', finalContribScore: 0.4 }),
      contribution({ newsId: 'news-c', finalContribScore: 0.7 }),
      contribution({ newsId: 'news-b', finalContribScore: 0.7 }),
    ];

    const [summary] = buildEventEvidenceFeatures(rows).summaries;

    // 同一（关键词/经营变量/极性/事件）只保留一条：0.7 并列时取 evidenceId 字典序更小者。
    expect(summary!.Eplus).toBeCloseTo(0.7, 9);
    expect(summary!.E).toBeCloseTo(0.7, 9);
    expect(summary!.topEvents).toHaveLength(1);
    expect(summary!.topEvents[0]!.evidenceIds).toEqual([contributionEvidenceId(rows[2]!)]);
  });

  it('aggregates at most three independent events per keyword with 1-∏(1-q)', () => {
    const rows = [
      contribution({ newsId: 'n1', __signalEvent: '事件A', finalContribScore: 0.9 }),
      contribution({ newsId: 'n2', __signalEvent: '事件B', finalContribScore: 0.8 }),
      contribution({ newsId: 'n3', __signalEvent: '事件C', finalContribScore: 0.7 }),
      contribution({ newsId: 'n4', __signalEvent: '事件D', finalContribScore: 0.6 }),
    ];

    const features = buildEventEvidenceFeatures(rows);
    const [summary] = features.summaries;

    // top-3 生效：0.6 的第 4 个独立事件不进入聚合。
    expect(summary!.topEvents).toHaveLength(3);
    expect(summary!.Eplus).toBeCloseTo(1 - (1 - 0.9) * (1 - 0.8) * (1 - 0.7), 9);
    expect(features.keywordScores.get('白银')).toBeCloseTo(summary!.Eplus, 9);
    expect(features.itemCount).toBe(4);
  });

  it('separates positive and negative evidence and floors E at zero', () => {
    const balanced = buildEventEvidenceFeatures([
      contribution({ newsId: 'pos', __signalEvent: '利好', finalContribScore: 0.6 }),
      contribution({ newsId: 'neg', __signalEvent: '利空', __direction: 'negative', finalContribScore: 0.5 }),
    ]).summaries[0]!;

    expect(balanced.Eplus).toBeCloseTo(0.6, 9);
    expect(balanced.Eminus).toBeCloseTo(0.5, 9);
    expect(balanced.E).toBeCloseTo(0.1, 9);

    const dominated = buildEventEvidenceFeatures([
      contribution({ newsId: 'pos', __signalEvent: '利好', finalContribScore: 0.2 }),
      contribution({ newsId: 'neg', __signalEvent: '利空', __direction: 'negative', finalContribScore: 0.9 }),
    ]).summaries[0]!;

    expect(dominated.E).toBe(0);
    expect(dominated.Eminus).toBeCloseTo(0.9, 9);
  });

  it('is invariant to input order and to duplicate rows', () => {
    const rows = [
      contribution({ newsId: 'n1', __signalEvent: '事件A', finalContribScore: 0.55 }),
      contribution({ newsId: 'n2', __signalEvent: '事件B', finalContribScore: 0.45 }),
      contribution({ newsId: 'n3', __signalEvent: '事件B', finalContribScore: 0.4 }),
      contribution({ newsId: 'n4', __signalEvent: '事件C', __direction: 'negative', finalContribScore: 0.2 }),
      contribution({ newsId: 'n5', __signalEvent: '事件D', finalContribScore: 0.3 }),
    ];

    const expected = buildEventEvidenceFeatures(rows);
    for (const shuffled of shuffledCopies(rows)) {
      const actual = buildEventEvidenceFeatures(shuffled);
      expect(actual.summaries).toEqual(expected.summaries);
      expect([...actual.keywordScores.entries()]).toEqual([...expected.keywordScores.entries()]);
      expect(actual.aggregatedEvidence).toBe(expected.aggregatedEvidence);
    }
    expect(calculateEvidenceComponentScore(expected.keywordScores)).toBe(
      calculateEvidenceComponentScore(buildEventEvidenceFeatures([...rows].reverse()).keywordScores),
    );
  });

  it('scores from aggregated E instead of raw summed contributions', () => {
    const rows = [
      contribution({ newsId: 'n1', __signalEvent: '事件A', finalContribScore: 0.3 }),
      contribution({ newsId: 'n2', __signalEvent: '事件B', finalContribScore: 0.3 }),
      contribution({ newsId: 'n3', __signalEvent: '事件C', finalContribScore: 0.3 }),
    ];

    const features = buildEventEvidenceFeatures(rows);
    const eventScore = calculateEvidenceComponentScore(features.keywordScores);
    const rawSum = rows.reduce((sum, row) => sum + Number(row.finalContribScore), 0);
    const baselineScore = calculateEvidenceComponentScore(new Map([['白银', rawSum]]));

    expect(features.keywordScores.get('白银')).toBeCloseTo(1 - 0.7 ** 3, 9);
    // 三条同关键词事件：E 聚合后小于原始求和，证据分随之更低，但权重仍是 45 分满分。
    expect(eventScore).toBeLessThan(baselineScore);
    expect(eventScore).toBeLessThanOrEqual(45);
    expect(eventScore).toBeGreaterThan(0);
  });

  it('produces zero aggregated evidence when no positive exposure evidence exists', () => {
    const features = buildEventEvidenceFeatures([
      contribution({ __direction: 'neutral' }),
      contribution({ newsId: 'zero', finalContribScore: 0 }),
      contribution({ newsId: 'negative-only', __direction: 'negative' }),
    ]);

    expect(features.aggregatedEvidence).toBe(0);
    expect(features.keywordScores.size).toBe(0);
    expect(features.itemCount).toBe(1);
    expect(calculateEvidenceComponentScore(features.keywordScores)).toBe(0);
  });

  it('maps rows deterministically and falls back to the exposure path for legacy rows', () => {
    const legacy = contribution({ __direction: undefined });
    const withoutKeyword = contribution({
      keyword: undefined,
      matchedExposureKeyword: undefined,
      exposureFactId: undefined,
      __direction: undefined,
    });

    expect(contributionEvidenceId(legacy)).toBe([
      'trace-1', 'news-1', '600111', '白银', 'exp-1', 'exact_keyword',
    ].join('|'));
    expect(resolveEvidenceDirection(legacy)).toBe('positive');
    expect(resolveEvidenceDirection(withoutKeyword)).toBe('neutral');
    expect(toEventEvidenceItem(withoutKeyword)).toBeNull();
    expect(toEventEvidenceItem(contribution({ matchedExposureKeyword: null }))!.canonicalKeyword).toBe('白银');
  });
});

class MockSmoothPenaltyPrisma {
  public recommendationRows: any[] = [];
  public evidenceRows: any[] = [];
  public penaltyRows: any[] = [];
  public calendarRows: any[] = [];

  public readonly recommendationSnapshot = {
    findMany: async (args?: any) => {
      let rows = this.recommendationRows;
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (args?.where?.asOf?.gte) {
        rows = rows.filter(row => row.asOf >= args.where.asOf.gte);
      }
      if (args?.where?.asOf?.lt) {
        rows = rows.filter(row => row.asOf < args.where.asOf.lt);
      }
      return rows;
    },
  };

  public readonly evidenceContribution = {
    findMany: async (args?: any) => {
      let rows = this.evidenceRows;
      if (args?.where?.clusterKey) {
        rows = rows.filter(row => row.clusterKey === args.where.clusterKey);
      }
      if (Array.isArray(args?.where?.OR)) {
        rows = rows.filter(row => args.where.OR.some((condition: any) =>
          row.traceId === condition.traceId && row.symbol === condition.symbol));
      }
      return rows;
    },
  };

  public readonly keywordPerformancePenalty = {
    createMany: async (args: { data: any[] }) => {
      this.penaltyRows.push(...args.data);
      return { count: args.data.length };
    },
  };

  public readonly tradingCalendarDay = {
    findMany: async (args?: any) => {
      let rows = this.calendarRows;
      if (args?.where?.isOpen !== undefined) {
        rows = rows.filter(row => row.isOpen === args.where.isOpen);
      }
      if (args?.where?.date?.gte) {
        rows = rows.filter(row => row.date >= args.where.date.gte);
      }
      if (args?.where?.date?.lte) {
        rows = rows.filter(row => row.date <= args.where.date.lte);
      }
      return [...rows].sort((left, right) => left.date.getTime() - right.date.getTime());
    },
  };
}

/** 2026-06-05 之前连续的周一至周五交易日历（含 06-05 当天）。 */
const buildWeekdayCalendar = (from: string, to: string): any[] => {
  const days: any[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor.getTime() <= end.getTime()) {
    const weekday = cursor.getUTCDay();
    days.push({ isOpen: weekday !== 0 && weekday !== 6, date: new Date(cursor.getTime()) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
};

const smoothRows = (rows: readonly any[]): any[] =>
  rows.filter(row => String(row.reason).includes('smoothAudit='));

const auditFrom = (reason: unknown): Record<string, any> =>
  JSON.parse(/smoothAudit=(\{.*\})$/u.exec(String(reason))![1]!);

describe('event-v2 smooth keyword penalty wiring', () => {
  const asOf = new Date('2026-06-05T09:00:00.000Z');
  const clusterKey = 'global';

  const buildClient = (overrides: Partial<MockSmoothPenaltyPrisma> = {}): MockSmoothPenaltyPrisma => {
    const client = new MockSmoothPenaltyPrisma();
    client.calendarRows = buildWeekdayCalendar('2026-04-01', '2026-06-05');
    return Object.assign(client, overrides);
  };

  it('only counts mature 5-day yields and never substitutes yield1Day/yield3Day', async () => {
    const client = buildClient();
    client.recommendationRows = [{
      traceId: 'trace-immature',
      symbol: '600001',
      clusterKey,
      asOf: new Date('2026-06-03T09:00:00.000Z'),
      isReconciled: true,
      isPublished: true,
      yield1Day: '-0.4000',
      yield1DayVisibleAt: new Date('2026-06-04T07:00:00Z'),
      yield3Day: '-0.3000',
      yield3DayVisibleAt: new Date('2026-06-08T07:00:00Z'),
      yield5Day: '-0.5000',
      // 5 日收益尚未到期可见 → 不能进入平滑惩罚证据。
      yield5DayVisibleAt: new Date('2026-06-12T07:00:00Z'),
    }];
    client.evidenceRows = [{
      traceId: 'trace-immature',
      symbol: '600001',
      clusterKey,
      keyword: '锂',
      finalContribScore: 0.5,
    }];

    const result = await withRecipe('event-v2', () => new KeywordPerformancePenaltyService().refresh(client, {
      asOf,
      clusterKey,
    }));

    expect(result.scoringRecipe).toBe('event-v2');
    expect(result.smoothObservationCount).toBe(0);
    expect(result.smoothKeywordCount).toBe(0);
    expect(smoothRows(client.penaltyRows)).toHaveLength(0);
    // 既有阈值惩罚仍按可见收益照常落库（兼容位不变）。
    expect(client.penaltyRows.length).toBeGreaterThan(0);
  });

  it('penalizes mature losing keywords and persists the audit basis with responsibility weights', async () => {
    const client = buildClient();
    // 触发日 = asOf 的前一个交易日，交易日龄 1 → 加权样本量 n≈5.4>=5。
    const triggerAsOf = new Date('2026-06-04T09:00:00.000Z');
    client.recommendationRows = [0, 1, 2, 3, 4, 5].map(index => ({
      traceId: `trace-loss-${index}`,
      symbol: `60000${index + 1}`,
      clusterKey,
      asOf: triggerAsOf,
      isReconciled: true,
      isPublished: true,
      yield5Day: index === 0 ? '-0.0600' : '-0.0450',
      yield5DayVisibleAt: new Date('2026-06-04T07:00:00.000Z'),
    }));
    client.evidenceRows = [0, 1, 2, 3, 4, 5].flatMap(index => {
      const base = {
        traceId: `trace-loss-${index}`,
        symbol: `60000${index + 1}`,
        clusterKey,
        keyword: '锂',
        finalContribScore: index === 0 ? 0.6 : 0.4,
      };
      return index === 0 ? [base, { ...base, keyword: '电池', finalContribScore: 0.4 }] : [base];
    });

    const result = await withRecipe('event-v2', () => new KeywordPerformancePenaltyService().refresh(client, {
      asOf,
      clusterKey,
    }));
    const rows = smoothRows(client.penaltyRows);

    expect(result.smoothObservationCount).toBe(7);
    expect(result.smoothKeywordCount).toBe(rows.length);
    // 电池只出现在 1 个推荐里（n≈0.87<5），只有锂达到最小样本量。
    expect(rows.map(row => String(row.keyword)).sort()).toEqual(['锂']);

    const lithium = rows.find(row => row.keyword === '锂')!;
    const audit = auditFrom(lithium.reason);
    expect(Number(lithium.factor)).toBeGreaterThan(0);
    expect(Number(lithium.factor)).toBeLessThanOrEqual(1);
    expect(Number(lithium.lossPct)).toBeCloseTo(-0.06, 6);
    expect(lithium.triggerSymbol).toBe('600001');
    expect(lithium.validFrom.toISOString()).toBe(asOf.toISOString());
    expect(lithium.validTo.toISOString()).toBe('2026-06-12T09:00:00.000Z');
    expect(String(lithium.reason)).toContain('只用成熟 5 日收益');
    expect(audit).toMatchObject({
      recipe: 'event-v2',
      calendarSource: 'trading_calendar',
      lookbackSessions: 60,
      halfLifeSessions: 20,
      priorCount: 20,
      lossThreshold: -0.03,
      upgradeFactor: 0.6,
      observationCount: 6,
      lossObservationCount: 6,
    });
    // 责任权重按「单次推荐内」归一：trace-loss-0 的锂 0.6/1.0，其余推荐只有一个关键词 → 1.0。
    expect(audit.responsibility[0]![0]).toBe('trace-loss-1');
    expect(audit.responsibility[0]![4]).toBeCloseTo(1, 4);
    const firstPairEntry = audit.responsibility.find((entry: any[]) => entry[0] === 'trace-loss-0');
    expect(firstPairEntry![3]).toBeCloseTo(-0.06, 4);
    expect(firstPairEntry![4]).toBeCloseTo(0.6, 4);
    expect(audit.responsibility.reduce((sum: number, entry: any[]) => sum + entry[4], 0)).toBeCloseTo(5.6, 4);
    expect(audit.windowEnd).toBe('2026-06-05');
  });

  it('does not create smooth penalties below the n>=5 sample floor', async () => {
    const client = buildClient();
    client.recommendationRows = [0, 1].map(index => ({
      traceId: `trace-few-${index}`,
      symbol: `60010${index}`,
      clusterKey,
      asOf: new Date('2026-06-04T09:00:00.000Z'),
      isReconciled: true,
      isPublished: true,
      yield5Day: '-0.0500',
      yield5DayVisibleAt: new Date('2026-06-04T07:00:00.000Z'),
    }));
    client.evidenceRows = [0, 1].map(index => ({
      traceId: `trace-few-${index}`,
      symbol: `60010${index}`,
      clusterKey,
      keyword: '锂',
      finalContribScore: 0.5,
    }));

    const result = await withRecipe('event-v2', () => new KeywordPerformancePenaltyService().refresh(client, {
      asOf,
      clusterKey,
    }));

    expect(result.smoothObservationCount).toBe(2);
    expect(result.smoothKeywordCount).toBe(0);
    expect(smoothRows(client.penaltyRows)).toHaveLength(0);
  });

  it('falls back to business-day sessions when the trading calendar is empty', async () => {
    const client = buildClient();
    client.calendarRows = [];
    client.recommendationRows = [0, 1, 2, 3, 4, 5].map(index => ({
      traceId: `trace-fallback-${index}`,
      symbol: `60020${index}`,
      clusterKey,
      asOf: new Date('2026-06-01T09:00:00.000Z'),
      isReconciled: true,
      isPublished: true,
      yield5Day: '-0.0450',
      yield5DayVisibleAt: new Date('2026-06-04T07:00:00.000Z'),
    }));
    client.evidenceRows = [0, 1, 2, 3, 4, 5].map(index => ({
      traceId: `trace-fallback-${index}`,
      symbol: `60020${index}`,
      clusterKey,
      keyword: '锂',
      finalContribScore: 0.5,
    }));

    await withRecipe('event-v2', () => new KeywordPerformancePenaltyService().refresh(client, { asOf, clusterKey }));
    const audit = auditFrom(smoothRows(client.penaltyRows)[0]!.reason);

    expect(audit.calendarSource).toBe('business_days_fallback');
    expect(audit.sessionCount).toBe(61);
  });
});
