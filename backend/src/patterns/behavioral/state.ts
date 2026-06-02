export type AgentStatus = 'idle' | 'running' | 'completed' | 'error';

export interface IAgentState {
  readonly name: AgentStatus;
  canTransitionTo: (target: AgentStatus) => boolean;
  onEnter: (log: string[]) => void;
  onExit: (log: string[]) => void;
}

abstract class BaseAgentState implements IAgentState {
  public abstract readonly name: AgentStatus;

  public abstract canTransitionTo(target: AgentStatus): boolean;

  public onEnter(log: string[]): void {
    log.push(`enter:${this.name}`);
  }

  public onExit(log: string[]): void {
    log.push(`exit:${this.name}`);
  }
}

export class IdleState extends BaseAgentState {
  public readonly name = 'idle';

  public canTransitionTo(target: AgentStatus): boolean {
    return target === 'running';
  }
}

export class RunningState extends BaseAgentState {
  public readonly name = 'running';

  public canTransitionTo(target: AgentStatus): boolean {
    return target === 'idle' || target === 'completed' || target === 'error';
  }
}

export class CompletedState extends BaseAgentState {
  public readonly name = 'completed';

  public canTransitionTo(target: AgentStatus): boolean {
    return target === 'idle';
  }
}

export class ErrorState extends BaseAgentState {
  public readonly name = 'error';

  public canTransitionTo(target: AgentStatus): boolean {
    return target === 'idle';
  }
}

export class AgentStateContext {
  private readonly transitionLog: string[] = [];

  public constructor(private currentState: IAgentState) {
    this.currentState.onEnter(this.transitionLog);
  }

  public getState(): IAgentState {
    return this.currentState;
  }

  public transitionTo(nextState: IAgentState): void {
    if (!this.currentState.canTransitionTo(nextState.name)) {
      throw new Error(
        `Invalid transition from ${this.currentState.name} to ${nextState.name}.`,
      );
    }

    this.currentState.onExit(this.transitionLog);
    this.currentState = nextState;
    this.currentState.onEnter(this.transitionLog);
  }

  public getTransitionLog(): readonly string[] {
    return [...this.transitionLog];
  }
}
