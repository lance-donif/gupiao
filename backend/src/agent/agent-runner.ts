import type { IAgentExecutionObserver } from './agent-observability.js';

import type { ControlledAgentStateContext } from './agent-state.js';
import type {
  AgentServiceResult,
  AgentTaskKind,
  IAgentCommandContext,
  IAgentExecutionCommand,
  IAgentFailureDetail,
  IAgentStateSnapshot,
  IAgentStateTransitionEvent,
} from './agent-types.js';
import { EventRecorder } from '../patterns/behavioral/observer.js';

export interface IAgentExecutionStageDetail {
  readonly stage: string;
  readonly detail: string;
}

export interface IAgentRunStartedEvent {
  readonly eventType: 'agent-run-started';
  readonly runId: string;
  readonly taskId: string;
  readonly taskKind: AgentTaskKind;
  readonly cluster: string;
}

export interface IAgentRunCompletedEvent {
  readonly eventType: 'agent-run-completed';
  readonly runId: string;
  readonly taskId: string;
  readonly taskKind: AgentTaskKind;
  readonly cluster: string;
  readonly serviceStatus: 'success';
}

export interface IAgentRunFailedEvent {
  readonly eventType: 'agent-run-failed';
  readonly runId: string;
  readonly taskId: string;
  readonly taskKind: AgentTaskKind;
  readonly cluster: string;
  readonly failureCategory: IAgentFailureDetail['category'];
}

export type IAgentRuntimeEvent
  = | IAgentStateTransitionEvent
    | IAgentRunStartedEvent
    | IAgentRunCompletedEvent
    | IAgentRunFailedEvent;

export interface IAgentRunSummary {
  readonly runId: string;
  readonly taskId: string;
  readonly taskKind: AgentTaskKind;
  readonly cluster: string;
  readonly status: IAgentStateSnapshot['status'];
  readonly success: boolean;
  readonly serviceStatus: AgentServiceResult['status'];
  readonly stageDetails: readonly IAgentExecutionStageDetail[];
  readonly failure?: IAgentFailureDetail;
}

export interface IAgentRunResult {
  readonly status: IAgentStateSnapshot['status'];
  readonly summary: IAgentRunSummary;
  readonly state: IAgentStateSnapshot;
  readonly events: readonly IAgentRuntimeEvent[];
  readonly serviceResult: AgentServiceResult;
}

export interface IAgentRunnerDependencies {
  readonly eventRecorder?: EventRecorder<IAgentRuntimeEvent>;
  readonly executionObserver?: IAgentExecutionObserver;
}

export interface IAgentRunRequest<
  TKind extends AgentTaskKind = AgentTaskKind,
  TPayload = unknown,
  TResult extends AgentServiceResult = AgentServiceResult,
> {
  readonly command: IAgentExecutionCommand<TKind, TPayload, TResult>;
  readonly state: ControlledAgentStateContext;
}

const toStageDetails = (serviceResult: AgentServiceResult): readonly IAgentExecutionStageDetail[] => {
  return serviceResult.summary.stageReports.map(report => ({
    stage: report.stage,
    detail: report.detail,
  }));
};

const publishEvent = (
  recorder: EventRecorder<IAgentRuntimeEvent>,
  event: IAgentRuntimeEvent,
): void => {
  recorder.update(event);
};

export class AgentRunner {
  private readonly eventRecorder: EventRecorder<IAgentRuntimeEvent>;

  private readonly executionObserver?: IAgentExecutionObserver;

  public constructor(dependencies: IAgentRunnerDependencies = {}) {
    this.eventRecorder = dependencies.eventRecorder ?? new EventRecorder<IAgentRuntimeEvent>();
    this.executionObserver = dependencies.executionObserver;
  }

  public async run<
    TKind extends AgentTaskKind,
    TPayload,
    TResult extends AgentServiceResult,
  >(request: IAgentRunRequest<TKind, TPayload, TResult>,
  ): Promise<IAgentRunResult> {
    const { command, state } = request;
    const context = command.context;

    publishEvent(this.eventRecorder, {
      eventType: 'agent-run-started',
      runId: context.runId,
      taskId: context.taskId,
      taskKind: context.taskKind,
      cluster: context.cluster,
    });
    state.transitionToRunning();

    const execution = await command.execute();

    if (execution.success) {
      publishEvent(this.eventRecorder, {
        eventType: 'agent-run-completed',
        runId: context.runId,
        taskId: context.taskId,
        taskKind: context.taskKind,
        cluster: context.cluster,
        serviceStatus: 'success',
      });
      state.transitionToCompleted();
    }
    else {
      const failure = execution.failure ?? {
        category: 'service_failure' as const,
        message: 'unknown agent execution failure',
        sourceCategory: undefined,
      };
      publishEvent(this.eventRecorder, {
        eventType: 'agent-run-failed',
        runId: context.runId,
        taskId: context.taskId,
        taskKind: context.taskKind,
        cluster: context.cluster,
        failureCategory: failure.category,
      });
      state.transitionToError(failure);
    }

    const snapshot = state.getSnapshot();

    const result = {
      status: snapshot.status,
      summary: {
        runId: context.runId,
        taskId: context.taskId,
        taskKind: context.taskKind,
        cluster: context.cluster,
        status: snapshot.status,
        success: execution.success,
        serviceStatus: execution.serviceResult.status,
        stageDetails: toStageDetails(execution.serviceResult),
        failure: execution.failure,
      },
      state: snapshot,
      events: this.eventRecorder.getEvents(),
      serviceResult: execution.serviceResult,
    };

    await this.executionObserver?.record({
      runId: result.summary.runId,
      taskId: result.summary.taskId,
      taskKind: result.summary.taskKind,
      cluster: result.summary.cluster,
      status: result.summary.status,
      success: result.summary.success,
      serviceStatus: result.summary.serviceStatus,
      deduplicationKey: execution.serviceResult.summary.executionContext.idempotency.deduplicationKey,
      replaySafe: execution.serviceResult.summary.executionContext.idempotency.replaySafe,
      stageDetails: result.summary.stageDetails,
      failure: result.summary.failure,
      events: result.events,
    });

    return result;
  }
}

export const createAgentRunner = (dependencies: IAgentRunnerDependencies = {}): AgentRunner => {
  return new AgentRunner(dependencies);
};

export const createAgentExecutionContext = <TKind extends AgentTaskKind>(
  context: IAgentCommandContext & { readonly taskKind: TKind },
): IAgentCommandContext & { readonly taskKind: TKind } => {
  return {
    ...context,
    triggeredAt: new Date(context.triggeredAt),
    asOf: context.asOf ? new Date(context.asOf) : undefined,
    timeWindow: context.timeWindow
      ? {
          start: new Date(context.timeWindow.start),
          end: new Date(context.timeWindow.end),
        }
      : undefined,
  };
};
