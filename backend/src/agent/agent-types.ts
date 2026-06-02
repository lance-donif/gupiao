import type { AgentStatus } from '../patterns/behavioral/index.js';
import type { EventSubject } from '../patterns/behavioral/observer.js';
import type { INewsIngestResult } from '../services/news-ingest-types.js';
import type { IServiceTimeWindow } from '../services/service-types.js';
import type { IStockSyncResult } from '../services/stock-sync-types.js';

export type AgentTaskKind = 'news-ingest' | 'stock-sync';

export interface IAgentCommandContext {
  readonly runId: string;
  readonly taskId: string;
  readonly cluster: string;
  readonly taskKind: AgentTaskKind;
  readonly triggeredAt: Date;
  readonly asOf?: Date;
  readonly timeWindow?: IServiceTimeWindow;
}

export interface IAgentFailureDetail {
  readonly category: 'service_failure';
  readonly message: string;
  readonly sourceCategory?: string;
}

export interface IAgentStateSnapshot {
  readonly runId: string;
  readonly taskId: string;
  readonly taskKind: AgentTaskKind;
  readonly status: AgentStatus;
  readonly transitionLog: readonly string[];
  readonly lastError?: IAgentFailureDetail;
}

export interface IAgentStateTransitionEvent {
  readonly eventType: 'agent-state-transitioned';
  readonly runId: string;
  readonly taskId: string;
  readonly taskKind: AgentTaskKind;
  readonly to: AgentStatus;
}

export interface IAgentStateContextOptions {
  readonly runId: string;
  readonly taskId: string;
  readonly taskKind: AgentTaskKind;
  readonly eventSubject?: Pick<EventSubject<IAgentStateTransitionEvent>, 'notify'>;
}

export interface IAgentExecutionResult<TKind extends AgentTaskKind, TPayload, TResult> {
  readonly success: boolean;
  readonly taskKind: TKind;
  readonly context: IAgentCommandContext & { readonly taskKind: TKind };
  readonly payload: Readonly<TPayload>;
  readonly serviceResult: TResult;
  readonly failure?: IAgentFailureDetail;
}

export interface IAgentExecutionCommand<TKind extends AgentTaskKind, TPayload, TResult>
{
  readonly taskKind: TKind;
  readonly context: IAgentCommandContext & { readonly taskKind: TKind };
  readonly payload: Readonly<TPayload>;
  execute: () => Promise<IAgentExecutionResult<TKind, TPayload, TResult>>;
  undo: () => IAgentExecutionResult<TKind, TPayload, TResult>;
}

export type AgentServiceResult = INewsIngestResult | IStockSyncResult;
