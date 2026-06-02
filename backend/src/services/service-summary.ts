import type { INewsIngestResult } from './news-ingest-types.js';
import type { IStockSyncResult } from './stock-sync-types.js';

export type ServiceCommandKind = 'help' | 'news-ingest' | 'stock-sync';

export interface IServiceSuccessCliResult {
  readonly command: ServiceCommandKind;
  readonly status: 'success';
  readonly exitCode: 0;
  readonly output: string;
  readonly summary: unknown;
}

export interface IServiceFailureCliResult {
  readonly command: ServiceCommandKind;
  readonly status: 'failure';
  readonly exitCode: 1;
  readonly output: string;
  readonly summary: unknown;
  readonly failureCategory: string;
}

export type IServiceCliRunResult = IServiceSuccessCliResult | IServiceFailureCliResult;

export type ServiceExecutionResult = INewsIngestResult | IStockSyncResult;

const formatJson = (value: unknown): string => {
  return JSON.stringify(value, null, 2);
};

export const createCliSuccessResult = (
  command: ServiceCommandKind,
  summary: unknown,
): IServiceSuccessCliResult => {
  return {
    command,
    status: 'success',
    exitCode: 0,
    summary,
    output: formatJson({
      command,
      status: 'success',
      summary,
    }),
  };
};

export const createCliFailureResult = (
  command: Exclude<ServiceCommandKind, 'help'>,
  summary: unknown,
  failureCategory: string,
): IServiceFailureCliResult => {
  return {
    command,
    status: 'failure',
    exitCode: 1,
    summary,
    failureCategory,
    output: formatJson({
      command,
      status: 'failure',
      failureCategory,
      summary,
    }),
  };
};

export const createHelpResult = (helpText: string): IServiceSuccessCliResult => {
  return {
    command: 'help',
    status: 'success',
    exitCode: 0,
    summary: {
      help: true,
    },
    output: helpText,
  };
};

export const toCliRunResult = (
  command: Exclude<ServiceCommandKind, 'help'>,
  result: ServiceExecutionResult,
): IServiceCliRunResult => {
  if (result.status === 'success') {
    return createCliSuccessResult(command, result.summary);
  }

  return createCliFailureResult(command, result.summary, result.summary.failure.category);
};
