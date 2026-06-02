import type { ICommandResult } from '../patterns/behavioral/command.js';
import type { INewsIngestExecutionRequest, INewsIngestResult } from '../services/news-ingest-types.js';
import type { INewsIngestServiceLike, IStockSyncServiceLike } from '../services/service-di.js';
import type { IStockSyncExecutionRequest, IStockSyncResult } from '../services/stock-sync-types.js';
import type {
  AgentTaskKind,
  IAgentCommandContext,
  IAgentExecutionCommand,
  IAgentExecutionResult,
  IAgentFailureDetail,
} from './agent-types.js';

interface IAgentExecutionCommandOptions<TKind extends AgentTaskKind, TPayload, TResult> {
  readonly taskKind: TKind;
  readonly context: IAgentCommandContext & { readonly taskKind: TKind };
  readonly payload: Readonly<TPayload>;
  readonly execute: (input: {
    readonly context: IAgentCommandContext & { readonly taskKind: TKind };
    readonly payload: Readonly<TPayload>;
  }) => Promise<IAgentExecutionResult<TKind, TPayload, TResult>>;
  readonly undo?: () => IAgentExecutionResult<TKind, TPayload, TResult>;
}

const createFailureDetail = (result: {
  readonly summary: {
    readonly failure: {
      readonly message: string;
      readonly sourceCategory?: string;
    };
  };
}): IAgentFailureDetail => {
  return {
    category: 'service_failure',
    message: result.summary.failure.message,
    sourceCategory: result.summary.failure.sourceCategory,
  };
};

export class AgentExecutionCommand<TKind extends AgentTaskKind, TPayload, TResult>
implements IAgentExecutionCommand<TKind, TPayload, TResult> {
  private lastResult: IAgentExecutionResult<TKind, TPayload, TResult> | null = null;

  public readonly taskKind: TKind;

  public readonly context: IAgentCommandContext & { readonly taskKind: TKind };

  public readonly payload: Readonly<TPayload>;

  public constructor(private readonly options: IAgentExecutionCommandOptions<TKind, TPayload, TResult>) {
    this.taskKind = options.taskKind;
    this.context = options.context;
    this.payload = options.payload;
  }

  public async execute(): Promise<IAgentExecutionResult<TKind, TPayload, TResult>> {
    const result = await this.options.execute({
      context: this.context,
      payload: this.payload,
    });
    this.lastResult = result;
    return result;
  }

  public undo(): IAgentExecutionResult<TKind, TPayload, TResult> {
    if (this.options.undo) {
      return this.options.undo();
    }

    throw new Error('Undo is not supported by this agent command.');
  }

  protected snapshot(): IAgentExecutionResult<TKind, TPayload, TResult> {
    if (!this.lastResult) {
      throw new Error('Cannot capture command snapshot before execute.');
    }

    return this.lastResult;
  }
}

export const createAgentExecutionCommand = <TKind extends AgentTaskKind, TPayload, TResult>(
  options: IAgentExecutionCommandOptions<TKind, TPayload, TResult>,
): IAgentExecutionCommand<TKind, TPayload, TResult> => {
  return new AgentExecutionCommand(options);
};

const toNewsIngestRequest = (
  context: IAgentCommandContext & { readonly taskKind: 'news-ingest' },
  payload: Readonly<{ readonly query: string; readonly limit?: number }>,
): INewsIngestExecutionRequest => {
  return {
    cluster: context.cluster,
    query: payload.query,
    limit: payload.limit,
    asOf: context.asOf,
    timeWindow: context.timeWindow,
  };
};

const toStockSyncRequest = (
  context: IAgentCommandContext & { readonly taskKind: 'stock-sync' },
  payload: Readonly<{
    readonly symbol: string;
    readonly stockId: string;
    readonly stockName: string;
    readonly industry: string;
    readonly limit?: number;
  }>,
): IStockSyncExecutionRequest => {
  return {
    cluster: context.cluster,
    symbol: payload.symbol,
    stockId: payload.stockId,
    stockName: payload.stockName,
    industry: payload.industry,
    limit: payload.limit,
    asOf: context.asOf,
    timeWindow: context.timeWindow,
  };
};

export const createNewsIngestAgentCommand = (
  context: IAgentCommandContext & { readonly taskKind: 'news-ingest' },
  payload: Readonly<{ readonly query: string; readonly limit?: number }>,
  service: Pick<INewsIngestServiceLike, 'execute'>,
): IAgentExecutionCommand<'news-ingest', { readonly query: string; readonly limit?: number }, INewsIngestResult> => {
  return createAgentExecutionCommand({
    taskKind: 'news-ingest',
    context,
    payload,
    execute: async ({ context: nextContext, payload: nextPayload }) => {
      const serviceResult = await service.execute(toNewsIngestRequest(nextContext, nextPayload));
      return {
        taskKind: 'news-ingest',
        context: nextContext,
        payload: nextPayload,
        serviceResult,
        success: serviceResult.status === 'success',
        failure: serviceResult.status === 'failure' ? createFailureDetail(serviceResult) : undefined,
      };
    },
  });
};

export const createStockSyncAgentCommand = (
  context: IAgentCommandContext & { readonly taskKind: 'stock-sync' },
  payload: Readonly<{
    readonly symbol: string;
    readonly stockId: string;
    readonly stockName: string;
    readonly industry: string;
    readonly limit?: number;
  }>,
  service: Pick<IStockSyncServiceLike, 'execute'>,
): IAgentExecutionCommand<
  'stock-sync',
  {
    readonly symbol: string;
    readonly stockId: string;
    readonly stockName: string;
    readonly industry: string;
    readonly limit?: number;
  },
  IStockSyncResult
> => {
  return createAgentExecutionCommand({
    taskKind: 'stock-sync',
    context,
    payload,
    execute: async ({ context: nextContext, payload: nextPayload }) => {
      const serviceResult = await service.execute(toStockSyncRequest(nextContext, nextPayload));
      return {
        taskKind: 'stock-sync',
        context: nextContext,
        payload: nextPayload,
        serviceResult,
        success: serviceResult.status === 'success',
        failure: serviceResult.status === 'failure' ? createFailureDetail(serviceResult) : undefined,
      };
    },
  });
};

export type AgentCommandResult<TKind extends AgentTaskKind, TPayload, TResult> = ICommandResult<
  IAgentExecutionResult<TKind, TPayload, TResult>
>;
