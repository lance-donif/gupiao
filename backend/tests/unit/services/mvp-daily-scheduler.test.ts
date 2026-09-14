import { describe, expect, it } from 'vitest';

import {
  getMvpScheduleTable,
  getNextScheduledRunBeijing,
} from '../../../src/services/mvp-daily-scheduler.js';

describe('mvp daily scheduler', () => {
  it('工作日晚上 20:00 调度，周末不跑（A股休市），串联行情→对账→推荐', () => {
    const schedule = getMvpScheduleTable();

    expect(schedule).toHaveLength(1);
    expect(schedule[0]).toMatchObject({
      id: 'daily_recommendation',
      cadence: 'weekly',
      beijingTime: { hour: 20, minute: 0 },
      dataFrequency: expect.any(String),
      failureStrategy: expect.any(String),
    });
    expect(schedule[0]!.weekdays).toEqual([1, 2, 3, 4, 5]);
    // 三步必须按顺序串联，缺一不可：行情增量 → 收益对账 → 推荐主链路。
    expect(schedule[0]!.commandHint).toBe(
      'bun dist/scripts/sync-stock-history.js --mode incremental && bun dist/scripts/backfill-yield-records.js && bun dist/scripts/run-daily-recommendation.js',
    );
  });

  it('工作日同一天 20:00 之前调度到当天', () => {
    const next = getNextScheduledRunBeijing(
      new Date('2026-05-25T07:00:00.000Z'), // 2026-05-25 15:00 Beijing，周一
    );

    expect(next.task.id).toBe('daily_recommendation');
    expect(next.beijingDateTime).toBe('2026-05-25 20:00');
    expect(next.scheduledAt.toISOString()).toBe('2026-05-25T12:00:00.000Z');
  });

  it('过了 20:00 之后顺延到次日 Beijing 20:00', () => {
    const next = getNextScheduledRunBeijing(
      new Date('2026-05-24T13:00:00.000Z'), // 2026-05-24 21:00 Beijing
    );

    expect(next.task.id).toBe('daily_recommendation');
    expect(next.beijingDateTime).toBe('2026-05-25 20:00');
    expect(next.scheduledAt.toISOString()).toBe('2026-05-25T12:00:00.000Z');
  });

  it('周六晚上顺延到周一 Beijing 20:00，不在周末空跑', () => {
    const next = getNextScheduledRunBeijing(
      new Date('2026-09-12T13:00:00.000Z'), // 2026-09-12 21:00 Beijing，周六
    );

    expect(next.task.id).toBe('daily_recommendation');
    expect(next.beijingDateTime).toBe('2026-09-14 20:00');
    expect(next.scheduledAt.toISOString()).toBe('2026-09-14T12:00:00.000Z');
  });

  it('未知任务 ID 直接抛错，不静默忽略', () => {
    expect(() => getNextScheduledRunBeijing(new Date(), ['not_a_task'])).toThrow(/Unknown MVP scheduler task id/);
  });
});
