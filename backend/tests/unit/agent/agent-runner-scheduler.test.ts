import { describe, expect, it } from 'vitest';

import {
  ControlledAgentStateContext,
  EventRecorder,
  InMemoryAgentExecutionStore,
  IdleState,
  NewsIngestFailureCategory,
  Scheduler,
  createAgentExecutionContext,
  createAgentRunner,
  createNewsIngestAgentCommand,
  createSchedulerTaskRequest,
  type IAgentRuntimeEvent,
  type INewsIngestResult,
} from '../../../src/index.js';

const createNewsResult = (status: 'success' | 'failure'): INewsIngestResult => {
  if (status === 'success') {
    return {
      status: 'success',
      summary: {
        executionContext: {
          runtime: {
            cluster: 'cluster-a',
            asOf: new Date('2026-03-17T10:00:00.000Z'),
            timeWindow: {
              start: new Date('2026-03-17T08:00:00.000Z'),
              end: new Date('2026-03-17T10:00:00.000Z'),
            },
          },
          idempotency: {
            scopeKey: 'cluster-a::news-ingest::银行',
            replaySafe: true,
            deduplicationKey: 'cluster-a::news-ingest::银行',
          },
        },
        cluster: 'cluster-a',
        query: '银行',
        fetchedCount: 2,
        normalizedCount: 2,
        deduplicatedCount: 1,
        persistedCount: 1,
        persistedIds: ['news-1'],
        stageReports: [
          {
            stage: 'fetch',
            inputCount: 0,
            outputCount: 2,
            detail: 'fetched from stub',
          },
        ],
      },
    };
  }

  return {
    status: 'failure',
    summary: {
      executionContext: {
        runtime: {
          cluster: 'cluster-a',
          asOf: new Date('2026-03-17T10:00:00.000Z'),
          timeWindow: {
            start: new Date('2026-03-17T08:00:00.000Z'),
            end: new Date('2026-03-17T10:00:00.000Z'),
          },
        },
        idempotency: {
          scopeKey: 'cluster-a::news-ingest::银行',
          replaySafe: true,
          deduplicationKey: 'cluster-a::news-ingest::银行',
        },
      },
      cluster: 'cluster-a',
      query: '银行',
      fetchedCount: 2,
      normalizedCount: 2,
      deduplicatedCount: 1,
      persistedCount: 0,
      persistedIds: [],
      stageReports: [
        {
          stage: 'persist',
          inputCount: 1,
          outputCount: 0,
          detail: 'write failed',
        },
      ],
      failure: {
        category: NewsIngestFailureCategory.PersistenceFailed,
        message: 'write failed',
      },
    },
  };
};

describe('agent runner and scheduler integration', () => {
  it('runs real service contracts through the runner and emits structured lifecycle events', async () => {
    const events = new EventRecorder<IAgentRuntimeEvent>();
    const executionStore = new InMemoryAgentExecutionStore();
    const requests: unknown[] = [];
    const context = createAgentExecutionContext({
      runId: 'run-001',
      taskId: 'task-news-001',
      cluster: 'cluster-a',
      taskKind: 'news-ingest',
      triggeredAt: new Date('2026-03-17T10:00:00.000Z'),
      asOf: new Date('2026-03-17T10:00:00.000Z'),
      timeWindow: {
        start: new Date('2026-03-17T08:00:00.000Z'),
        end: new Date('2026-03-17T10:00:00.000Z'),
      },
    });
    const command = createNewsIngestAgentCommand(
      context,
      {
        query: '银行',
        limit: 5,
      },
      {
        execute(request) {
          requests.push(request);
          return Promise.resolve(createNewsResult('success'));
        },
      },
    );
    const state = new ControlledAgentStateContext(new IdleState(), {
      runId: context.runId,
      taskId: context.taskId,
      taskKind: context.taskKind,
      eventSubject: {
        notify(event) {
          events.update(event as IAgentRuntimeEvent);
        },
      },
    });
    const runner = createAgentRunner({
      eventRecorder: events,
      executionObserver: executionStore,
    });

    const result = await runner.run({
      command,
      state,
    });

    expect(requests).toEqual([
      {
        cluster: 'cluster-a',
        query: '银行',
        limit: 5,
        asOf: new Date('2026-03-17T10:00:00.000Z'),
        timeWindow: {
          start: new Date('2026-03-17T08:00:00.000Z'),
          end: new Date('2026-03-17T10:00:00.000Z'),
        },
      },
    ]);
    expect(result.status).toBe('completed');
    expect(result.summary.success).toBe(true);
    expect(result.summary.runId).toBe('run-001');
    expect(result.summary.cluster).toBe('cluster-a');
    expect(result.summary.serviceStatus).toBe('success');
    expect(result.summary.stageDetails).toEqual([
      {
        stage: 'fetch',
        detail: 'fetched from stub',
      },
    ]);
    expect(result.events.map((event) => event.eventType)).toEqual([
      'agent-state-transitioned',
      'agent-run-started',
      'agent-state-transitioned',
      'agent-run-completed',
      'agent-state-transitioned',
    ]);
    expect(result.events[1]).toMatchObject({
      eventType: 'agent-run-started',
      runId: 'run-001',
      taskId: 'task-news-001',
      taskKind: 'news-ingest',
      cluster: 'cluster-a',
    });
    expect(result.events[3]).toMatchObject({
      eventType: 'agent-run-completed',
      runId: 'run-001',
      taskId: 'task-news-001',
      taskKind: 'news-ingest',
      cluster: 'cluster-a',
      serviceStatus: 'success',
    });

    const executionRecord = await executionStore.findByRunId('run-001');
    expect(executionRecord).toMatchObject({
      runId: 'run-001',
      taskId: 'task-news-001',
      cluster: 'cluster-a',
      serviceStatus: 'success',
      deduplicationKey: 'cluster-a::news-ingest::银行',
      replaySafe: true,
    });
  });

  it('lets scheduler pass traceable context into the runner and surfaces failures as structured events', async () => {
    Scheduler.resetForTesting();

    const scheduler = Scheduler.getInstance();
    const taskRequest = createSchedulerTaskRequest({
      runId: 'run-002',
      taskId: 'task-news-002',
      cluster: 'cluster-b',
      taskKind: 'news-ingest',
      triggeredAt: new Date('2026-03-17T11:00:00.000Z'),
      asOf: new Date('2026-03-17T11:00:00.000Z'),
      timeWindow: {
        start: new Date('2026-03-17T09:00:00.000Z'),
        end: new Date('2026-03-17T11:00:00.000Z'),
      },
      payload: {
        query: '科技',
      },
    });

    const outcome = await scheduler.schedule(taskRequest, ({ context }) => {
      const events = new EventRecorder<IAgentRuntimeEvent>();
      const runner = createAgentRunner({ eventRecorder: events });
      const command = createNewsIngestAgentCommand(
        context,
        taskRequest.payload,
        {
          execute() {
            return Promise.resolve(createNewsResult('failure'));
          },
        },
      );
      const state = new ControlledAgentStateContext(new IdleState(), {
        runId: context.runId,
        taskId: context.taskId,
        taskKind: context.taskKind,
        eventSubject: {
          notify(event) {
            events.update(event as IAgentRuntimeEvent);
          },
        },
      });

      return runner.run({ command, state });
    });

    expect(scheduler.listTasks()).toHaveLength(1);
    expect(scheduler.listTasks()[0]).toMatchObject({
      runId: 'run-002',
      taskId: 'task-news-002',
      cluster: 'cluster-b',
      taskKind: 'news-ingest',
      payload: {
        query: '科技',
      },
    });
    expect(outcome.summary.success).toBe(false);
    expect(outcome.summary.status).toBe('error');
    expect(outcome.summary.failure).toEqual({
      category: 'service_failure',
      message: 'write failed',
      sourceCategory: undefined,
    });
    expect(outcome.events.some((event) => event.eventType === 'agent-run-failed')).toBe(true);
    expect(outcome.events.find((event) => event.eventType === 'agent-run-failed')).toMatchObject({
      eventType: 'agent-run-failed',
      runId: 'run-002',
      taskId: 'task-news-002',
      taskKind: 'news-ingest',
      cluster: 'cluster-b',
      failureCategory: 'service_failure',
    });
  });

  it('marks duplicate schedules inside the same cluster boundary while keeping other clusters isolated', async () => {
    Scheduler.resetForTesting();

    const scheduler = Scheduler.getInstance();
    const firstTask = createSchedulerTaskRequest({
      runId: 'run-dup-001',
      taskId: 'task-dup-001',
      cluster: 'cluster-a',
      taskKind: 'news-ingest',
      triggeredAt: new Date('2026-03-17T12:00:00.000Z'),
      asOf: new Date('2026-03-17T12:00:00.000Z'),
      timeWindow: {
        start: new Date('2026-03-17T10:00:00.000Z'),
        end: new Date('2026-03-17T12:00:00.000Z'),
      },
      payload: {
        query: '银行',
      },
    });

    const secondTask = createSchedulerTaskRequest({
      ...firstTask,
      runId: 'run-dup-002',
      taskId: 'task-dup-002',
      triggeredAt: new Date('2026-03-17T12:01:00.000Z'),
    });

    const crossClusterTask = createSchedulerTaskRequest({
      ...firstTask,
      runId: 'run-dup-003',
      taskId: 'task-dup-003',
      cluster: 'cluster-b',
      triggeredAt: new Date('2026-03-17T12:02:00.000Z'),
    });

    const duplicateFlags: boolean[] = [];

    await scheduler.schedule(firstTask, async ({ isDuplicate }) => {
      duplicateFlags.push(isDuplicate);
      return undefined;
    });
    await scheduler.schedule(secondTask, async ({ isDuplicate }) => {
      duplicateFlags.push(isDuplicate);
      return undefined;
    });
    await scheduler.schedule(crossClusterTask, async ({ isDuplicate }) => {
      duplicateFlags.push(isDuplicate);
      return undefined;
    });

    expect(duplicateFlags).toEqual([false, true, false]);
    expect(scheduler.listReplayRecords()).toEqual([
      expect.objectContaining({
        runId: 'run-dup-002',
        cluster: 'cluster-a',
        deduplicationKey: expect.stringContaining('cluster-a::news-ingest'),
      }),
      expect.objectContaining({
        runId: 'run-dup-003',
        cluster: 'cluster-b',
        deduplicationKey: expect.stringContaining('cluster-b::news-ingest'),
      }),
    ]);
  });
});
