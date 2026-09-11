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

const updateFor = (p0: number, futureCandles: ReturnType<typeof candle>[]) =>
  buildRecommendationSnapshotYieldUpdate({
    p0,
    futureCandles,
    drafts: draftsFor(p0, futureCandles),
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
    const update = updateFor(10, future);
    expect(update).not.toBeNull();
    expect(update!.yield1Day).toBeCloseTo(0.05, 10);
    expect(update!.yield3Day).toBeCloseTo(0.1, 10);
    expect(update!.yield5Day).toBeCloseTo(0.2, 10);
    expect(update!.yield5DayVisibleAt).toBeInstanceOf(Date);
    expect(update!.realizedPrice).toBe(10);
    expect(update!.realizedPriceTarget).toBe(12);
    expect(update!.isReconciled).toBe(true);
  });

  it('只有 1 日可见时回填 1 日收益并收口（基线惩罚读任一可用收益）', () => {
    const future = [candle('2026-09-02', 9.5)];
    const update = updateFor(10, future);
    expect(update).not.toBeNull();
    expect(update!.yield1Day).toBeCloseTo(-0.05, 10);
    expect(update!.yield3Day).toBeNull();
    expect(update!.yield5Day).toBeNull();
    expect(update!.yield5DayVisibleAt).toBeNull();
    expect(update!.realizedPriceTarget).toBe(9.5);
    expect(update!.isReconciled).toBe(true);
  });

  it('退出 K 线都在未来时回填空值且不收口', () => {
    const future = [
      candle('2026-09-12', 10.5),
      candle('2026-09-13', 10.2),
    ];
    const update = updateFor(10, future);
    expect(update).not.toBeNull();
    expect(update!.yield1Day).toBeCloseTo(0.05, 10);
    expect(update!.yield1DayVisibleAt).toBeInstanceOf(Date);
    expect(update!.isReconciled).toBe(false);
  });

  it('无 asOf 后 K 线时返回 null（不写入，待未来数据）', () => {
    expect(updateFor(10, [])).toBeNull();
  });

  it('p0 非法时返回 null', () => {
    const future = [candle('2026-09-02', 10.5)];
    expect(updateFor(0, future)).toBeNull();
    expect(updateFor(NaN, future)).toBeNull();
  });

  it('5 日受限（跌停）pending 也有可见值，收口', () => {
    const future = [
      candle('2026-09-02', 10.5),
      candle('2026-09-03', 10.2),
      candle('2026-09-04', 11),
      candle('2026-09-05', 10.8),
      candle('2026-09-08', 9, 'LIMIT_DOWN'),
    ];
    const update = updateFor(10, future);
    expect(update).not.toBeNull();
    expect(update!.yield5Day).toBeCloseTo(-0.1, 10);
    expect(update!.isReconciled).toBe(true);
  });
});
