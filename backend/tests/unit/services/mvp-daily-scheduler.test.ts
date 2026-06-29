import { describe, expect, it } from 'vitest';

import {
  getMvpScheduleTable,
  getNextScheduledRunBeijing,
} from '../../../src/services/mvp-daily-scheduler.js';

describe('mvp daily scheduler', () => {
  it('returns the fixed MVP schedule table with execution metadata', () => {
    const schedule = getMvpScheduleTable();

    expect(schedule).toHaveLength(10);
    expect(schedule.map(task => task.id)).toEqual([
      'stock_list_check',
      'daily_candle_incremental',
      'news_fetch',
      'normalize_dedupe_llm',
      'graph_score_recommend',
      'publish_snapshot',
      'forecast_replay',
      'tickflow_industry_exposure_refresh',
      'history_gap_repair',
      'reconcile_recommendations',
    ]);
    expect(schedule[0]).toMatchObject({
      id: 'stock_list_check',
      cadence: 'daily',
      beijingTime: { hour: 7, minute: 30 },
      dataFrequency: expect.any(String),
      failureStrategy: expect.any(String),
      commandHint: 'bun dist/scripts/sync-stocks.js --mode check',
    });
    expect(schedule[8]).toMatchObject({
      id: 'history_gap_repair',
      cadence: 'daily',
      beijingTime: { hour: 8, minute: 30 },
      commandHint: 'bun dist/scripts/sync-stock-history.js --mode repair-gaps',
    });
    expect(schedule[7]).toMatchObject({
      id: 'tickflow_industry_exposure_refresh',
      cadence: 'monthly',
      monthDays: [1],
      beijingTime: { hour: 3, minute: 30 },
    });
    expect(schedule[6]).toMatchObject({
      id: 'forecast_replay',
      cadence: 'daily',
      beijingTime: { hour: 14, minute: 30 },
      commandHint: 'bun dist/scripts/run-daily-recommendation.js --from-forecast true',
    });
    expect(schedule.map(task => task.commandHint)).toEqual([
      'bun dist/scripts/sync-stocks.js --mode check',
      'bun dist/scripts/sync-stock-history.js --mode incremental',
      'bun dist/scripts/fetch-newsnow.js --date today',
      'bun dist/scripts/run-daily-recommendation.js --stop-after dedup',
      'bun dist/scripts/run-daily-recommendation.js',
      'bun dist/scripts/run-daily-recommendation.js --publish-only',
      'bun dist/scripts/run-daily-recommendation.js --from-forecast true',
      'bun dist/scripts/sync-tickflow-stock-exposure.js',
      'bun dist/scripts/sync-stock-history.js --mode repair-gaps',
      'bun dist/scripts/reconcile-historical-recommendations.js',
    ]);
  });

  it('calculates the next Beijing run for a daily task on the same day', () => {
    const next = getNextScheduledRunBeijing(
      new Date('2026-05-24T07:00:00.000Z'), // 2026-05-24 15:00 Beijing
      ['daily_candle_incremental'],
    );

    expect(next.task.id).toBe('daily_candle_incremental');
    expect(next.beijingDateTime).toBe('2026-05-24 16:10');
    expect(next.scheduledAt.toISOString()).toBe('2026-05-24T08:10:00.000Z');
  });

  it('rolls a daily task to the next Beijing day after its scheduled time', () => {
    const next = getNextScheduledRunBeijing(
      new Date('2026-05-24T09:00:00.000Z'), // 2026-05-24 17:00 Beijing
      ['daily_candle_incremental'],
    );

    expect(next.task.id).toBe('daily_candle_incremental');
    expect(next.beijingDateTime).toBe('2026-05-25 16:10');
    expect(next.scheduledAt.toISOString()).toBe('2026-05-25T08:10:00.000Z');
  });

  it('finds the monthly first-day Beijing task', () => {
    const next = getNextScheduledRunBeijing(
      new Date('2026-05-31T16:00:00.000Z'), // 2026-06-01 00:00 Beijing
      ['tickflow_industry_exposure_refresh'],
    );

    expect(next.task.id).toBe('tickflow_industry_exposure_refresh');
    expect(next.beijingDateTime).toBe('2026-06-01 03:30');
    expect(next.scheduledAt.toISOString()).toBe('2026-05-31T19:30:00.000Z');
  });

  it('rolls the monthly task to the next Beijing month after it has passed', () => {
    const next = getNextScheduledRunBeijing(
      new Date('2026-06-01T20:00:00.000Z'), // 2026-06-02 04:00 Beijing
      ['tickflow_industry_exposure_refresh'],
    );

    expect(next.task.id).toBe('tickflow_industry_exposure_refresh');
    expect(next.beijingDateTime).toBe('2026-07-01 03:30');
    expect(next.scheduledAt.toISOString()).toBe('2026-06-30T19:30:00.000Z');
  });
});
