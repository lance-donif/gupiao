import type { SourceFailureCategory } from '../sources/contracts.js';

import type { IServiceExecutionContext, IServiceRuntimeContext } from './service-types.js';

export interface INewsIngestExecutionRequest extends IServiceRuntimeContext {
  readonly query: string;
  readonly limit?: number;
}

export type NewsIngestStage = 'fetch' | 'normalize' | 'deduplicate' | 'persist';

export interface INewsIngestStageReport {
  readonly stage: NewsIngestStage;
  readonly inputCount: number;
  readonly outputCount: number;
  readonly detail: string;
}

export enum NewsIngestFailureCategory {
  SourceFailed = 'source_failed',
  PersistenceFailed = 'persistence_failed',
}

export interface INewsIngestFailure {
  readonly category: NewsIngestFailureCategory;
  readonly message: string;
  readonly sourceCategory?: SourceFailureCategory;
}

export interface INewsIngestExecutionSummary {
  readonly executionContext: IServiceExecutionContext;
  readonly cluster: string;
  readonly query: string;
  readonly fetchedCount: number;
  readonly normalizedCount: number;
  readonly deduplicatedCount: number;
  readonly persistedCount: number;
  readonly persistedIds: readonly string[];
  readonly stageReports: readonly INewsIngestStageReport[];
}

export interface INewsIngestFailureSummary extends INewsIngestExecutionSummary {
  readonly failure: INewsIngestFailure;
}

export interface INewsIngestSuccessResult {
  readonly status: 'success';
  readonly summary: INewsIngestExecutionSummary;
}

export interface INewsIngestFailureResult {
  readonly status: 'failure';
  readonly summary: INewsIngestFailureSummary;
}

export type INewsIngestResult = INewsIngestSuccessResult | INewsIngestFailureResult;
