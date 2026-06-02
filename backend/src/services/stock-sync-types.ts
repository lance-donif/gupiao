import type { SourceFailureCategory } from '../sources/contracts.js';

import type { IServiceExecutionContext, IServiceRuntimeContext } from './service-types.js';

export interface IStockSyncExecutionRequest extends IServiceRuntimeContext {
  readonly symbol: string;
  readonly stockId: string;
  readonly stockName: string;
  readonly industry: string;
  readonly limit?: number;
}

export type StockSyncStage = 'fetch' | 'map-domain' | 'plan-sync' | 'persist';

export interface IStockSyncStageReport {
  readonly stage: StockSyncStage;
  readonly inputCount: number;
  readonly outputCount: number;
  readonly detail: string;
}

export type StockSyncDecisionKind = 'created' | 'updated' | 'skipped';

export interface IStockSyncDecision {
  readonly kind: StockSyncDecisionKind;
  readonly stockId: string;
  readonly symbol: string;
  readonly candleTradeDay: string;
  readonly reason: string;
}

export enum StockSyncFailureCategory {
  SourceFailed = 'source_failed',
  PersistenceFailed = 'persistence_failed',
}

export interface IStockSyncFailure {
  readonly category: StockSyncFailureCategory;
  readonly message: string;
  readonly sourceCategory?: SourceFailureCategory;
}

export interface IStockSyncExecutionSummary {
  readonly executionContext: IServiceExecutionContext;
  readonly cluster: string;
  readonly requestedSymbol: string;
  readonly fetchedCount: number;
  readonly mappedCount: number;
  readonly persistedCount: number;
  readonly persistedStockIds: readonly string[];
  readonly decisions: {
    readonly created: readonly IStockSyncDecision[];
    readonly updated: readonly IStockSyncDecision[];
    readonly skipped: readonly IStockSyncDecision[];
  };
  readonly stageReports: readonly IStockSyncStageReport[];
}

export interface IStockSyncFailureSummary extends IStockSyncExecutionSummary {
  readonly failure: IStockSyncFailure;
}

export interface IStockSyncSuccessResult {
  readonly status: 'success';
  readonly summary: IStockSyncExecutionSummary;
}

export interface IStockSyncFailureResult {
  readonly status: 'failure';
  readonly summary: IStockSyncFailureSummary;
}

export type IStockSyncResult = IStockSyncSuccessResult | IStockSyncFailureResult;
