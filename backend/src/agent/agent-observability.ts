import type { IAgentExecutionStageDetail, IAgentRuntimeEvent } from './agent-runner.js';
import type { AgentServiceResult, AgentTaskKind, IAgentFailureDetail, IAgentStateSnapshot } from './agent-types.js';

export interface IAgentExecutionRecord {
  readonly runId: string;
  readonly taskId: string;
  readonly taskKind: AgentTaskKind;
  readonly cluster: string;
  readonly status: IAgentStateSnapshot['status'];
  readonly success: boolean;
  readonly serviceStatus: AgentServiceResult['status'];
  readonly deduplicationKey: string;
  readonly replaySafe: boolean;
  readonly stageDetails: readonly IAgentExecutionStageDetail[];
  readonly failure?: IAgentFailureDetail;
  readonly events: readonly IAgentRuntimeEvent[];
}

export interface IAgentExecutionObserver {
  record: (record: IAgentExecutionRecord) => Promise<void>;
}

export interface IAgentExecutionQuery {
  list: () => Promise<readonly IAgentExecutionRecord[]>;
  findByRunId: (runId: string) => Promise<IAgentExecutionRecord | null>;
  findByCluster: (cluster: string) => Promise<readonly IAgentExecutionRecord[]>;
  findByDeduplicationKey: (deduplicationKey: string) => Promise<readonly IAgentExecutionRecord[]>;
}

export interface IAgentExecutionStore extends IAgentExecutionObserver, IAgentExecutionQuery {}

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

const cloneStageDetails = (
  details: readonly IAgentExecutionStageDetail[],
): readonly IAgentExecutionStageDetail[] => {
  return details.map(detail => ({
    stage: detail.stage,
    detail: detail.detail,
  }));
};

const cloneEvents = (events: readonly IAgentRuntimeEvent[]): readonly IAgentRuntimeEvent[] => {
  return events.map(event => ({
    ...event,
  }));
};

const cloneRecord = (record: IAgentExecutionRecord): IAgentExecutionRecord => {
  return {
    runId: record.runId,
    taskId: record.taskId,
    taskKind: record.taskKind,
    cluster: record.cluster,
    status: record.status,
    success: record.success,
    serviceStatus: record.serviceStatus,
    deduplicationKey: record.deduplicationKey,
    replaySafe: record.replaySafe,
    stageDetails: cloneStageDetails(record.stageDetails),
    failure: cloneFailure(record.failure),
    events: cloneEvents(record.events),
  };
};

export class InMemoryAgentExecutionStore implements IAgentExecutionStore {
  private readonly recordsByRunId = new Map<string, IAgentExecutionRecord>();

  public record(record: IAgentExecutionRecord): Promise<void> {
    this.recordsByRunId.set(record.runId, cloneRecord(record));
    return Promise.resolve();
  }

  public list(): Promise<readonly IAgentExecutionRecord[]> {
    return Promise.resolve([...this.recordsByRunId.values()].map(cloneRecord));
  }

  public findByRunId(runId: string): Promise<IAgentExecutionRecord | null> {
    const record = this.recordsByRunId.get(runId);
    return Promise.resolve(record ? cloneRecord(record) : null);
  }

  public findByCluster(cluster: string): Promise<readonly IAgentExecutionRecord[]> {
    return Promise.resolve(
      [...this.recordsByRunId.values()]
        .filter(record => record.cluster === cluster)
        .map(cloneRecord),
    );
  }

  public findByDeduplicationKey(deduplicationKey: string): Promise<readonly IAgentExecutionRecord[]> {
    return Promise.resolve(
      [...this.recordsByRunId.values()]
        .filter(record => record.deduplicationKey === deduplicationKey)
        .map(cloneRecord),
    );
  }
}

export const createInMemoryAgentExecutionStore = (): IAgentExecutionStore => {
  return new InMemoryAgentExecutionStore();
};
