import { describe, expect, it } from 'vitest';
import {
  buildRecommendationSnapshotYieldUpdate,
  buildYieldRecordDrafts,
  YIELD_COMPUTE_VERSION,
} from '../../../src/services/backtest-engine.js';

const NOW = new Date('2026-09-11T20:00:00+08:00');

const candle = (day: string, close: number, tradingStatus: string | null = 'NORMAL') => ({
  tradingDay: new Date(`${day}T00:00:00+08:00`),
  close,
  tradingStatus,
});

const draftsFor = (p0: number, futureCandles: ReturnType<typeof candle>[]) =>
  buildYieldRecordDrafts({
    snapshotId: 'snap-1',
    symbol: '000001',
    p0,
    futureCandles,
    computeVersion: YIELD_COMPUTE_VERSION,
    maturityReferenceTime: NOW,
  });

describe('buildRecommendationSnapshotYieldUpdate', () => {
  it('5 日齐全时回填全部收益并收口', () => {
    const future = [
      candle('2026-09-02', 10.5),
      candle('2026-09-03', 10.2),
      candle('2026-09-04', 11),
      candle('2026-09-05', 10.8),
      candle('2026-09-08', 12),
    ];
    const update = buildRecommendationSnapshotYieldUpdate({ p0: 10, futureCandles: future, drafts: draftsFor(10, future) });
    expect(update).not.toBeNull();
    expect(update!.yield1Day).toBeCloseTo(0.05, 10);
    expect(update!.yield3Day).toBeCloseTo(0.1, 10);
    expect(update!.yield5Day).toBeCloseTo(0.2, 10);
    expect(update!.yield5DayVisibleAt).toBeInstanceOf(Date);
    expect(update!.realizedPrice).toBe(10);
    expect(update!.realizedPriceTarget).toBe(12);
    expect(update!.isReconciled).toBe(true);
  });

  it('只有 1 日成熟时回填 1 日收益但不收口', () => {
    const future = [candle('2026-09-02', 9.5)];
    const update = buildRecommendationSnapshotYieldUpdate({ p0: 10, futureCandles: future, drafts: draftsFor(10, future) });
    expect(update).not.toBeNull();
    expect(update!.yield1Day).toBeCloseTo(-0.05, 10);
    expect(update!.yield3Day).toBeNull();
    expect(update!.yield5Day).toBeNull();
    expect(update!.yield5DayVisibleAt).toBeNull();
    expect(update!.realizedPriceTarget).toBe(9.5);
    expect(update!.isReconciled).toBe(false);
  });

  it('无 asOf 后 K 线时返回 null（不收口，待未来数据）', () => {
    expect(buildRecommendationSnapshotYieldUpdate({ p0: 10, futureCandles: [], drafts: [] })).toBeNull();
  });

  it('p0 非法时返回 null', () => {
    const future = [candle('2026-09-02', 10.5)];
    expect(buildRecommendationSnapshotYieldUpdate({ p0: 0, futureCandles: future, drafts: draftsFor(0, future) })).toBeNull();
    expect(buildRecommendationSnapshotYieldUpdate({ p0: NaN, futureCandles: future, drafts: draftsFor(NaN, future) })).toBeNull();
  });

  it('5 日受限（涨跌停）pending 也收口，保留窗口收益', () => {
    const future = [
      candle('2026-09-02', 10.5),
      candle('2026-09-03', 10.2),
      candle('2026-09-04', 11),
      candle('2026-09-05', 10.8),
      candle('2026-09-08', 9, 'LIMIT_DOWN'),
    ];
    const update = buildRecommendationSnapshotYieldUpdate({ p0: 10, futureCandles: future, drafts: draftsFor(10, future) });
    expect(update).not.toBeNull();
    expect(update!.yield5Day).toBeCloseTo(-0.1, 10);
    expect(update!.isReconciled).toBe(true);
  });
});
