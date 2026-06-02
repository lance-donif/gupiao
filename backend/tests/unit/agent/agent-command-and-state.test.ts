import { describe, expect, it } from 'vitest';

import {
  AgentExecutionCommand,
  ControlledAgentStateContext,
  CompletedState,
  EventRecorder,
  IdleState,
  RunningState,
  createAgentExecutionCommand,
  createNewsIngestAgentCommand,
  createStockSyncAgentCommand,
  type IAgentCommandContext,
  type IAgentExecutionResult,
  type INewsIngestResult,
  type IStockSyncResult,
  StockSyncFailureCategory,
} from '../../../src/index.js';

const createCommandContext = <TKind extends IAgentCommandContext['taskKind']>(
  taskKind: TKind,
  overrides: Partial<IAgentCommandContext & { readonly taskKind: TKind }> = {},
): IAgentCommandContext & { readonly taskKind: TKind } => {
  return {
    runId: 'run-001',
    taskId: 'task-news-001',
    cluster: 'cluster-a',
    taskKind,
    triggeredAt: new Date('2026-03-17T10:00:00.000Z'),
    asOf: new Date('2026-03-17T10:00:00.000Z'),
    timeWindow: {
      start: new Date('2026-03-17T08:00:00.000Z'),
      end: new Date('2026-03-17T10:00:00.000Z'),
    },
    ...overrides,
  };
};

const createNewsResult = (): INewsIngestResult => {
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
};

const createStockFailure = (): IStockSyncResult => {
  return {
    status: 'failure',
    summary: {
      executionContext: {
        runtime: {
          cluster: 'cluster-b',
          asOf: new Date('2026-03-17T15:01:00.000Z'),
          timeWindow: {
            start: new Date('2026-03-13T09:30:00.000Z'),
            end: new Date('2026-03-17T15:00:00.000Z'),
          },
        },
        idempotency: {
          scopeKey: 'cluster-b::stock-sync::600000.SH',
          replaySafe: true,
          deduplicationKey: 'cluster-b::stock-sync::600000.SH',
        },
      },
      cluster: 'cluster-b',
      requestedSymbol: '600000.SH',
      fetchedCount: 1,
      mappedCount: 1,
      persistedCount: 0,
      persistedStockIds: [],
      decisions: {
        created: [],
        updated: [],
        skipped: [],
      },
      stageReports: [
        {
          stage: 'persist',
          inputCount: 1,
          outputCount: 0,
          detail: 'write failed',
        },
      ],
      failure: {
        category: StockSyncFailureCategory.PersistenceFailed,
        message: 'write failed',
      },
    },
  };
};

class RecordingCommand extends AgentExecutionCommand<
  'news-ingest',
  { readonly query: string; readonly limit?: number },
  INewsIngestResult
> {
  public readonly undos: string[] = [];

  public constructor(result: IAgentExecutionResult<'news-ingest', { readonly query: string; readonly limit?: number }, INewsIngestResult>) {
    super({
      taskKind: result.taskKind,
      context: result.context,
      payload: result.payload,
      execute: async () => result,
      undo: () => result,
    });
  }

  public override undo(): IAgentExecutionResult<'news-ingest', { readonly query: string; readonly limit?: number }, INewsIngestResult> {
    this.undos.push(this.context.runId);
    return this.snapshot();
  }
}

describe('agent command and state contracts', () => {
  it('encapsulates business payload, task kind and runtime context inside explicit commands', async () => {
    const requests: unknown[] = [];
    const command = createNewsIngestAgentCommand(
      createCommandContext('news-ingest'),
      {
        query: '银行',
        limit: 5,
      },
      {
        execute(request) {
          requests.push(request);
          return Promise.resolve(createNewsResult());
        },
      },
    );

    const result = await command.execute();

    expect(command.taskKind).toBe('news-ingest');
    expect(command.context.runId).toBe('run-001');
    expect(command.payload).toEqual({
      query: '银行',
      limit: 5,
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
    expect(result.success).toBe(true);
    expect(result.context.taskKind).toBe('news-ingest');
    expect(result.serviceResult.status).toBe('success');
  });

  it('keeps state transitions inside the controlled context for success paths', () => {
    const events = new EventRecorder<{ readonly eventType: string; readonly to: string; readonly runId: string }>();
    const context = new ControlledAgentStateContext(new IdleState(), {
      runId: 'run-ctx-001',
      taskId: 'task-ctx-001',
      taskKind: 'news-ingest',
      eventSubject: {
        notify: events.update.bind(events),
      },
    });

    context.transitionTo(new RunningState());
    context.transitionTo(new CompletedState());

    expect(context.getState().name).toBe('completed');
    expect(context.getSnapshot()).toMatchObject({
      runId: 'run-ctx-001',
      taskKind: 'news-ingest',
      status: 'completed',
      lastError: undefined,
    });
    expect(events.getEvents()).toMatchObject([
      { eventType: 'agent-state-transitioned', to: 'idle', runId: 'run-ctx-001' },
      { eventType: 'agent-state-transitioned', to: 'running', runId: 'run-ctx-001' },
      { eventType: 'agent-state-transitioned', to: 'completed', runId: 'run-ctx-001' },
    ]);
  });

  it('routes failure paths through the state machine instead of mutating raw strings', async () => {
    const command = createStockSyncAgentCommand(
      createCommandContext('stock-sync', {
        runId: 'run-stock-001',
        taskId: 'task-stock-001',
        cluster: 'cluster-b',
        asOf: new Date('2026-03-17T15:01:00.000Z'),
        timeWindow: {
          start: new Date('2026-03-13T09:30:00.000Z'),
          end: new Date('2026-03-17T15:00:00.000Z'),
        },
      }),
      {
        symbol: '600000.SH',
        stockId: 'stock-600000',
        stockName: '浦发银行',
        industry: '银行',
      },
      {
        execute() {
          return Promise.resolve(createStockFailure());
        },
      },
    );
    const context = new ControlledAgentStateContext(new IdleState(), {
      runId: command.context.runId,
      taskId: command.context.taskId,
      taskKind: command.context.taskKind,
    });

    context.transitionTo(new RunningState());
    const result = await command.execute();

    if (!result.failure) {
      throw new Error('Expected stock-sync command failure detail.');
    }

    context.transitionToError(result.failure);

    expect(result.success).toBe(false);
    expect(result.failure).toEqual({
      category: 'service_failure',
      message: 'write failed',
      sourceCategory: undefined,
    });
    expect(context.getState().name).toBe('error');
    expect(context.getSnapshot()).toMatchObject({
      status: 'error',
      lastError: {
        category: 'service_failure',
        message: 'write failed',
      },
    });
    expect(() => context.transitionTo(new CompletedState())).toThrowError(
      'Invalid transition from error to completed.',
    );
  });

  it('preserves explicit undo semantics when a command declares rollback support', async () => {
    const command = new RecordingCommand({
      taskKind: 'news-ingest',
      context: createCommandContext('news-ingest'),
      payload: {
        query: '银行',
      },
      serviceResult: createNewsResult(),
      success: true,
    });

    await command.execute();
    const rollback = command.undo();

    expect(rollback.success).toBe(true);
    expect(rollback.context.runId).toBe('run-001');
    expect(command.undos).toEqual(['run-001']);
  });

  it('exports the generic command factory for future runner and scheduler consumers', async () => {
    const command = createAgentExecutionCommand({
      taskKind: 'news-ingest',
      context: createCommandContext('news-ingest', { taskId: 'task-factory-001' }),
      payload: {
        query: '证券',
      },
      execute: async ({ context, payload }) => {
        return {
          success: true,
          taskKind: 'news-ingest',
          context,
          payload,
          serviceResult: createNewsResult(),
        };
      },
    });

    const result = await command.execute();

    expect(result.context.taskId).toBe('task-factory-001');
    expect(result.payload).toEqual({ query: '证券' });
    expect(result.serviceResult.status).toBe('success');
    expect(() => command.undo()).toThrowError('Undo is not supported by this agent command.');
  });
});
