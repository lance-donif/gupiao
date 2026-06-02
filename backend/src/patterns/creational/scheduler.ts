import type { AgentTaskKind, IAgentCommandContext } from '../../agent/agent-types.js';

export interface ISchedulerTaskRequest<TKind extends AgentTaskKind = AgentTaskKind, TPayload = unknown> {
  readonly runId: string;
  readonly taskId: string;
  readonly cluster: string;
  readonly taskKind: TKind;
  readonly triggeredAt: Date;
  readonly asOf?: Date;
  readonly timeWindow?: IAgentCommandContext['timeWindow'];
  readonly payload: Readonly<TPayload>;
}

export interface ISchedulerScheduledTask<TKind extends AgentTaskKind = AgentTaskKind, TPayload = unknown>
  extends ISchedulerTaskRequest<TKind, TPayload> {
  readonly legacyTaskName?: string;
}

export interface ISchedulerDispatchInput<TKind extends AgentTaskKind = AgentTaskKind, TPayload = unknown> {
  readonly task: ISchedulerScheduledTask<TKind, TPayload>;
  readonly context: IAgentCommandContext & { readonly taskKind: TKind };
  readonly isDuplicate: boolean;
}

export interface ISchedulerReplayRecord {
  readonly runId: string;
  readonly taskId: string;
  readonly cluster: string;
  readonly taskKind: AgentTaskKind;
  readonly deduplicationKey: string;
}

export type SchedulerDispatch<TResult, TKind extends AgentTaskKind = AgentTaskKind, TPayload = unknown> = (
  input: ISchedulerDispatchInput<TKind, TPayload>,
) => Promise<TResult>;

export const createSchedulerTaskRequest = <TKind extends AgentTaskKind, TPayload>(
  request: ISchedulerTaskRequest<TKind, TPayload>,
): ISchedulerTaskRequest<TKind, TPayload> => {
  return {
    ...request,
    triggeredAt: new Date(request.triggeredAt),
    asOf: request.asOf ? new Date(request.asOf) : undefined,
    timeWindow: request.timeWindow
      ? {
          start: new Date(request.timeWindow.start),
          end: new Date(request.timeWindow.end),
        }
      : undefined,
  };
};

export class Scheduler {
  private static instance: Scheduler | undefined;

  private readonly tasks: ISchedulerScheduledTask[] = [];

  private readonly replayIndex = new Map<string, ISchedulerReplayRecord>();

  private constructor() {}

  public static getInstance(): Scheduler {
    if (!Scheduler.instance) {
      Scheduler.instance = new Scheduler();
    }

    return Scheduler.instance;
  }

  public static resetForTesting(): void {
    Scheduler.instance = undefined;
  }

  public schedule(taskRequest: string): Promise<void>;

  public schedule<TKind extends AgentTaskKind, TPayload>(
    taskRequest: ISchedulerTaskRequest<TKind, TPayload>,
  ): Promise<void>;

  public schedule<TResult, TKind extends AgentTaskKind, TPayload>(
    taskRequest: ISchedulerTaskRequest<TKind, TPayload>,
    dispatch: SchedulerDispatch<TResult, TKind, TPayload>,
  ): Promise<TResult>;

  public async schedule<TResult, TKind extends AgentTaskKind, TPayload>(
    taskRequest: string | ISchedulerTaskRequest<TKind, TPayload>,
    dispatch?: SchedulerDispatch<TResult, TKind, TPayload>,
  ): Promise<TResult | void> {
    if (typeof taskRequest === 'string') {
      this.tasks.push({
        runId: `legacy-${this.tasks.length + 1}`,
        taskId: taskRequest,
        legacyTaskName: taskRequest,
        cluster: 'legacy-cluster',
        taskKind: 'news-ingest',
        triggeredAt: new Date(0),
        payload: Object.freeze({ taskName: taskRequest }),
      });
      return undefined;
    }

    const task = createSchedulerTaskRequest(taskRequest);
    this.tasks.push(task);

    if (!dispatch) {
      return undefined;
    }

    const context = {
      runId: task.runId,
      taskId: task.taskId,
      cluster: task.cluster,
      taskKind: task.taskKind,
      triggeredAt: task.triggeredAt,
      asOf: task.asOf,
      timeWindow: task.timeWindow,
    } satisfies IAgentCommandContext & { readonly taskKind: TKind };

    const deduplicationKey = [
      task.cluster,
      task.taskKind,
      task.asOf?.toISOString() ?? 'latest',
      task.timeWindow
        ? `${task.timeWindow.start.toISOString()}..${task.timeWindow.end.toISOString()}`
        : 'open-window',
      JSON.stringify(task.payload),
    ].join('::');
    const isDuplicate = this.replayIndex.has(deduplicationKey);
    this.replayIndex.set(deduplicationKey, {
      runId: task.runId,
      taskId: task.taskId,
      cluster: task.cluster,
      taskKind: task.taskKind,
      deduplicationKey,
    });

    return dispatch({
      task,
      context,
      isDuplicate,
    });
  }

  public listTasks(): readonly ISchedulerScheduledTask[] {
    return [...this.tasks];
  }

  public listReplayRecords(): readonly ISchedulerReplayRecord[] {
    return [...this.replayIndex.values()];
  }
}
