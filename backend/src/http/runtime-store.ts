import type { GraphKind } from './runtime-types.js';
import type {
  BackendConfigCategory,
  IBackendArtifacts,
  IBackendConfigStore,
  IBackendRuntimeStoreOptions,
  IContributionDetailPayload,
  IDashboardEvidencePayload,
  IDashboardNetworkPayload,
  IDashboardSnapshotPayload,
  IDashboardStockDetailPayload,
  IDispatchDailyInput,
  IMLRecommendationQuery,
  IStrategyProfitQuery,
} from './types.js';
import { toBeijingDate } from './beijing-time.js';
import { RuntimeAnalyticsOperations } from './runtime-analytics-operations.js';
import { RuntimeClusterOperations } from './runtime-cluster-operations.js';
import { RuntimeDataOperations } from './runtime-data-operations.js';
import { createRuntimeDependencies } from './runtime-store-shared.js';

export class BackendRuntimeStore {
  private readonly data: RuntimeDataOperations;
  private readonly cluster: RuntimeClusterOperations;
  private readonly analytics: RuntimeAnalyticsOperations;

  public constructor(options: IBackendRuntimeStoreOptions) {
    const deps = createRuntimeDependencies(options);
    this.data = new RuntimeDataOperations(deps);
    this.cluster = new RuntimeClusterOperations(deps);
    this.analytics = new RuntimeAnalyticsOperations(deps);
  }

  public async dispatchDaily(input: IDispatchDailyInput) {
    return this.data.dispatchDaily(input);
  }

  public async listClusters() {
    return this.cluster.listClusters();
  }

  public async listClusterVersions(groupId: string) {
    return this.cluster.listClusterVersions(groupId);
  }

  public async listClusterFeedback(groupId: string, displayDate: string) {
    return this.cluster.listClusterFeedback(groupId, displayDate);
  }

  public async saveClusterFeedback(input: {
    group_id: string;
    group_version_id: string;
    display_date: string;
    ticker: string;
    score: number;
    reason?: string | null;
    trace_id?: string;
  }) {
    return this.cluster.saveClusterFeedback(input);
  }

  public async getPromotePreflight(groupId: string) {
    return this.cluster.getPromotePreflight(groupId);
  }

  public async promoteCluster(input: { group_id: string; reason?: string | null; feedback_id?: string | null }) {
    return this.cluster.promoteCluster(input);
  }

  public async confirmPromoteCluster(input: {
    group_id: string;
    group_version_id: string;
    confirmed_by?: string | null;
  }) {
    return this.cluster.confirmPromoteCluster(input);
  }

  public async rollbackCluster(input: {
    group_id: string;
    target_group_version_id: string;
    reason: string;
    trace_id?: string;
  }) {
    return this.cluster.rollbackCluster(input);
  }

  public async getHorizonPolicy(groupId: string) {
    return this.cluster.getHorizonPolicy(groupId);
  }

  public async updateHorizonPolicy(groupId: string, payload: Record<string, unknown>) {
    return this.cluster.updateHorizonPolicy(groupId, payload);
  }

  public async getAutopilotPolicy(groupId: string) {
    return this.cluster.getAutopilotPolicy(groupId);
  }

  public async updateAutopilotPolicy(groupId: string, payload: Record<string, unknown>) {
    return this.cluster.updateAutopilotPolicy(groupId, payload);
  }

  public async listBatches(limit: number) {
    return this.data.listBatches(limit);
  }

  public async getBatchByTraceId(traceId: string) {
    return this.data.getBatchByTraceId(traceId);
  }

  public async getLatestBatchByGroup(groupId: string, targetDate?: string | null) {
    return this.data.getLatestBatchByGroup(groupId, targetDate);
  }

  public async getLatestBatchProgress(groupId: string, targetDate?: string | null) {
    return this.data.getLatestBatchProgress(groupId, targetDate);
  }

  public async getBatchNodeResult(
    batchId: string,
    nodeId: string,
    section: string | undefined,
    page: number,
    pageSize: number,
  ) {
    return this.data.getBatchNodeResult(batchId, nodeId, section, page, pageSize);
  }

  public async getContributionDetail(traceId: string, symbol: string): Promise<IContributionDetailPayload | null> {
    return this.data.getContributionDetail(traceId, symbol);
  }

  public async listStrategies(groupId: string) {
    return this.data.listStrategies(groupId);
  }

  public async createStrategy(groupId: string, payload: Record<string, unknown>) {
    return this.data.createStrategy(groupId, payload);
  }

  public async updateStrategy(groupId: string, strategyId: string, payload: Record<string, unknown>) {
    return this.data.updateStrategy(groupId, strategyId, payload);
  }

  public async copyStrategy(groupId: string, strategyId: string, payload: Record<string, unknown>) {
    return this.data.copyStrategy(groupId, strategyId, payload);
  }

  public async deleteStrategy(groupId: string, strategyId: string) {
    return this.data.deleteStrategy(groupId, strategyId);
  }

  public async getStrategyProfits(groupId: string, asOf: string, query?: IStrategyProfitQuery | string | null) {
    return this.data.getStrategyProfits(groupId, asOf, query);
  }

  public async listRecommendations(tradeDate: string, groupId: string) {
    return this.data.listRecommendations(tradeDate, groupId);
  }

  public async listNonTradingRecommendations(displayDate: string, groupId: string) {
    return this.data.listNonTradingRecommendations(displayDate, groupId);
  }

  public async getDailyReport(displayDate: string, groupId: string) {
    return this.data.getDailyReport(displayDate, groupId);
  }

  public async getDashboardSnapshot(displayDate: string, groupId: string, strategyId?: string | null): Promise<IDashboardSnapshotPayload> {
    return this.data.getDashboardSnapshot(displayDate, groupId, strategyId);
  }

  public async getDashboardStockDetail(
    symbol: string,
    traceId: string,
    groupId: string,
    strategyId?: string | null,
  ): Promise<IDashboardStockDetailPayload> {
    return this.data.getDashboardStockDetail(symbol, traceId, groupId, strategyId);
  }

  public async getDashboardStockEvidence(symbol: string, traceId: string, groupId: string): Promise<IDashboardEvidencePayload> {
    return this.data.getDashboardStockEvidence(symbol, traceId, groupId);
  }

  public async getDashboardStockNetwork(symbol: string, traceId: string, groupId: string): Promise<IDashboardNetworkPayload> {
    return this.data.getDashboardStockNetwork(symbol, traceId, groupId);
  }

  public async getGraph(
    cutoffDate: string,
    groupId: string,
    maxNodes: number = 200,
  ): Promise<{ nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> }> {
    return this.data.getGraph(cutoffDate, groupId, maxNodes) as Promise<{
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
    }>;
  }

  public async getRuntimeGraph(traceId: string, graphKind: GraphKind, maxNodes: number = 2000) {
    return this.data.getRuntimeGraph(traceId, graphKind, maxNodes);
  }

  public async getTraceOverview(traceId: string) {
    return this.data.getTraceOverview(traceId);
  }

  public async getTraceSteps(
    traceId: string,
    cursor: number | undefined,
    limit: number,
  ): Promise<{ trace_id: string; rows: Array<Record<string, unknown>>; next_cursor: number | null; has_more: boolean }> {
    return this.data.getTraceSteps(traceId, cursor, limit) as Promise<{
      trace_id: string;
      rows: Array<Record<string, unknown>>;
      next_cursor: number | null;
      has_more: boolean;
    }>;
  }

  public async getTraceEvents(
    traceId: string,
    cursor: number | undefined,
    limit: number,
  ): Promise<{ trace_id: string; rows: Array<Record<string, unknown>>; next_cursor: number | null; has_more: boolean }> {
    return this.data.getTraceEvents(traceId, cursor, limit) as Promise<{
      trace_id: string;
      rows: Array<Record<string, unknown>>;
      next_cursor: number | null;
      has_more: boolean;
    }>;
  }

  public async getTraceEventsAfter(traceId: string, lastEventId: number): Promise<readonly Record<string, unknown>[]> {
    return this.data.getTraceEventsAfter(traceId, lastEventId) as Promise<readonly Record<string, unknown>[]>;
  }

  public async getTraceCosts(traceId: string) {
    return this.data.getTraceCosts(traceId);
  }

  public async getMetricsOverview() {
    return this.analytics.getMetricsOverview();
  }

  public async getMetricsTrace(traceId: string, cursor: number | undefined, limit: number) {
    return this.analytics.getMetricsTrace(traceId, cursor, limit);
  }

  public async getLatencyOverview(windowMinutes: number) {
    return this.analytics.getLatencyOverview(windowMinutes);
  }

  public async getLatencyEndpoints(windowMinutes: number) {
    return this.analytics.getLatencyEndpoints(windowMinutes);
  }

  public async getLatencyInteractions(windowMinutes: number) {
    return this.analytics.getLatencyInteractions(windowMinutes);
  }

  public async postLatencyInteraction(payload: {
    interaction: string;
    duration_ms: number;
    group_id?: string | null;
    trade_date?: string | null;
    ok: boolean;
  }) {
    return this.analytics.postLatencyInteraction(payload);
  }

  public async recordEndpointRequest(input: { method: string; path: string; duration_ms: number; ok: boolean }) {
    return this.analytics.recordEndpointRequest(input);
  }

  public async listConfigByCategory(category: BackendConfigCategory): Promise<{ items: readonly unknown[] }> {
    return this.cluster.listConfigByCategory(category);
  }

  public async updateConfig(key: string, value: string) {
    return this.cluster.updateConfig(key, value);
  }

  public async getMLRecommendations(query: IMLRecommendationQuery) {
    return this.data.getMLRecommendations(query);
  }

  public async getRealtimeQuote(ticker: string) {
    return this.data.getRealtimeQuote(ticker);
  }

  public async runWhatIf(payload: {
    group_id: string;
    query: string;
    cutoff_date: string;
    max_hops: number;
    max_items: number;
  }) {
    return this.analytics.runWhatIf(payload);
  }

  public async listWhatIfHistory(groupId: string, limit: number) {
    return this.analytics.listWhatIfHistory(groupId, limit);
  }

  public async runBacktest(payload: { group_id: string; end_date: string; window_days: number }) {
    return this.analytics.runBacktest(payload);
  }

  public async loadArtifactsForTests(): Promise<IBackendArtifacts> {
    return this.data.loadArtifactsForTests();
  }
}

export const createBackendRuntimeStore = (rootDir: string, configStore: IBackendConfigStore): BackendRuntimeStore => {
  return new BackendRuntimeStore({ rootDir, configStore });
};

export const resolveDefaultTargetDate = (): string => toBeijingDate(new Date());

export type { IBackendRuntimeStoreOptions };
