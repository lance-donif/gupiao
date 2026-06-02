import type { IAgentState } from '../patterns/behavioral/state.js';

import type {
  IAgentFailureDetail,
  IAgentStateContextOptions,
  IAgentStateSnapshot,
  IAgentStateTransitionEvent,
} from './agent-types.js';
import {
  CompletedState,
  ErrorState,

  IdleState,
  AgentStateContext as PatternAgentStateContext,
  RunningState,
} from '../patterns/behavioral/state.js';

const cloneFailure = (failure?: IAgentFailureDetail): IAgentFailureDetail | undefined => {
  if (!failure) {
    return undefined;
  }

  return {
    category: failure.category,
    message: failure.message,
    sourceCategory: failure.sourceCategory,
  };
};

export class ControlledAgentStateContext {
  private readonly patternContext: PatternAgentStateContext;

  private lastError?: IAgentFailureDetail;

  public constructor(
    initialState: IAgentState = new IdleState(),
    private readonly options: IAgentStateContextOptions,
  ) {
    this.patternContext = new PatternAgentStateContext(initialState);
    this.publishTransition(initialState.name);
  }

  public getState(): IAgentState {
    return this.patternContext.getState();
  }

  public transitionTo(nextState: IAgentState): void {
    this.patternContext.transitionTo(nextState);

    if (nextState.name !== 'error') {
      this.lastError = undefined;
    }

    this.publishTransition(nextState.name);
  }

  public transitionToRunning(): void {
    this.transitionTo(new RunningState());
  }

  public transitionToCompleted(): void {
    this.transitionTo(new CompletedState());
  }

  public transitionToError(failure: IAgentFailureDetail): void {
    this.lastError = cloneFailure(failure);
    this.transitionTo(new ErrorState());
  }

  public reset(): void {
    this.transitionTo(new IdleState());
  }

  public getTransitionLog(): readonly string[] {
    return this.patternContext.getTransitionLog();
  }

  public getSnapshot(): IAgentStateSnapshot {
    return {
      runId: this.options.runId,
      taskId: this.options.taskId,
      taskKind: this.options.taskKind,
      status: this.getState().name,
      transitionLog: this.getTransitionLog(),
      lastError: cloneFailure(this.lastError),
    };
  }

  private publishTransition(status: IAgentStateTransitionEvent['to']): void {
    this.options.eventSubject?.notify({
      eventType: 'agent-state-transitioned',
      runId: this.options.runId,
      taskId: this.options.taskId,
      taskKind: this.options.taskKind,
      to: status,
    });
  }
}

export {
  CompletedState,
  ErrorState,
  IdleState,
  RunningState,
};
