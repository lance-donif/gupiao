import { describe, expect, it } from 'vitest';

import { Scheduler } from '../../../../src/index.js';

describe('Scheduler', () => {
  it('returns the same singleton instance across the application', () => {
    Scheduler.resetForTesting();

    const left = Scheduler.getInstance();
    const right = Scheduler.getInstance();

    expect(left).toBe(right);
  });

  it('shares mutable state through the singleton instance', () => {
    Scheduler.resetForTesting();

    const scheduler = Scheduler.getInstance();
    const sameScheduler = Scheduler.getInstance();

    void scheduler.schedule('open-market');
    void sameScheduler.schedule('sync-close');

    expect(scheduler.listTasks()).toMatchObject([
      {
        taskId: 'open-market',
      },
      {
        taskId: 'sync-close',
      },
    ]);
    expect(sameScheduler.listTasks()).toMatchObject([
      {
        taskId: 'open-market',
      },
      {
        taskId: 'sync-close',
      },
    ]);
  });

  it('can reset singleton state for isolated tests', () => {
    Scheduler.resetForTesting();

    const original = Scheduler.getInstance();
    original.schedule('stale-task');

    Scheduler.resetForTesting();
    const fresh = Scheduler.getInstance();

    expect(fresh).not.toBe(original);
    expect(fresh.listTasks()).toEqual([]);
  });
});
