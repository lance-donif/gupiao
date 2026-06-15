import type { IRuntimeStoreDependencies } from './runtime-store-shared.js';
import type { BatchStatus, GraphKind, IRuntimeBatchRecord, IRuntimeNode, ITraceRecord, ITraceStepRecord } from './runtime-types.js';
import type {
  IBackendArtifacts,
  IContributionDetailPayload,
  IDashboardEvidenceChainItem,
  IDashboardEvidencePayload,
  IDashboardExecutionHistoryItem,
  IDashboardNetworkEdge,
  IDashboardNetworkNode,
  IDashboardNetworkPayload,
  IDashboardRecommendationItem,
  IDashboardSnapshotPayload,
  IDashboardStockDetailPayload,
  IDispatchDailyInput,
  IExpectationGapDisplayItem,
  ILiveQuotePayload,
  ILiveQuoteReader,
  IMLRecommendationQuery,
  IStrategyConfig,
  IStrategyDefinitionRecord,
  IStrategyProfitPayload,
  IStrategyProfitQuery,
  IStrategyPerformanceReportPayload,
  IThemeForecastDisplayItem,
} from './types.js';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getNextScheduledRunBeijing } from '../services/mvp-daily-scheduler.js';
import { defaultStrategyExperimentConfig, normalizeStrategyExperimentConfig } from '../services/strategy-experiment-core.js';
import { nowBeijingDateTime, toEpochSeconds } from './beijing-time.js';
import { buildDashboardUiSummary } from './dashboard-ui-summary.js';
import {
  buildMLRecommendations,
  buildNonTradingRecommendationDocuments,
  buildRecommendationDocuments,
} from './recommendation-builders.js';
import { ensureCluster } from './runtime-store-shared.js';
import { buildTraceCosts, buildTraceOverview, paginateRows } from './secondary-builders.js';
import { buildRuntimeGraph } from './trace-builders.js';

const PIPELINE_STEPS = [
  { id: 'news_fetch', label: '读取新闻' },
  { id: 'normalize', label: '新闻标准化' },
  { id: 'deduplicate', label: '新闻去重' },
  { id: 'persist_news', label: '保存新闻' },
  { id: 'stock_exposure_tickflow', label: '验证股票暴露' },
  { id: 'causal_signal_extraction', label: 'AI 因果抽取' },
  { id: 'graph_snapshot', label: '构建关系网络' },
  { id: 'scoring_recommendation', label: '生成推荐' },
  { id: 'strategy_experiment', label: '多策略推荐' },
] as const;

interface IDbRunTraceRow {
  readonly traceId: string;
  readonly status: string;
  readonly triggeredAt: string;
  readonly completedAt: string | null;
  readonly asOf: string;
  readonly clusterKey: string;
  readonly errorMessage?: string | null;
}

interface IDbStepTraceRow {
  readonly stepName: string;
  readonly status: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly errorMessage: string | null;
  readonly inputSummary?: Record<string, unknown> | null;
  readonly outputSummary?: Record<string, unknown> | null;
}

interface IDashboardRecommendationDbRow {
  readonly traceId: string;
  readonly asOf: string;
  readonly rank: number;
  readonly symbol: string;
  readonly stockName: string;
  readonly industry: string;
  readonly finalScore: string | number;
  readonly reasons: readonly string[];
  readonly scoreBreakdown: Record<string, unknown>;
  readonly latestClose: string | number | null;
  readonly latestTradingDay: string | null;
  readonly evidenceCount: number;
  readonly l1EvidenceCount: number;
  readonly avgMatchConfidence: string | number | null;
  readonly totalContribution: string | number | null;
  readonly strategyId: string | null;
}

interface IDashboardExecutionDbRow {
  readonly traceId: string;
  readonly clusterKey: string;
  readonly status: string;
  readonly triggeredAt: string;
  readonly completedAt: string | null;
  readonly asOf: string;
  readonly errorMessage: string | null;
  readonly stepName: string | null;
  readonly stepStatus: string | null;
  readonly stepErrorMessage: string | null;
}

interface IDashboardTraceMetaDbRow {
  readonly status: string;
  readonly triggeredAt: string;
  readonly completedAt: string | null;
}

interface IDashboardEvidenceDbRow {
  readonly chainId: string;
  readonly newsId: string;
  readonly symbol: string;
  readonly stockName: string | null;
  readonly industry: string | null;
  readonly keyword: string;
  readonly sourceKeyword: string | null;
  readonly matchedExposureKeyword: string | null;
  readonly exposureFactId: string | null;
  readonly matchMethod: string | null;
  readonly matchConfidence: string | number | null;
  readonly baseFrequencyScore: string | number;
  readonly timeDecayedScore: string | number;
  readonly reprintPenaltyScore: string | number;
  readonly finalContribScore: string | number;
  readonly reasons: readonly string[];
  readonly newsTitle: string | null;
  readonly newsContent: string | null;
  readonly newsSource: string | null;
  readonly newsUrl: string | null;
  readonly newsPublishedAt: string | null;
  readonly exposureType: string | null;
  readonly taxonomyLevel: string | null;
  readonly exposureSource: string | null;
  readonly exposureSourceId: string | null;
  readonly exposureSourceName: string | null;
  readonly exposureEvidenceJson: unknown;
  readonly exposureConfidence: string | number | null;
  readonly exposureValidFrom: string | null;
  readonly exposureUpdatedAt: string | null;
}

interface IMarketSignalDbRow {
  readonly latestTradingDay: string | null;
  readonly momentum5dPct: string | number | null;
  readonly momentum20dPct: string | number | null;
  readonly volumeRatio20d: string | number | null;
  readonly breakout20d: boolean;
  readonly volatilityCompression: boolean;
  readonly recentWeekGainExceeded: boolean;
  readonly reasons: readonly string[];
}

interface IPgPoolLike {
  query: <T>(sql: string, params?: readonly unknown[]) => Promise<{ rows: readonly T[] }>;
}

interface IStockNameCandidate {
  readonly symbol: string;
  readonly stockName: string | null | undefined;
}

interface IStockNameLookupRow {
  readonly symbol: string;
  readonly stockName: string | null;
  readonly source?: string | null;
  readonly taxonomyLevel?: string | null;
  readonly confidence?: string | number | null;
}

interface ILiveQuoteDbRow {
  readonly symbol: string;
  readonly tradingDay: string | null;
  readonly close: string | number | null;
  readonly low: string | number | null;
  readonly high: string | number | null;
  readonly capturedAt: string | null;
}

interface ITickFlowQuoteExtension {
  readonly name?: string | null;
}

interface ITickFlowQuoteRow {
  readonly symbol?: string | null;
  readonly last_price?: number | string | null;
  readonly low?: number | string | null;
  readonly high?: number | string | null;
  readonly timestamp?: Date | string | number | null;
  readonly ext?: ITickFlowQuoteExtension | null;
}

interface ITickFlowQuoteResponse {
  readonly data?: readonly ITickFlowQuoteRow[];
  readonly code?: string;
  readonly message?: string;
}

interface ITickFlowQuoteReaderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

const toClusterKey = (groupId: string): string => groupId === 'main' ? 'global' : groupId;

const toGroupId = (clusterKey: string): string => clusterKey === 'global' ? 'main' : clusterKey;

const toAsOfIso = (targetDate: string): string => `${targetDate}T15:59:59.999Z`;

const toTradeDate = (value: string): string | null => {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) {
    return trimmed;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
};

const normalizeDateFilter = (value?: string | null): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/u.test(trimmed) ? trimmed : null;
};

const toIsoText = (value: unknown): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value ?? '');
};

const toNullableIsoText = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  return toIsoText(value);
};

const toNumberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toPositiveNumberOrNull = (value: unknown): number | null => {
  const parsed = toNumberOrNull(value);
  return parsed !== null && parsed > 0 ? parsed : null;
};

const DEFAULT_TICKFLOW_BASE_URL = 'https://api.tickflow.org';

const normalizeBaseUrl = (value: string): string => {
  return value.endsWith('/') ? value.slice(0, -1) : value;
};

const toTickFlowSymbol = (symbol: string): string => {
  const normalized = symbol.trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ|BJ)$/u.test(normalized)) {
    return normalized;
  }
  if (symbol.startsWith('6')) {
    return `${symbol}.SH`;
  }
  if (symbol.startsWith('0') || symbol.startsWith('3')) {
    return `${symbol}.SZ`;
  }
  if (symbol.startsWith('4') || symbol.startsWith('8') || symbol.startsWith('920')) {
    return `${symbol}.BJ`;
  }
  return symbol;
};

const normalizeTickFlowQuoteSymbol = (symbol: string | null | undefined): string | null => {
  const match = String(symbol ?? '').trim().toUpperCase().match(/^(\d{6})\.(SH|SZ|BJ)$/u);
  return match ? match[1] : null;
};

const parseQuoteTime = (value: Date | string | number | null | undefined): string | null => {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === 'number') {
    const parsed = new Date(value < 1_000_000_000_000 ? value * 1000 : value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  return null;
};

const chunkRows = <T>(rows: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push([...rows.slice(index, index + size)]);
  }
  return chunks;
};

export const createTickFlowQuoteReader = (options: ITickFlowQuoteReaderOptions): ILiveQuoteReader => {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_TICKFLOW_BASE_URL);
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async getQuotes(symbols: readonly string[]): Promise<ReadonlyMap<string, ILiveQuotePayload>> {
      const normalizedSymbols = [...new Set(symbols.map(symbol => symbol.trim()).filter(Boolean))];
      if (normalizedSymbols.length === 0) {
        return new Map();
      }
      const quotes = new Map<string, ILiveQuotePayload>();
      for (const group of chunkRows(normalizedSymbols, 100)) {
        const tickFlowSymbols = group.map(toTickFlowSymbol);
        const symbolByTickFlowSymbol = new Map(tickFlowSymbols.map((symbol, index) => [symbol, group[index]!]));
        const response = await fetchImpl(`${baseUrl}/v1/quotes`, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'x-api-key': options.apiKey,
          },
          body: JSON.stringify({ symbols: tickFlowSymbols }),
        });
        if (!response.ok) {
          throw new Error(`TickFlow /v1/quotes failed with HTTP ${response.status}`);
        }
        const payload = await response.json() as ITickFlowQuoteResponse;
        for (const quote of payload.data ?? []) {
          const originalSymbol
            = symbolByTickFlowSymbol.get(String(quote.symbol ?? '').trim().toUpperCase())
              ?? normalizeTickFlowQuoteSymbol(quote.symbol);
          if (!originalSymbol || !group.includes(originalSymbol)) {
            continue;
          }
          const price = toPositiveNumberOrNull(quote.last_price);
          if (price === null) {
            continue;
          }
          quotes.set(originalSymbol, {
            price,
            day_low: toPositiveNumberOrNull(quote.low),
            day_high: toPositiveNumberOrNull(quote.high),
            market_time: parseQuoteTime(quote.timestamp),
            source: 'tickflow',
            status: 'LIVE',
          });
        }
      }
      return quotes;
    },
  };
};

let tickFlowQuoteReader: ILiveQuoteReader | null = null;

const createDefaultQuoteReader = (): ILiveQuoteReader | null => {
  const apiKey = process.env.TICKFLOW_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }
  tickFlowQuoteReader ??= createTickFlowQuoteReader({
    apiKey,
    baseUrl: process.env.TICKFLOW_BASE_URL,
  });
  return tickFlowQuoteReader;
};

const shouldSkipDefaultQuoteReader = (): boolean => {
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
};

const CHINESE_TEXT_PATTERN = /[\u4E00-\u9FFF]/u;
const A_SHARE_SYMBOL_PATTERN = /^\d{6}$/u;
const STOCK_NAME_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const AKTOOLS_STOCK_NAME_ENDPOINT = '/api/public/stock_info_a_code_name';

let aktoolsStockNameCache: { readonly loadedAt: number; readonly names: ReadonlyMap<string, string> } | null = null;

const hasChineseText = (value: string | null | undefined): boolean => CHINESE_TEXT_PATTERN.test(String(value ?? ''));

const normalizeStockSymbol = (value: unknown): string | null => {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/\..*$/u, '')
    .replace(/^sh|^sz|^bj/iu, '');
  return A_SHARE_SYMBOL_PATTERN.test(cleaned) ? cleaned : null;
};

const readNameField = (record: Readonly<Record<string, unknown>>): string | null => {
  for (const key of ['name', 'stock_name', '名称', 'stockName']) {
    const value = record[key];
    if (value === null || value === undefined) {
      continue;
    }
    const text = String(value).trim();
    if (text.length > 0) {
      return text;
    }
  }
  return null;
};

const readSymbolField = (record: Readonly<Record<string, unknown>>): string | null => {
  for (const key of ['code', 'symbol', '代码']) {
    const symbol = normalizeStockSymbol(record[key]);
    if (symbol) {
      return symbol;
    }
  }
  return null;
};

const aktoolsBaseUrl = (): string => (process.env.AKTOOLS_BASE_URL ?? 'http://127.0.0.1:8010').replace(/\/+$/u, '');

const fetchAktoolsStockNameMap = async (): Promise<ReadonlyMap<string, string>> => {
  const now = Date.now();
  if (aktoolsStockNameCache && now - aktoolsStockNameCache.loadedAt < STOCK_NAME_CACHE_TTL_MS) {
    return aktoolsStockNameCache.names;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`${aktoolsBaseUrl()}${AKTOOLS_STOCK_NAME_ENDPOINT}`, { signal: controller.signal });
    if (!response.ok) {
      return new Map();
    }
    const payload = await response.json() as unknown;
    const rows = Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object' && Array.isArray((payload as { readonly data?: unknown }).data)
        ? (payload as { readonly data: readonly unknown[] }).data
        : [];
    const names = new Map<string, string>();
    for (const row of rows) {
      if (!row || typeof row !== 'object') {
        continue;
      }
      const record = row as Record<string, unknown>;
      const symbol = readSymbolField(record);
      const name = readNameField(record);
      if (symbol && name && hasChineseText(name)) {
        names.set(symbol, name);
      }
    }
    aktoolsStockNameCache = { loadedAt: now, names };
    return names;
  }
  catch {
    return new Map();
  }
  finally {
    clearTimeout(timeout);
  }
};

const resolveChineseStockNameMap = async (
  pool: IPgPoolLike,
  clusterKey: string,
  candidates: readonly IStockNameCandidate[],
): Promise<ReadonlyMap<string, string>> => {
  const symbols = [...new Set(candidates.map(row => normalizeStockSymbol(row.symbol)).filter((symbol): symbol is string => symbol !== null))];
  const resolved = new Map<string, string>();

  for (const row of candidates) {
    const symbol = normalizeStockSymbol(row.symbol);
    const name = String(row.stockName ?? '').trim();
    if (symbol && name && hasChineseText(name)) {
      resolved.set(symbol, name);
    }
  }
  const unresolvedSymbols = (): string[] => symbols.filter(symbol => !resolved.has(symbol));
  if (unresolvedSymbols().length === 0) {
    return resolved;
  }

  const stockRows = await pool.query<IStockNameLookupRow>(
    'SELECT symbol, name AS "stockName" FROM public."Stock" WHERE "clusterKey" = $1 AND symbol = ANY($2::text[])',
    [clusterKey, unresolvedSymbols()],
  );
  for (const row of stockRows.rows) {
    const symbol = normalizeStockSymbol(row.symbol);
    const name = String(row.stockName ?? '').trim();
    if (symbol && name && hasChineseText(name) && !resolved.has(symbol)) {
      resolved.set(symbol, name);
    }
  }
  if (unresolvedSymbols().length === 0) {
    return resolved;
  }

  const exposureRows = await pool.query<IStockNameLookupRow>(
    [
      'SELECT symbol, "stockName", source, "taxonomyLevel", confidence',
      'FROM public."StockExposureFact"',
      'WHERE "clusterKey" = $1 AND status = $2 AND symbol = ANY($3::text[])',
      'ORDER BY confidence DESC NULLS LAST, "updatedAt" DESC',
    ].join(' '),
    [clusterKey, 'active', unresolvedSymbols()],
  );
  for (const row of exposureRows.rows) {
    const symbol = normalizeStockSymbol(row.symbol);
    const name = String(row.stockName ?? '').trim();
    if (symbol && name && hasChineseText(name) && !resolved.has(symbol)) {
      resolved.set(symbol, name);
    }
  }
  if (unresolvedSymbols().length === 0) {
    return resolved;
  }

  const aktoolsNames = await fetchAktoolsStockNameMap();
  for (const symbol of unresolvedSymbols()) {
    const name = aktoolsNames.get(symbol);
    if (name && hasChineseText(name)) {
      resolved.set(symbol, name);
    }
  }
  return resolved;
};

type ProfitHorizonKey = 'live' | 't1' | 't3' | 't5';

const PROFIT_HORIZON_KEYS: readonly ProfitHorizonKey[] = ['live', 't1', 't3', 't5'];

const buildProfitHorizon = (
  tradingDay: unknown,
  price: unknown,
  basePrice: number,
  live: boolean,
  meta: {
    readonly priceSource?: ILiveQuotePayload['source'] | 'settlement';
    readonly priceTime?: string | null;
    readonly settlementNote?: string | null;
  } = {},
): {
  readonly trading_day: string | null;
  readonly price: number | null;
  readonly return_pct: number | null;
  readonly status: 'LIVE' | 'FINAL' | 'PENDING' | 'NO_CURRENT_PRICE' | 'NO_BASE_PRICE';
  readonly price_source: ILiveQuotePayload['source'] | 'settlement';
  readonly price_time: string | null;
  readonly settlement_note: string | null;
} => {
  const close = toNumberOrNull(price);
  const priceSource = meta.priceSource ?? (live ? 'unavailable' : 'settlement');
  const priceTime = meta.priceTime ?? toNullableIsoText(tradingDay);
  if (basePrice <= 0) {
    return {
      trading_day: toNullableIsoText(tradingDay),
      price: close,
      return_pct: null,
      status: 'NO_BASE_PRICE',
      price_source: priceSource,
      price_time: priceTime,
      settlement_note: meta.settlementNote ?? '缺少推荐基准价，无法计算收益',
    };
  }
  if (close === null) {
    return {
      trading_day: null,
      price: null,
      return_pct: null,
      status: live ? 'NO_CURRENT_PRICE' : 'PENDING',
      price_source: priceSource,
      price_time: null,
      settlement_note: meta.settlementNote ?? (live ? '实时行情不可用，且无可用 K 线' : '等待目标交易日 K 线入库'),
    };
  }

  return {
    trading_day: toNullableIsoText(tradingDay),
    price: close,
    return_pct: (close - basePrice) / basePrice,
    status: live ? 'LIVE' : 'FINAL',
    price_source: priceSource,
    price_time: priceTime,
    settlement_note: meta.settlementNote ?? null,
  };
};

const summarizeProfitHorizon = <T extends { readonly horizons: Record<ProfitHorizonKey, { readonly return_pct: number | null; readonly status: string }> }>(
  items: readonly T[],
  horizon: ProfitHorizonKey,
): {
  readonly sample_count: number;
  readonly pending_count: number;
  readonly final_count: number;
  readonly avg_return_pct: number | null;
  readonly win_rate: number | null;
  readonly max_drawdown_pct: number | null;
} => {
  const returns = items.map(item => item.horizons[horizon].return_pct).filter((value): value is number => value !== null);
  const maxDrawdown = returns.length === 0 ? null : Math.min(...returns);
  return {
    sample_count: items.length,
    pending_count: items.filter(item => item.horizons[horizon].status === 'PENDING' || item.horizons[horizon].status === 'NO_CURRENT_PRICE').length,
    final_count: returns.length,
    avg_return_pct: returns.length === 0 ? null : returns.reduce((sum, value) => sum + value, 0) / returns.length,
    win_rate: returns.length === 0 ? null : returns.filter(value => value > 0).length / returns.length,
    max_drawdown_pct: maxDrawdown,
  };
};

const buildTraceLabel = (traceId: string): string => {
  if (traceId.length <= 18) {
    return traceId;
  }
  return `${traceId.slice(0, 10)}…${traceId.slice(-6)}`;
};

const matchesReturnStatus = <T extends {
  readonly return_pct: number | null;
  readonly return_status: string;
  readonly horizons: Record<ProfitHorizonKey, { readonly status: string }>;
}>(row: T, status: string): boolean => {
  if (status === 'gain' || status === 'positive') {
    return row.return_pct !== null && row.return_pct > 0;
  }
  if (status === 'loss' || status === 'negative') {
    return row.return_pct !== null && row.return_pct < 0;
  }
  if (status === 'flat') {
    return row.return_pct === 0;
  }
  const normalized = status.toUpperCase();
  return row.return_status === normalized || PROFIT_HORIZON_KEYS.some(horizon => row.horizons[horizon].status === normalized);
};

const sortProfitRows = <T extends {
  readonly execution_time: string | null;
  readonly rank: number;
  readonly horizons: Record<ProfitHorizonKey, { readonly return_pct: number | null }>;
}>(
  rows: readonly T[],
  sortBy: IStrategyProfitQuery['sort_by'] = 'execution_time',
  sortOrder: IStrategyProfitQuery['sort_order'] = 'desc',
): T[] => {
  const key = sortBy ?? 'execution_time';
  const order = sortOrder === 'asc' ? 1 : -1;
  const readValue = (row: T): number | null => {
    if (key === 'rank') {
      return row.rank;
    }
    if (key === 'live' || key === 't1' || key === 't3' || key === 't5') {
      return row.horizons[key].return_pct;
    }
    const timestamp = Date.parse(row.execution_time ?? '');
    return Number.isFinite(timestamp) ? timestamp : null;
  };
  return [...rows].sort((left, right) => {
    const leftValue = readValue(left);
    const rightValue = readValue(right);
    if (leftValue === null && rightValue === null) {
      return left.rank - right.rank;
    }
    if (leftValue === null) {
      return 1;
    }
    if (rightValue === null) {
      return -1;
    }
    return (leftValue - rightValue) * order || left.rank - right.rank;
  });
};

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }
  const left = sorted[middle - 1] ?? 0;
  const right = sorted[middle] ?? 0;
  return (left + right) / 2;
};

const hasOwn = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key);

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const stageByIndex = (index: number, total: number): 'A' | 'B' | 'C' => {
  const aCutoff = Math.max(1, Math.ceil(total * 0.3));
  const bCutoff = Math.max(aCutoff + 1, Math.ceil(total * 0.7));
  if (index < aCutoff) {
    return 'A';
  }
  if (index < bCutoff) {
    return 'B';
  }
  return 'C';
};

const toChineseBatchStatus = (status: string): string => {
  switch (status) {
    case 'PENDING': return '排队中';
    case 'RUNNING': return '执行中';
    case 'COMPLETED': return '已完成';
    case 'DEGRADED': return '降级完成';
    case 'FAILED': return '失败';
    case 'SUCCESS': return '已完成';
    default: return status || '未知';
  }
};

const trimText = (value: string | null | undefined, maxLength: number): string => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
};

const dedupeStrings = (values: readonly string[]): readonly string[] => [...new Set(values.filter(Boolean))];

const findReasonByKeyword = (reasons: readonly string[], keyword: string | null | undefined): string | null => {
  const safeKeyword = String(keyword ?? '').trim();
  if (!safeKeyword) {
    return reasons[0] ?? null;
  }
  return reasons.find(reason => reason.includes(safeKeyword)) ?? reasons[0] ?? null;
};

const toRecordOrEmpty = (value: unknown): Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
};

const readStringField = (record: Readonly<Record<string, unknown>>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const raw = record[key];
    if (raw === null || raw === undefined) {
      continue;
    }
    const text = String(raw).trim();
    if (text.length > 0) {
      return text;
    }
  }
  return null;
};

const authoritativeExposureSources = new Set([
  'tickflow_sw_universe',
  'akshare_industry_board_em',
  'akshare_concept_board_em',
  'akshare_individual_info_em',
  'yahoo_company_profile',
]);

const movementExposureSources = new Set([
  'akshare_stock_changes_em',
  'akshare_board_change_em',
]);

const pickRawField = (rawFields: Readonly<Record<string, unknown>>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const raw = rawFields[key];
    if (raw === null || raw === undefined) {
      continue;
    }
    const value = String(raw).trim();
    if (value.length > 0) {
      return `${key}: ${value}`;
    }
  }
  return null;
};

const buildExposureExternalFact = (row: IDashboardEvidenceDbRow): IDashboardEvidenceChainItem['exposure']['external_fact'] => {
  const evidence = toRecordOrEmpty(row.exposureEvidenceJson);
  const rawFields = toRecordOrEmpty(evidence.rawFields);
  const source = row.exposureSource ?? readStringField(evidence, ['source']);
  const sourceId = row.exposureSourceId ?? readStringField(evidence, ['sourceId']);
  const sourceName = row.exposureSourceName ?? readStringField(evidence, ['sourceName']);
  const provider = readStringField(evidence, ['provider']) ?? source;
  const sourceUrl = readStringField(evidence, ['requestUrl', 'url']);
  const observedAt = readStringField(evidence, ['observedAt']) ?? row.exposureUpdatedAt ?? row.exposureValidFrom;
  const updatedAt = row.exposureUpdatedAt ?? observedAt;
  const rawField = pickRawField(rawFields, [
    '板块名称',
    '行业名称',
    '概念名称',
    '主营业务',
    '经营范围',
    '相关信息',
    '板块具体异动类型列表及出现次数',
    '异动类型',
    '异动原因',
  ]);
  const evidenceText = readStringField(evidence, [
    'confidenceReason',
    'description',
    'newsTitle',
    'sourceName',
  ]) ?? (rawField ?? '未记录外部事实原文');
  const confidence = toNumberOrNull(row.exposureConfidence);
  const common = {
    source,
    source_id: sourceId,
    source_name: sourceName,
    source_provider: provider,
    source_url: sourceUrl,
    observed_at: observedAt,
    updated_at: updatedAt,
    confidence,
    evidence_text: evidenceText,
    raw_field: rawField,
    exposure_type: row.exposureType,
    sourceId,
    sourceName,
    exposureType: row.exposureType,
    rawField,
    updatedAt,
  };

  if (!source) {
    return {
      ...common,
      source: null,
      source_id: null,
      sourceId: null,
      verification_status: 'missing_external_fact',
      verification_label: '缺少外部事实来源',
    };
  }

  if (authoritativeExposureSources.has(source) || movementExposureSources.has(source)) {
    return {
      ...common,
      verification_status: 'verified_external',
      verification_label: movementExposureSources.has(source) ? '异动事实已接入' : '外部事实已核验',
    };
  }

  if (source === 'historical_limitup_news') {
    return {
      ...common,
      verification_status: 'historical_news',
      verification_label: '仅历史新闻支持，缺少行业/概念成份核验',
    };
  }

  return {
    ...common,
    verification_status: 'missing_external_fact',
    verification_label: '未知外部事实来源',
  };
};

const toExposureTypeLabel = (type: string | null): string => {
  switch (type) {
    case 'industry_exposure': return '行业暴露';
    case 'concept_exposure': return '概念暴露';
    case 'company_profile_exposure': return '公司资料';
    case 'movement_evidence': return '异动证据';
    case 'business_exposure': return '业务暴露';
    default: return '暴露事实';
  }
};

const pushDashboardEdge = (
  edges: Map<string, IDashboardNetworkEdge>,
  edge: IDashboardNetworkEdge,
  nodes: Map<string, IDashboardNetworkNode>,
): void => {
  if (!nodes.has(edge.source) || !nodes.has(edge.target)) {
    return;
  }
  const key = `${edge.source}->${edge.target}:${edge.label}`;
  const existing = edges.get(key);
  if (!existing || edge.confidence > existing.confidence) {
    edges.set(key, edge);
  }
};

const findPipelineStepLabel = (stepId: string | null | undefined): string | null => {
  if (!stepId) {
    return null;
  }
  return PIPELINE_STEPS.find(step => step.id === stepId)?.label ?? stepId;
};

const resolveNextDashboardRetryAt = (): string | null => {
  try {
    return getNextScheduledRunBeijing(new Date(), ['graph_score_recommend']).beijingDateTime;
  }
  catch {
    return null;
  }
};

const buildDashboardSla = (
  recommendations: readonly IDashboardRecommendationItem[],
  executionHistory: readonly IDashboardExecutionHistoryItem[],
  executionRows: readonly IDashboardExecutionDbRow[],
  displayDate: string,
): IDashboardSnapshotPayload['sla'] => {
  const deadlineAt = `${displayDate} 17:00`;
  if (recommendations.length > 0) {
    return {
      status: 'ready',
      status_label: '今日推荐已生成',
      failed_node: null,
      failed_node_label: null,
      error_message: null,
      next_retry_at: null,
      deadline_at: deadlineAt,
    };
  }

  const failedRow = executionRows.find(row => row.stepStatus === 'FAILED' || row.status === 'FAILED') ?? null;
  if (failedRow) {
    return {
      status: 'failed',
      status_label: '今日推荐失败',
      failed_node: failedRow.stepName,
      failed_node_label: findPipelineStepLabel(failedRow.stepName),
      error_message: failedRow.stepErrorMessage ?? failedRow.errorMessage ?? '流水线失败，等待重试或人工处理',
      next_retry_at: resolveNextDashboardRetryAt(),
      deadline_at: deadlineAt,
    };
  }

  const latest = executionHistory[0] ?? null;
  if (latest?.status === '执行中' || latest?.status === '排队中') {
    return {
      status: 'running',
      status_label: '今日推荐执行中',
      failed_node: null,
      failed_node_label: null,
      error_message: null,
      next_retry_at: null,
      deadline_at: deadlineAt,
    };
  }

  if (latest) {
    return {
      status: 'waiting',
      status_label: '今日推荐等待结果',
      failed_node: null,
      failed_node_label: null,
      error_message: latest.error_message,
      next_retry_at: resolveNextDashboardRetryAt(),
      deadline_at: deadlineAt,
    };
  }

  return {
    status: 'no_trace',
    status_label: '今日推荐尚未启动',
    failed_node: null,
    failed_node_label: null,
    error_message: '未找到当天 RunTrace 记录',
    next_retry_at: resolveNextDashboardRetryAt(),
    deadline_at: deadlineAt,
  };
};

const compareDashboardRecommendationRows = (
  left: IDashboardRecommendationDbRow,
  right: IDashboardRecommendationDbRow,
  tracePriority: ReadonlyMap<string, number>,
): number => {
  const leftTracePriority = tracePriority.get(left.traceId) ?? Number.MAX_SAFE_INTEGER;
  const rightTracePriority = tracePriority.get(right.traceId) ?? Number.MAX_SAFE_INTEGER;
  if (leftTracePriority !== rightTracePriority) {
    return leftTracePriority - rightTracePriority;
  }

  const leftAsOf = Date.parse(String(left.asOf));
  const rightAsOf = Date.parse(String(right.asOf));
  const leftTime = Number.isFinite(leftAsOf) ? leftAsOf : 0;
  const rightTime = Number.isFinite(rightAsOf) ? rightAsOf : 0;
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }

  const scoreDelta = (toNumberOrNull(right.finalScore) ?? 0) - (toNumberOrNull(left.finalScore) ?? 0);
  if (Math.abs(scoreDelta) > 0.000001) {
    return scoreDelta;
  }

  const rankDelta = Number(left.rank) - Number(right.rank);
  if (rankDelta !== 0) {
    return rankDelta;
  }

  return left.traceId.localeCompare(right.traceId);
};

const dedupeDashboardRecommendationRows = (
  rows: readonly IDashboardRecommendationDbRow[],
  executionRows: readonly IDashboardExecutionDbRow[],
): readonly IDashboardRecommendationDbRow[] => {
  const tracePriority = new Map<string, number>();
  executionRows.forEach((row, index) => {
    if (!tracePriority.has(row.traceId)) {
      tracePriority.set(row.traceId, index);
    }
  });

  const bySymbol = new Map<string, IDashboardRecommendationDbRow>();
  for (const row of rows) {
    const symbolKey = normalizeStockSymbol(row.symbol) ?? String(row.symbol).trim();
    const existing = bySymbol.get(symbolKey);
    if (!existing || compareDashboardRecommendationRows(row, existing, tracePriority) < 0) {
      bySymbol.set(symbolKey, row);
    }
  }

  return [...bySymbol.values()].sort((left, right) => {
    const rankDelta = Number(left.rank) - Number(right.rank);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    const scoreDelta = (toNumberOrNull(right.finalScore) ?? 0) - (toNumberOrNull(left.finalScore) ?? 0);
    if (Math.abs(scoreDelta) > 0.000001) {
      return scoreDelta;
    }
    return String(left.symbol).localeCompare(String(right.symbol));
  });
};

const readStrategyConfigPayload = (payload: Record<string, unknown>, fallback: unknown): unknown => {
  if (hasOwn(payload, 'config_json')) {
    return payload.config_json;
  }
  if (hasOwn(payload, 'configJson')) {
    return payload.configJson;
  }
  return fallback;
};

const mergeStrategyConfigPatch = (base: IStrategyConfig, patch: unknown): unknown => {
  if (patch === undefined) {
    return base;
  }
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch;
  }

  const patchRecord = patch as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    ...base,
    ...patchRecord,
  };

  if (hasOwn(patchRecord, 'weights')) {
    const weights = patchRecord.weights;
    merged.weights = weights && typeof weights === 'object' && !Array.isArray(weights)
      ? { ...base.weights, ...(weights as Record<string, unknown>) }
      : weights;
  }

  return merged;
};

export const toWebBatchStatus = (status: string): BatchStatus => {
  if (status === 'SUCCESS') {
    return 'COMPLETED';
  }
  if (status === 'FAILED') {
    return 'FAILED';
  }
  if (status === 'PENDING') {
    return 'PENDING';
  }
  return 'RUNNING';
};

const toWebNodeStatus = (status: string): IRuntimeNode['status'] => {
  if (status === 'SUCCESS') {
    return 'completed';
  }
  if (status === 'FAILED') {
    return 'failed';
  }
  return 'running';
};

export const resolveBunExecutable = (input: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly execPath?: string;
  readonly existsSync?: (candidate: string) => boolean;
} = {}): string => {
  const env = input.env ?? process.env;
  const execPath = input.execPath ?? process.execPath;
  const existsSync = input.existsSync ?? fs.existsSync;
  const envBun = (env.BUN_EXECUTABLE ?? env.BUN_BIN)?.trim();
  if (envBun) {
    return envBun;
  }

  const executableName = path.basename(execPath).toLowerCase();
  if (executableName === 'bun' || executableName === 'bun.exe') {
    return execPath;
  }

  const home = env.HOME?.trim();
  if (home) {
    const homeBun = path.join(home, '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
    if (existsSync(homeBun)) {
      return homeBun;
    }
  }

  return 'bun';
};

export const resolveDailyRecommendationScript = (rootDir: string): { relativePath: string } | null => {
  const candidates = [
    'dist/scripts/run-daily-recommendation.js',
    'scripts/run-daily-recommendation.ts',
  ] as const;

  for (const relativePath of candidates) {
    if (fs.existsSync(path.join(rootDir, relativePath))) {
      return { relativePath };
    }
  }

  return null;
};

interface IDailyRecommendationSpawnArgsInput {
  readonly scriptPath: string;
  readonly clusterKey: string;
  readonly asOf: string;
  readonly traceId: string;
  readonly env?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;
}

const parseRequiredPositiveIntegerEnv = (
  env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
  name: 'AKTOOLS_BOARD_LIMIT' | 'AKTOOLS_SYMBOL_LIMIT',
): string => {
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/u.test(raw) || Number(raw) <= 0) {
    throw new Error(`${name} must be a positive integer when launching daily recommendation from HTTP runtime`);
  }

  return raw;
};

export const buildDailyRecommendationSpawnArgs = (input: IDailyRecommendationSpawnArgsInput): readonly string[] => {
  const env = input.env ?? process.env;
  const boardLimit = parseRequiredPositiveIntegerEnv(env, 'AKTOOLS_BOARD_LIMIT');
  const symbolLimit = parseRequiredPositiveIntegerEnv(env, 'AKTOOLS_SYMBOL_LIMIT');

  return [
    input.scriptPath,
    '--cluster',
    input.clusterKey,
    '--as-of',
    input.asOf,
    '--trace-id',
    input.traceId,
    '--aktools-board-limit',
    boardLimit,
    '--aktools-symbol-limit',
    symbolLimit,
  ];
};
const buildPendingNodes = (): readonly IRuntimeNode[] => PIPELINE_STEPS.map((step, index) => ({
  node_id: step.id,
  node_label: step.label,
  sequence_no: index + 1,
  status: 'pending',
  total_count: PIPELINE_STEPS.length,
  current_index: index + 1,
  current_label: '',
  has_result: false,
  started_at: null,
  updated_at: null,
  finished_at: null,
}));

export const buildNodesFromDbSteps = (
  rows: readonly IDbStepTraceRow[],
  runStatus?: string,
): readonly IRuntimeNode[] => {
  const failedStep = rows.find(row => row.status === 'FAILED');
  const failedStepIndex = failedStep
    ? PIPELINE_STEPS.findIndex(step => step.id === failedStep.stepName)
    : -1;
  return PIPELINE_STEPS.map((step, index) => {
    const matched = rows.find(row => row.stepName === step.id);
    const inferredStatus = runStatus === 'SUCCESS' || (failedStepIndex >= 0 && index < failedStepIndex)
      ? 'completed'
      : 'pending';
    const status = matched ? toWebNodeStatus(matched.status) : inferredStatus;
    return {
      node_id: step.id,
      node_label: step.label,
      sequence_no: index + 1,
      status,
      total_count: PIPELINE_STEPS.length,
      current_index: index + 1,
      current_label: matched?.errorMessage ?? '',
      has_result: status === 'completed',
      started_at: matched?.startedAt ?? null,
      updated_at: matched?.endedAt ?? matched?.startedAt ?? null,
      finished_at: matched?.endedAt ?? null,
    };
  });
};

export const resolveCurrentStage = (
  runStatus: string,
  nodes: readonly IRuntimeNode[],
): {
  readonly currentStage: string;
  readonly currentStageIndex: number;
  readonly remainingNodeCount: number;
} => {
  if (runStatus === 'SUCCESS') {
    return {
      currentStage: 'completed',
      currentStageIndex: nodes.length,
      remainingNodeCount: 0,
    };
  }
  if (runStatus === 'FAILED') {
    const failed = nodes.find(node => node.status === 'failed');
    return {
      currentStage: failed?.node_id ?? 'failed',
      currentStageIndex: failed ? failed.sequence_no - 1 : 0,
      remainingNodeCount: nodes.filter(node => node.status === 'pending' || node.status === 'running').length,
    };
  }
  const running = nodes.find(node => node.status === 'running');
  if (running) {
    return {
      currentStage: running.node_id,
      currentStageIndex: running.sequence_no - 1,
      remainingNodeCount: nodes.filter(node => node.status !== 'completed' && node.status !== 'failed').length,
    };
  }
  const lastCompleted = [...nodes].reverse().find(node => node.status === 'completed');
  return {
    currentStage: lastCompleted?.node_id ?? 'pending',
    currentStageIndex: lastCompleted?.sequence_no ?? 0,
    remainingNodeCount: nodes.filter(node => node.status !== 'completed' && node.status !== 'failed').length,
  };
};

const dbStepRowsToTraceSteps = (
  traceId: string,
  batchId: string,
  groupId: string,
  rows: readonly IDbStepTraceRow[],
): readonly ITraceStepRecord[] => rows.map((row, index) => {
  const step = PIPELINE_STEPS.find(item => item.id === row.stepName);
  const startedAt = row.startedAt;
  const finishedAt = row.endedAt;
  const durationMs = startedAt && finishedAt
    ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt))
    : 0;
  return {
    id: index + 1,
    trace_id: traceId,
    batch_id: batchId,
    group_id: groupId,
    flow: 'daily_recommendation',
    node_name: row.stepName,
    sequence_no: step ? PIPELINE_STEPS.indexOf(step) + 1 : index + 1,
    status: toWebNodeStatus(row.status),
    error_code: row.status === 'FAILED' ? 'PIPELINE_STEP_FAILED' : null,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Number.isFinite(durationMs) ? durationMs : 0,
    input_snapshot: toRecordOrEmpty(row.inputSummary),
    output_snapshot: row.errorMessage ? { ...toRecordOrEmpty(row.outputSummary), error_message: row.errorMessage } : toRecordOrEmpty(row.outputSummary),
    delta_snapshot: {},
    metrics: {},
    drift_report: {
      layer_level: 0,
      new_entities: [],
      disappeared_entities: [],
      polarity_flips: [],
      relation_shifts: [],
      drift_count: 0,
    },
  };
});

const dbRunTraceToTraceRecord = (
  row: IDbRunTraceRow,
  stepRows: readonly IDbStepTraceRow[],
): ITraceRecord => {
  const status = toWebBatchStatus(row.status);
  const batchId = `batch-${row.traceId}`;
  const groupId = toGroupId(row.clusterKey);
  const stage = resolveCurrentStage(row.status, buildNodesFromDbSteps(stepRows, row.status));
  return {
    trace_id: row.traceId,
    batch_id: batchId,
    group_id: groupId,
    status,
    latest_phase: status === 'COMPLETED' ? 'completed' : stage.currentStage,
    started_at: row.triggeredAt,
    finished_at: row.completedAt,
    budget_usd: 0,
    budget_exceeded: false,
    steps: dbStepRowsToTraceSteps(row.traceId, batchId, groupId, stepRows),
    events: [],
    costs: [],
  };
};

const dbRunTraceToBatchRecord = (
  row: IDbRunTraceRow,
  stepRows: readonly IDbStepTraceRow[],
): IRuntimeBatchRecord => {
  const nodes = buildNodesFromDbSteps(stepRows, row.status);
  const stage = resolveCurrentStage(row.status, nodes);
  const groupId = toGroupId(row.clusterKey);
  const status = toWebBatchStatus(row.status);
  const completedNodeCount = nodes.filter(node => node.status === 'completed').length;
  const progressPercent = status === 'COMPLETED'
    ? 100
    : Math.floor((completedNodeCount / Math.max(1, nodes.length)) * 100);

  return {
    id: `batch-${row.traceId}`,
    group_id: groupId,
    group_version_id: `${groupId}-v1`,
    target_trading_date: row.asOf.slice(0, 10),
    status,
    trace_id: row.traceId,
    run_fingerprint: row.traceId,
    enqueued_at: Math.floor(Date.parse(row.triggeredAt) / 1000) || 0,
    started_at: row.triggeredAt,
    finished_at: row.completedAt,
    graph_done: nodes.some(node => node.node_id === 'graph_snapshot' && node.status === 'completed'),
    chroma_done: false,
    market_cached_done: nodes.some(node => node.node_id === 'scoring_recommendation' && node.status === 'completed'),
    schema_checked_count: 0,
    schema_mismatch_count: 0,
    schema_mismatch_rate: 0,
    promote_blocked_by_quality: false,
    quality_warnings_json: '[]',
    error_code: row.status === 'FAILED' ? 'PIPELINE_FAILED' : null,
    error_message: row.errorMessage ?? null,
    progress_percent: progressPercent,
    current_stage: stage.currentStage,
    current_stage_index: stage.currentStageIndex,
    remaining_node_count: stage.remainingNodeCount,
    nodes,
    created_at: row.completedAt ?? row.triggeredAt,
  };
};

export class RuntimeDataOperations {
  public constructor(private readonly deps: IRuntimeStoreDependencies) {}

  private async getLiveQuoteMap(
    pool: IPgPoolLike,
    clusterKey: string,
    symbols: readonly string[],
  ): Promise<ReadonlyMap<string, ILiveQuotePayload>> {
    const normalizedSymbols = [...new Set(symbols.map(symbol => normalizeStockSymbol(symbol)).filter((symbol): symbol is string => symbol !== null))];
    if (normalizedSymbols.length === 0) {
      return new Map();
    }

    const fallbackRows = await pool.query<ILiveQuoteDbRow>(
      [
        'SELECT DISTINCT ON (s.symbol) s.symbol, c."tradingDay"::text AS "tradingDay",',
        '       c.close::text AS close, c.low::text AS low, c.high::text AS high, c."capturedAt"::text AS "capturedAt"',
        'FROM public."Stock" s',
        'JOIN public."Candle" c ON c."stockId" = s.id',
        'WHERE s."clusterKey" = $1 AND s.symbol = ANY($2::text[])',
        'ORDER BY s.symbol ASC, c."tradingDay" DESC',
      ].join(' '),
      [clusterKey, normalizedSymbols],
    );
    const fallbackBySymbol = new Map<string, ILiveQuotePayload>();
    for (const row of fallbackRows.rows) {
      const symbol = normalizeStockSymbol(row.symbol);
      const price = toPositiveNumberOrNull(row.close);
      if (!symbol || price === null) {
        continue;
      }
      fallbackBySymbol.set(symbol, {
        price,
        day_low: toPositiveNumberOrNull(row.low),
        day_high: toPositiveNumberOrNull(row.high),
        market_time: toNullableIsoText(row.capturedAt ?? row.tradingDay),
        source: 'candle_fallback',
        status: 'FALLBACK',
      });
    }

    let externalQuotes: ReadonlyMap<string, ILiveQuotePayload> = new Map();
    const configuredReader = this.deps.options.liveQuoteReader;
    const defaultReader = !shouldSkipDefaultQuoteReader() ? createDefaultQuoteReader() : null;
    const quoteReader = configuredReader === null ? null : configuredReader ?? defaultReader;
    if (quoteReader) {
      try {
        externalQuotes = await quoteReader.getQuotes(normalizedSymbols);
      }
      catch {
        externalQuotes = new Map();
      }
    }

    const quotes = new Map<string, ILiveQuotePayload>();
    for (const symbol of normalizedSymbols) {
      const external = externalQuotes.get(symbol);
      const fallback = fallbackBySymbol.get(symbol);
      if (external?.price !== null && external?.price !== undefined) {
        quotes.set(symbol, {
          price: external.price,
          day_low: external.day_low ?? fallback?.day_low ?? external.price,
          day_high: external.day_high ?? fallback?.day_high ?? external.price,
          market_time: external.market_time ?? fallback?.market_time ?? null,
          source: external.source,
          status: external.status,
        });
        continue;
      }
      if (fallback) {
        quotes.set(symbol, fallback);
        continue;
      }
      quotes.set(symbol, {
        price: null,
        day_low: null,
        day_high: null,
        market_time: null,
        source: 'unavailable',
        status: 'UNAVAILABLE',
      });
    }
    return quotes;
  }

  private async getDbTraceRecord(traceId: string): Promise<ITraceRecord | null> {
    const pool = this.deps.options.pgPool;
    if (!pool) {
      return null;
    }

    const rows = await pool.query<IDbRunTraceRow>(
      'SELECT "traceId", status, "triggeredAt"::text, "completedAt"::text, "asOf"::text, "clusterKey", "errorMessage" FROM public."RunTrace" WHERE "traceId" = $1 LIMIT 1',
      [traceId],
    );
    const runTrace = rows.rows[0];
    if (!runTrace) {
      return null;
    }

    const stepRows = await pool.query<IDbStepTraceRow>(
      'SELECT "stepName", status, "startedAt"::text, "endedAt"::text, "errorMessage", "inputSummary", "outputSummary" FROM public."PipelineStepTrace" WHERE "traceId" = $1 ORDER BY "startedAt" ASC',
      [runTrace.traceId],
    );
    return dbRunTraceToTraceRecord(runTrace, stepRows.rows);
  }

  public async dispatchDaily(input: IDispatchDailyInput): Promise<{ trace_id: string; celery_task_id: string }> {
    const clusterKey = toClusterKey(input.groupId);
    const suffix = crypto.randomBytes(4).toString('hex');
    const traceId = `trace-${input.groupId}-${input.targetDate}-${suffix}`;
    const asOf = toAsOfIso(input.targetDate);
    const dailyScript = resolveDailyRecommendationScript(this.deps.options.rootDir);
    const canRunDailyScript = Boolean(
      this.deps.options.pgPool
      && dailyScript,
    );

    const now = nowBeijingDateTime();
    const batchId = `batch-${traceId}`;
    const groupVersionId = `${input.groupId}-v1`;
    const nodes = buildPendingNodes();
    await this.deps.runtimeStateStore.update((raw) => {
      const normalized = ensureCluster(raw, input.groupId);
      const batch: IRuntimeBatchRecord = {
        id: batchId,
        group_id: input.groupId,
        group_version_id: normalized.cluster.active_version_id ?? groupVersionId,
        target_trading_date: input.targetDate,
        status: 'PENDING',
        trace_id: traceId,
        run_fingerprint: traceId,
        enqueued_at: toEpochSeconds(now),
        started_at: now,
        finished_at: null,
        graph_done: false,
        chroma_done: false,
        market_cached_done: false,
        schema_checked_count: 0,
        schema_mismatch_count: 0,
        schema_mismatch_rate: 0,
        promote_blocked_by_quality: false,
        quality_warnings_json: '[]',
        error_code: null,
        error_message: null,
        progress_percent: 0,
        current_stage: 'pending',
        current_stage_index: 0,
        remaining_node_count: nodes.length,
        nodes,
        created_at: now,
      };
      const trace: ITraceRecord = {
        trace_id: traceId,
        batch_id: batchId,
        group_id: input.groupId,
        status: 'PENDING',
        latest_phase: 'pending',
        started_at: now,
        finished_at: null,
        budget_usd: 0,
        budget_exceeded: false,
        steps: [],
        events: [],
        costs: [],
      };
      return {
        ...normalized.snapshot,
        clusters: normalized.snapshot.clusters.map(cluster =>
          cluster.id === input.groupId
            ? {
                ...cluster,
                last_batch_status: 'PENDING',
                last_target_trading_date: input.targetDate,
                updated_at: now,
              }
            : cluster,
        ),
        batches: [batch, ...normalized.snapshot.batches].slice(0, 300),
        traces: {
          ...normalized.snapshot.traces,
          [traceId]: trace,
        },
      };
    });

    if (canRunDailyScript) {
      await this.startDailyPipeline(clusterKey, asOf, traceId, input.groupId, dailyScript!.relativePath);
    }
    else {
      const reason = this.deps.options.pgPool
        ? '真实推荐脚本不存在：backend/dist/scripts/run-daily-recommendation.js 或 backend/scripts/run-daily-recommendation.ts'
        : 'DATABASE_URL 未配置或数据库连接不可用，无法启动真实推荐流水线';
      await this.markBatchFailed(input.groupId, traceId, 'DISPATCH_UNAVAILABLE', reason);
    }

    return {
      trace_id: traceId,
      celery_task_id: `celery-${traceId}`,
    };
  }

  private async startDailyPipeline(clusterKey: string, asOf: string, traceId: string, groupId: string, scriptPath: string): Promise<void> {
    const logDir = path.join(this.deps.options.rootDir, 'tmp', 'http-runtime', 'dispatch');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${traceId}.log`);
    const out = fs.openSync(logFile, 'a');
    try {
      const child = spawn(resolveBunExecutable(), buildDailyRecommendationSpawnArgs({
        scriptPath,
        clusterKey,
        asOf,
        traceId,
      }), {
        cwd: this.deps.options.rootDir,
        detached: true,
        stdio: ['ignore', out, out],
      });
      child.on('error', (error) => {
        fs.appendFileSync(logFile, `\n[dispatch spawn error] ${error.message}\n`);
        void this.markBatchFailed(groupId, traceId, 'SPAWN_FAILED', error.message);
      });
      child.on('exit', (code, signal) => {
        if ((code !== null && code !== 0) || signal) {
          fs.appendFileSync(logFile, `\n[dispatch exit] code=${code} signal=${signal ?? ''}\n`);
          void this.markBatchFailedIfNotTerminal(
            groupId,
            traceId,
            signal ? 'PIPELINE_SIGNAL_EXIT' : 'PIPELINE_NONZERO_EXIT',
            `pipeline exited with code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}`,
          );
        }
      });
      child.unref();
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fs.appendFileSync(logFile, `\n[dispatch config error] ${message}\n`);
      await this.markBatchFailed(groupId, traceId, 'DISPATCH_CONFIG_INVALID', message);
    }
    finally {
      fs.closeSync(out);
    }
  }

  private async markBatchFailed(groupId: string, traceId: string, errorCode: string, errorMessage: string): Promise<void> {
    const now = nowBeijingDateTime();
    const failedStatus: BatchStatus = 'FAILED';
    const pool = this.deps.options.pgPool;
    if (pool) {
      try {
        await pool.query(
          [
            'UPDATE public."RunTrace"',
            'SET status = $2,',
            '    "errorMessage" = $3,',
            '    "completedAt" = $4',
            'WHERE "traceId" = $1',
          ].join(' '),
          [traceId, failedStatus, errorMessage, now],
        );
      }
      catch {
        // fall through to in-memory fallback
      }
    }
    await this.deps.runtimeStateStore.update((raw) => {
      const normalized = ensureCluster(raw, groupId);
      return {
        ...normalized.snapshot,
        clusters: normalized.snapshot.clusters.map(cluster =>
          cluster.id === groupId
            ? { ...cluster, last_batch_status: failedStatus, updated_at: now }
            : cluster,
        ),
        batches: normalized.snapshot.batches.map(batch =>
          batch.trace_id === traceId
            ? { ...batch, status: failedStatus, finished_at: now, error_code: errorCode, error_message: errorMessage, current_stage: 'failed' }
            : batch,
        ),
        traces: normalized.snapshot.traces[traceId]
          ? {
              ...normalized.snapshot.traces,
              [traceId]: { ...normalized.snapshot.traces[traceId]!, status: failedStatus, finished_at: now, latest_phase: 'failed' },
            }
          : normalized.snapshot.traces,
      };
    });
  }

  private async markBatchFailedIfNotTerminal(groupId: string, traceId: string, errorCode: string, errorMessage: string): Promise<void> {
    // 如果 DB 中已有该 trace 的终态记录，则不覆盖；否则把内存 batch 标 FAILED。
    const pool = this.deps.options.pgPool;
    if (pool) {
      try {
        const rows = await pool.query<{ status: string }>(
          'SELECT status FROM public."RunTrace" WHERE "traceId" = $1 LIMIT 1',
          [traceId],
        );
        if (rows.rows.length > 0 && (rows.rows[0]!.status === 'SUCCESS' || rows.rows[0]!.status === 'FAILED')) {
          return;
        }
      }
      catch { /* fall through to memory update */ }
    }
    await this.markBatchFailed(groupId, traceId, errorCode, errorMessage);
  }

  public async listBatches(limit: number): Promise<readonly unknown[]> {
    const safeLimit = Math.max(0, Math.floor(limit));
    if (safeLimit === 0) {
      return [];
    }
    const pool = this.deps.options.pgPool;
    if (pool) {
      try {
        const rows = await pool.query<IDbRunTraceRow>(
          [
            'SELECT "traceId", status, "triggeredAt"::text, "completedAt"::text, "asOf"::text, "clusterKey", "errorMessage"',
            'FROM public."RunTrace"',
            'ORDER BY "triggeredAt" DESC',
            'LIMIT $1',
          ].join(' '),
          [safeLimit],
        );
        if (rows.rows.length > 0) {
          const traceIds = rows.rows.map(row => row.traceId);
          const stepRows = await pool.query<IDbStepTraceRow & { readonly traceId: string }>(
            [
              'SELECT "traceId", "stepName", status, "startedAt"::text, "endedAt"::text, "errorMessage", "inputSummary", "outputSummary"',
              'FROM public."PipelineStepTrace"',
              'WHERE "traceId" = ANY($1::text[])',
              'ORDER BY "startedAt" ASC',
            ].join(' '),
            [traceIds],
          );
          const stepsByTrace = new Map<string, IDbStepTraceRow[]>();
          for (const row of stepRows.rows) {
            const current = stepsByTrace.get(row.traceId) ?? [];
            current.push(row);
            stepsByTrace.set(row.traceId, current);
          }
          return rows.rows.map(row => dbRunTraceToBatchRecord(row, stepsByTrace.get(row.traceId) ?? []));
        }
      }
      catch { /* fall through */ }
    }
    return (await this.deps.runtimeStateStore.read()).batches.slice(0, Math.max(0, limit));
  }

  public async getBatchByTraceId(traceId: string): Promise<unknown | null> {
    const pool = this.deps.options.pgPool;
    if (pool) {
      try {
        const rows = await pool.query<IDbRunTraceRow>(
          'SELECT "traceId", status, "triggeredAt"::text, "completedAt"::text, "asOf"::text, "clusterKey", "errorMessage" FROM public."RunTrace" WHERE "traceId" = $1 LIMIT 1',
          [traceId],
        );
        if (rows.rows.length > 0) {
          const r = rows.rows[0]!;
          const stepRows = await pool.query<IDbStepTraceRow>(
            'SELECT "stepName", status, "startedAt"::text, "endedAt"::text, "errorMessage", "inputSummary", "outputSummary" FROM public."PipelineStepTrace" WHERE "traceId" = $1 ORDER BY "startedAt" ASC',
            [r.traceId],
          );
          return dbRunTraceToBatchRecord(r, stepRows.rows);
        }
      }
      catch { /* fall through */ }
    }
    return (await this.deps.runtimeStateStore.read()).batches.find(batch => batch.trace_id === traceId) ?? null;
  }

  public async getLatestBatchByGroup(groupId: string, targetDate?: string | null): Promise<unknown | null> {
    const pool = this.deps.options.pgPool;
    const dateFilter = normalizeDateFilter(targetDate);
    if (pool) {
      try {
        const values = dateFilter ? [toClusterKey(groupId), dateFilter] : [toClusterKey(groupId)];
        const rows = await pool.query<IDbRunTraceRow>(
          [
            'SELECT "traceId", status, "triggeredAt"::text, "completedAt"::text, "asOf"::text, "clusterKey", "errorMessage"',
            'FROM public."RunTrace"',
            'WHERE "clusterKey" = $1',
            dateFilter ? 'AND ("asOf" + interval \'8 hours\')::date = $2::date' : '',
            'ORDER BY "triggeredAt" DESC',
            'LIMIT 1',
          ].filter(Boolean).join(' '),
          values,
        );
        if (rows.rows.length > 0) {
          return this.getBatchByTraceId(rows.rows[0]!.traceId);
        }
      }
      catch { /* fall through */ }
    }
    return (await this.deps.runtimeStateStore.read()).batches.find(batch =>
      batch.group_id === groupId && (!dateFilter || batch.target_trading_date === dateFilter),
    ) ?? null;
  }

  public async getLatestBatchProgress(groupId: string, targetDate?: string | null): Promise<Record<string, unknown> | null> {
    const pool = this.deps.options.pgPool;
    const dateFilter = normalizeDateFilter(targetDate);
    if (pool) {
      try {
        const values = dateFilter ? [toClusterKey(groupId), dateFilter] : [toClusterKey(groupId)];
        const rows = await pool.query<IDbRunTraceRow>(
          [
            'SELECT "traceId", status, "triggeredAt"::text, "completedAt"::text, "asOf"::text, "clusterKey", "errorMessage"',
            'FROM public."RunTrace"',
            'WHERE "clusterKey" = $1',
            dateFilter ? 'AND ("asOf" + interval \'8 hours\')::date = $2::date' : '',
            'ORDER BY "triggeredAt" DESC',
            'LIMIT 1',
          ].filter(Boolean).join(' '),
          values,
        );
        if (rows.rows.length > 0) {
          const batch = await this.getBatchByTraceId(rows.rows[0]!.traceId) as {
            trace_id: string;
            group_id: string;
            target_trading_date: string;
            status: BatchStatus;
            current_stage: string;
            current_stage_index: number;
            remaining_node_count: number;
            nodes: readonly IRuntimeNode[];
          } | null;
          if (!batch) {
            return null;
          }
          return {
            batch_id: `batch-${batch.trace_id}`,
            trace_id: batch.trace_id,
            group_id: batch.group_id,
            target_trading_date: batch.target_trading_date,
            batch_status: batch.status,
            current_stage: batch.current_stage,
            current_stage_index: batch.current_stage_index,
            remaining_node_count: batch.remaining_node_count,
            nodes: batch.nodes,
          };
        }
      }
      catch { /* fall through */ }
    }
    const batch = (await this.deps.runtimeStateStore.read()).batches.find(row =>
      row.group_id === groupId && (!dateFilter || row.target_trading_date === dateFilter),
    );
    if (!batch) {
      return null;
    }
    return {
      batch_id: batch.id,
      trace_id: batch.trace_id,
      group_id: batch.group_id,
      target_trading_date: batch.target_trading_date,
      batch_status: batch.status,
      current_stage: batch.current_stage,
      current_stage_index: batch.current_stage_index,
      remaining_node_count: batch.remaining_node_count,
      nodes: batch.nodes,
    };
  }

  public async getLatestSuccessfulBatchByGroup(groupId: string, targetDate?: string | null): Promise<unknown | null> {
    const pool = this.deps.options.pgPool;
    const dateFilter = normalizeDateFilter(targetDate);
    if (pool) {
      try {
        const effectiveCluster = toClusterKey(groupId);
        const values = dateFilter ? [effectiveCluster, dateFilter] : [effectiveCluster];
        const rows = await pool.query<IDbRunTraceRow>(
          [
            'SELECT "traceId", status, "triggeredAt"::text, "completedAt"::text, "asOf"::text, "clusterKey", "errorMessage"',
            'FROM public."RunTrace"',
            'WHERE "clusterKey" = $1 AND status = \'SUCCESS\'',
            dateFilter ? 'AND ("asOf" + interval \'8 hours\')::date = $2::date' : '',
            'ORDER BY "completedAt" DESC NULLS LAST',
            'LIMIT 1',
          ].filter(Boolean).join(' '),
          values,
        );
        if (rows.rows.length > 0) {
          const r = rows.rows[0]!;
          return {
            id: `batch-${r.traceId}`,
            trace_id: r.traceId,
            group_id: groupId,
            group_version_id: `${groupId}-v1`,
            target_trading_date: r.asOf.slice(0, 10),
            status: toWebBatchStatus(r.status),
            current_stage: 'completed',
            current_stage_index: -1,
            remaining_node_count: 0,
            run_fingerprint: r.traceId,
            created_at: r.completedAt ?? r.triggeredAt,
          };
        }
      }
      catch { /* fall through */ }
    }
    return (await this.deps.runtimeStateStore.read()).batches.find(batch =>
      batch.group_id === groupId && batch.status === 'COMPLETED' && (!dateFilter || batch.target_trading_date === dateFilter),
    ) ?? null;
  }

  public async getBatchNodeResult(
    batchId: string,
    nodeId: string,
    section: string | undefined,
    page: number,
    pageSize: number,
  ): Promise<Record<string, unknown> | null> {
    const snapshot = await this.deps.runtimeStateStore.read();
    const payload = snapshot.node_results[batchId]?.[nodeId];
    if (!payload) {
      return null;
    }
    if (!section) {
      return payload as unknown as Record<string, unknown>;
    }
    const target = payload.sections.find(row => row.key === section);
    if (!target || target.kind !== 'list') {
      return payload as unknown as Record<string, unknown>;
    }
    const safePage = Math.max(1, page);
    const safeSize = Math.max(1, pageSize);
    const start = (safePage - 1) * safeSize;
    const items = target.items.slice(start, start + safeSize);
    return {
      ...payload,
      sections: payload.sections.map(row =>
        row.key === section
          ? {
              ...row,
              page: safePage,
              page_size: safeSize,
              items,
              has_more: start + items.length < target.total_count,
            }
          : row,
      ),
    };
  }

  public async getContributionDetail(traceId: string, symbol: string): Promise<IContributionDetailPayload | null> {
    if (!this.deps.options.contributionReader) {
      return {
        traceId,
        symbol,
        totalContribution: 0,
        rows: [],
      };
    }
    return this.deps.options.contributionReader.getContributionDetail({ traceId, symbol });
  }

  public async listStrategies(groupId: string): Promise<{ items: readonly IStrategyDefinitionRecord[] }> {
    const pool = this.deps.options.pgPool;
    if (!pool) {
      return { items: [] };
    }

    const clusterKey = toClusterKey(groupId);
    const rows = await pool.query<{
      id: string;
      clusterKey: string;
      name: string;
      description: string | null;
      enabled: boolean;
      configJson: unknown;
      createdAt: string;
      updatedAt: string;
      lastRunAt: string | null;
      lastStatus: string | null;
      lastErrorMessage: string | null;
    }>(
      [
        'SELECT sd.id, sd."clusterKey", sd.name, sd.description, sd.enabled, sd."configJson",',
        '       sd."createdAt"::text, sd."updatedAt"::text,',
        '       latest."createdAt"::text AS "lastRunAt", latest.status AS "lastStatus", latest."errorMessage" AS "lastErrorMessage"',
        'FROM "StrategyDefinition" sd',
        'LEFT JOIN LATERAL (',
        '  SELECT sr."createdAt", sr.status, sr."errorMessage"',
        '  FROM "StrategyRun" sr',
        '  WHERE sr."strategyId" = sd.id',
        '  ORDER BY sr."createdAt" DESC',
        '  LIMIT 1',
        ') latest ON TRUE',
        'WHERE sd."clusterKey" = $1 AND sd."deletedAt" IS NULL',
        'ORDER BY sd."createdAt" ASC',
      ].join(' '),
      [clusterKey],
    );

    return {
      items: rows.rows.map(row => ({
        id: row.id,
        cluster_key: row.clusterKey,
        name: row.name,
        description: row.description,
        enabled: row.enabled,
        config_json: normalizeStrategyExperimentConfig(row.configJson) as IStrategyConfig,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        last_run_at: row.lastRunAt,
        last_status: row.lastStatus,
        last_error_message: row.lastErrorMessage,
      })),
    };
  }

  public async createStrategy(groupId: string, payload: Record<string, unknown>): Promise<IStrategyDefinitionRecord> {
    const pool = this.deps.options.pgPool;
    if (!pool) {
      throw new Error('DATABASE_URL 未配置，无法创建策略');
    }

    const clusterKey = toClusterKey(groupId);
    const name = String(payload.name ?? '').trim();
    if (!name) {
      throw new Error('策略名称不能为空');
    }
    const description = payload.description == null ? null : String(payload.description);
    const config = normalizeStrategyExperimentConfig(readStrategyConfigPayload(payload, defaultStrategyExperimentConfig()));
    const id = `strategy_${crypto.randomBytes(10).toString('hex')}`;

    await pool.query(
      [
        'INSERT INTO "StrategyDefinition" (id, "clusterKey", name, description, enabled, "configJson")',
        'VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
      ].join(' '),
      [id, clusterKey, name, description, payload.enabled === undefined ? true : Boolean(payload.enabled), JSON.stringify(config)],
    );

    const strategies = await this.listStrategies(groupId);
    const created = strategies.items.find(item => item.id === id);
    if (!created) {
      throw new Error('策略创建后读取失败');
    }
    return created;
  }

  public async updateStrategy(groupId: string, strategyId: string, payload: Record<string, unknown>): Promise<IStrategyDefinitionRecord> {
    const pool = this.deps.options.pgPool;
    if (!pool) {
      throw new Error('DATABASE_URL 未配置，无法更新策略');
    }

    const clusterKey = toClusterKey(groupId);
    const current = await pool.query<{ configJson: unknown }>(
      'SELECT "configJson" FROM "StrategyDefinition" WHERE id = $1 AND "clusterKey" = $2 AND "deletedAt" IS NULL LIMIT 1',
      [strategyId, clusterKey],
    );
    if (current.rows.length === 0) {
      throw new Error('策略不存在');
    }

    const currentConfig = normalizeStrategyExperimentConfig(current.rows[0]!.configJson) as IStrategyConfig;
    const config = normalizeStrategyExperimentConfig(
      mergeStrategyConfigPatch(currentConfig, readStrategyConfigPayload(payload, undefined)),
    );
    const nextName = payload.name === undefined ? null : String(payload.name ?? '').trim();
    if (payload.name !== undefined && !nextName) {
      throw new Error('策略名称不能为空');
    }

    await pool.query(
      [
        'UPDATE "StrategyDefinition"',
        'SET name = COALESCE($3, name),',
        '    description = CASE WHEN $4::boolean THEN $5 ELSE description END,',
        '    enabled = COALESCE($6, enabled),',
        '    "configJson" = $7::jsonb,',
        '    "updatedAt" = CURRENT_TIMESTAMP',
        'WHERE id = $1 AND "clusterKey" = $2 AND "deletedAt" IS NULL',
      ].join(' '),
      [
        strategyId,
        clusterKey,
        nextName,
        payload.description !== undefined,
        payload.description == null ? null : String(payload.description),
        payload.enabled === undefined ? null : Boolean(payload.enabled),
        JSON.stringify(config),
      ],
    );

    const strategies = await this.listStrategies(groupId);
    const updated = strategies.items.find(item => item.id === strategyId);
    if (!updated) {
      throw new Error('策略更新后读取失败');
    }
    return updated;
  }

  public async copyStrategy(groupId: string, strategyId: string, payload: Record<string, unknown>): Promise<IStrategyDefinitionRecord> {
    const pool = this.deps.options.pgPool;
    if (!pool) {
      throw new Error('DATABASE_URL 未配置，无法复制策略');
    }

    const clusterKey = toClusterKey(groupId);
    const rows = await pool.query<{
      name: string;
      description: string | null;
      enabled: boolean;
      configJson: unknown;
    }>(
      'SELECT name, description, enabled, "configJson" FROM "StrategyDefinition" WHERE id = $1 AND "clusterKey" = $2 AND "deletedAt" IS NULL LIMIT 1',
      [strategyId, clusterKey],
    );
    if (rows.rows.length === 0) {
      throw new Error('策略不存在');
    }

    const source = rows.rows[0]!;
    const names = await pool.query<{ name: string }>(
      'SELECT name FROM "StrategyDefinition" WHERE "clusterKey" = $1 AND "deletedAt" IS NULL',
      [clusterKey],
    );
    const existingNames = new Set(names.rows.map(row => row.name));
    const baseName = String(payload.name ?? `${source.name} 副本`).trim() || `${source.name} 副本`;
    let nextName = baseName;
    let suffix = 2;
    while (existingNames.has(nextName)) {
      nextName = `${baseName} ${suffix}`;
      suffix += 1;
    }
    return this.createStrategy(groupId, {
      name: nextName,
      description: payload.description ?? source.description,
      enabled: payload.enabled ?? source.enabled,
      config_json: source.configJson,
    });
  }

  public async deleteStrategy(groupId: string, strategyId: string): Promise<{ id: string; deleted: boolean }> {
    const pool = this.deps.options.pgPool;
    if (!pool) {
      throw new Error('DATABASE_URL 未配置，无法删除策略');
    }

    const clusterKey = toClusterKey(groupId);
    await pool.query(
      [
        'UPDATE "StrategyDefinition"',
        'SET enabled = false, "deletedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP',
        'WHERE id = $1 AND "clusterKey" = $2 AND "deletedAt" IS NULL',
      ].join(' '),
      [strategyId, clusterKey],
    );
    return { id: strategyId, deleted: true };
  }

  public async getStrategyPerformanceReports(
    groupId: string,
    strategyId?: string | null,
    limit?: number,
  ): Promise<readonly IStrategyPerformanceReportPayload[]> {
    const pool = this.deps.options.pgPool;
    if (!pool) {
      return [];
    }

    const clusterKey = toClusterKey(groupId);
    const safeLimit = limit && Number.isInteger(limit) && limit > 0 ? limit : 50;

    const queryParts = [
      'SELECT id, "strategyId", "strategyNameSnapshot", "clusterKey", "asOf"::text,',
      '       "winRate"::text, "profitRatio"::text, "avgReturnPct"::text, "maxDrawdown"::text,',
      '       "recommendationCount", "createdAt"::text',
      'FROM public."StrategyPerformanceReport"',
      'WHERE "clusterKey" = $1'
    ];
    const values: unknown[] = [clusterKey];

    if (strategyId && strategyId !== 'all') {
      values.push(strategyId);
      queryParts.push(`AND "strategyId" = $${values.length}`);
    }

    queryParts.push('ORDER BY "asOf" DESC, "createdAt" DESC');
    values.push(safeLimit);
    queryParts.push(`LIMIT $${values.length}`);

    const result = await pool.query<{
      id: string;
      strategyId: string;
      strategyNameSnapshot: string;
      clusterKey: string;
      asOf: string;
      winRate: string | null;
      profitRatio: string | null;
      avgReturnPct: string | null;
      maxDrawdown: string | null;
      recommendationCount: number;
      createdAt: string;
    }>(queryParts.join(' '), values);

    return result.rows.map(row => ({
      id: row.id,
      strategy_id: row.strategyId,
      strategy_name_snapshot: row.strategyNameSnapshot,
      cluster_key: row.clusterKey,
      as_of: row.asOf,
      win_rate: toNumberOrNull(row.winRate),
      profit_ratio: toNumberOrNull(row.profitRatio),
      avg_return_pct: toNumberOrNull(row.avgReturnPct),
      max_drawdown: toNumberOrNull(row.maxDrawdown),
      recommendation_count: row.recommendationCount,
      created_at: row.createdAt,
    }));
  }

  public async getStrategyProfits(
    groupId: string,
    asOf: string,
    query?: IStrategyProfitQuery | string | null,
  ): Promise<IStrategyProfitPayload> {
    const pool = this.deps.options.pgPool;
    const clusterKey = toClusterKey(groupId);
    const filters: IStrategyProfitQuery = typeof query === 'string' || query === null
      ? { trace_id: query ?? null }
      : query ?? {};
    const tradeDate = toTradeDate(asOf);
    if (!tradeDate) {
      throw new Error(`Invalid as_of: ${asOf}`);
    }
    const asOfDate = new Date(toAsOfIso(tradeDate));
    if (!pool) {
      return {
        cluster_key: clusterKey,
        as_of: asOfDate.toISOString(),
        rows: [],
        summaries: [],
      };
    }

    const whereClauses = [
      'e."clusterKey" = $1',
      '(e."asOf" + interval \'8 hours\')::date = $2::date',
    ];
    const params: unknown[] = [clusterKey, tradeDate];
    const pushParam = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const normalizedTraceId = filters.trace_id?.trim() || null;
    const normalizedStrategyId = filters.strategy_id?.trim() || null;
    const normalizedSymbolQuery = filters.symbol_query?.trim() || null;
    if (normalizedTraceId) {
      whereClauses.push(`e."traceId" = ${pushParam(normalizedTraceId)}::text`);
    }
    if (normalizedStrategyId && normalizedStrategyId !== 'all') {
      whereClauses.push(`e."strategyId" = ${pushParam(normalizedStrategyId)}::text`);
    }
    if (normalizedSymbolQuery) {
      const symbolPattern = `%${normalizedSymbolQuery.toLowerCase()}%`;
      whereClauses.push(`(lower(e.symbol) LIKE ${pushParam(symbolPattern)}::text OR lower(e."stockName") LIKE $${params.length}::text)`);
    }

    type StrategyProfitDbRow = {
      strategyId: string;
      strategyName: string;
      strategyRunId: string;
      traceId: string;
      executionTime: string | null;
      clusterKey: string;
      asOf: string;
      rank: number;
      symbol: string;
      stockName: string;
      industry: string;
      baseTradingDay: string;
      basePrice: string;
      currentTradingDay: string | null;
      currentPrice: string | null;
      t1TradingDay?: string | null;
      t1Price?: string | null;
      t3TradingDay?: string | null;
      t3Price?: string | null;
      t5TradingDay?: string | null;
      t5Price?: string | null;
      finalScore: string;
      scoreBreakdown: unknown;
      reasons: readonly string[] | null;
    };

    const rowResult = await pool.query<StrategyProfitDbRow>(
      [
        'WITH valuation AS (',
        '  SELECT COALESCE(max(c."tradingDay"), $2::date)::date AS "valuationDay"',
        '  FROM "Candle" c',
        '  JOIN "Stock" sx ON sx.id = c."stockId" AND sx."clusterKey" = $1',
        ')',
        'SELECT e."strategyId", sr."strategyNameSnapshot" AS "strategyName", e."strategyRunId", e."traceId", e."clusterKey",',
        '       COALESCE(sr."completedAt", sr."createdAt")::text AS "executionTime",',
        '       e."asOf"::text, e.rank, e.symbol, e."stockName", e.industry,',
        '       e."finalScore"::text AS "finalScore", e."scoreBreakdown" AS "scoreBreakdown", e.reasons,',
        '       e."baseTradingDay"::text, e."basePrice"::text, latest."tradingDay"::text AS "currentTradingDay",',
        '       latest.close::text AS "currentPrice",',
        '       t1."tradingDay"::text AS "t1TradingDay", t1.close::text AS "t1Price",',
        '       t3."tradingDay"::text AS "t3TradingDay", t3.close::text AS "t3Price",',
        '       t5."tradingDay"::text AS "t5TradingDay", t5.close::text AS "t5Price"',
        'FROM "StrategyRecommendationEvent" e',
        'JOIN "StrategyRun" sr ON sr.id = e."strategyRunId"',
        'LEFT JOIN "Stock" s ON s."clusterKey" = e."clusterKey" AND s.symbol = e.symbol',
        'LEFT JOIN LATERAL (',
        '  SELECT c."tradingDay", c.close',
        '  FROM "Candle" c',
        '  WHERE s.id IS NOT NULL AND c."stockId" = s.id AND c."tradingDay" <= (SELECT "valuationDay" FROM valuation)',
        '  ORDER BY c."tradingDay" DESC',
        '  LIMIT 1',
        ') latest ON TRUE',
        'LEFT JOIN LATERAL (',
        '  SELECT c."tradingDay", c.close',
        '  FROM "Candle" c',
        '  WHERE s.id IS NOT NULL AND c."stockId" = s.id AND c."tradingDay" > e."baseTradingDay" AND c."tradingDay" <= (SELECT "valuationDay" FROM valuation)',
        '  ORDER BY c."tradingDay" ASC',
        '  OFFSET 0 LIMIT 1',
        ') t1 ON TRUE',
        'LEFT JOIN LATERAL (',
        '  SELECT c."tradingDay", c.close',
        '  FROM "Candle" c',
        '  WHERE s.id IS NOT NULL AND c."stockId" = s.id AND c."tradingDay" > e."baseTradingDay" AND c."tradingDay" <= (SELECT "valuationDay" FROM valuation)',
        '  ORDER BY c."tradingDay" ASC',
        '  OFFSET 2 LIMIT 1',
        ') t3 ON TRUE',
        'LEFT JOIN LATERAL (',
        '  SELECT c."tradingDay", c.close',
        '  FROM "Candle" c',
        '  WHERE s.id IS NOT NULL AND c."stockId" = s.id AND c."tradingDay" > e."baseTradingDay" AND c."tradingDay" <= (SELECT "valuationDay" FROM valuation)',
        '  ORDER BY c."tradingDay" ASC',
        '  OFFSET 4 LIMIT 1',
        ') t5 ON TRUE',
        `WHERE ${whereClauses.join(' AND ')}`,
        'ORDER BY e."asOf" DESC, sr."strategyNameSnapshot" ASC, e.rank ASC',
      ].join(' '),
      params,
    );

    const stockNameBySymbol = await resolveChineseStockNameMap(
      pool,
      clusterKey,
      rowResult.rows.map(row => ({ symbol: row.symbol, stockName: row.stockName })),
    );
    const liveQuotes = await this.getLiveQuoteMap(
      pool,
      clusterKey,
      rowResult.rows.map(row => row.symbol),
    );

    const rows = rowResult.rows.map((row) => {
      const basePrice = Number(row.basePrice);
      const liveQuote = liveQuotes.get(row.symbol);
      const liveTradingDay = liveQuote?.market_time ?? row.currentTradingDay;
      const livePrice = liveQuote?.price ?? row.currentPrice;
      const horizons = {
        live: buildProfitHorizon(liveTradingDay, livePrice, basePrice, true, {
          priceSource: liveQuote?.source ?? 'unavailable',
          priceTime: liveQuote?.market_time ?? toNullableIsoText(row.currentTradingDay),
          settlementNote: liveQuote?.status === 'FALLBACK' ? '实时行情读取失败，使用最新 K 线' : null,
        }),
        t1: buildProfitHorizon(row.t1TradingDay, row.t1Price, basePrice, false, {
          priceSource: 'settlement',
          settlementNote: row.t1Price == null ? '等待基准日后第 1 个交易日 K 线入库' : '第 1 个交易日已结算',
        }),
        t3: buildProfitHorizon(row.t3TradingDay, row.t3Price, basePrice, false, {
          priceSource: 'settlement',
          settlementNote: row.t3Price == null ? '等待基准日后第 3 个交易日 K 线入库' : '第 3 个交易日已结算',
        }),
        t5: buildProfitHorizon(row.t5TradingDay, row.t5Price, basePrice, false, {
          priceSource: 'settlement',
          settlementNote: row.t5Price == null ? '等待基准日后第 5 个交易日 K 线入库' : '第 5 个交易日已结算',
        }),
      };
      return {
        strategy_id: row.strategyId,
        strategy_name: row.strategyName,
        strategy_run_id: row.strategyRunId,
        trace_id: row.traceId,
        execution_time: toNullableIsoText(row.executionTime),
        trace_label: buildTraceLabel(row.traceId),
        cluster_key: row.clusterKey,
        as_of: toIsoText(row.asOf),
        rank: Number(row.rank),
        symbol: row.symbol,
        stock_name: stockNameBySymbol.get(row.symbol) ?? row.stockName,
        industry: row.industry,
        final_score: toNumberOrNull(row.finalScore) ?? 0,
        score_breakdown: row.scoreBreakdown && typeof row.scoreBreakdown === 'object' && !Array.isArray(row.scoreBreakdown)
          ? row.scoreBreakdown as Record<string, unknown>
          : {},
        reasons: Array.isArray(row.reasons) ? row.reasons.map(reason => String(reason)) : [],
        base_trading_day: toIsoText(row.baseTradingDay),
        base_price: basePrice,
        current_trading_day: horizons.live.trading_day,
        current_price: horizons.live.price,
        return_pct: horizons.live.return_pct,
        return_status: horizons.live.status,
        recommendation_key: `${row.strategyId}:${row.strategyRunId}:${row.symbol}:${toIsoText(row.asOf)}`,
        horizons,
      };
    });

    const returnStatus = String(filters.return_status ?? '').trim().toLowerCase();
    const filteredRows = returnStatus && returnStatus !== 'all'
      ? rows.filter(row => matchesReturnStatus(row, returnStatus))
      : rows;
    const sortedRows = sortProfitRows(
      filteredRows,
      filters.sort_by ?? 'execution_time',
      filters.sort_order ?? 'desc',
    );

    const byStrategy = new Map<string, typeof sortedRows>();
    for (const row of sortedRows) {
      const list = byStrategy.get(row.strategy_id) ?? [];
      list.push(row);
      byStrategy.set(row.strategy_id, list);
    }

    const summaries = [...byStrategy.entries()].map(([strategyId, items]) => {
      const returns = items.map(item => item.return_pct).filter((value): value is number => value !== null);
      const avg = returns.length === 0
        ? null
        : returns.reduce((sum, value) => sum + value, 0) / returns.length;
      const horizon_summaries = Object.fromEntries(
        PROFIT_HORIZON_KEYS.map(horizon => [horizon, summarizeProfitHorizon(items, horizon)]),
      ) as Record<ProfitHorizonKey, ReturnType<typeof summarizeProfitHorizon>>;
      return {
        strategy_id: strategyId,
        strategy_name: items[0]?.strategy_name ?? strategyId,
        run_count: new Set(items.map(item => item.strategy_run_id)).size,
        recommendation_count: items.length,
        avg_return_pct: avg,
        median_return_pct: median(returns),
        win_rate: returns.length === 0 ? null : returns.filter(value => value > 0).length / returns.length,
        top_return_pct: returns.length === 0 ? null : Math.max(...returns),
        worst_return_pct: returns.length === 0 ? null : Math.min(...returns),
        horizon_summaries,
      };
    }).sort((left, right) => {
      const leftReturn = left.avg_return_pct ?? Number.NEGATIVE_INFINITY;
      const rightReturn = right.avg_return_pct ?? Number.NEGATIVE_INFINITY;
      return rightReturn - leftReturn || left.strategy_name.localeCompare(right.strategy_name);
    });

    return {
      cluster_key: clusterKey,
      as_of: asOfDate.toISOString(),
      rows: sortedRows,
      summaries,
    };
  }

  private async listDbRecommendationDocuments(tradeDate: string, groupId: string): Promise<readonly Record<string, unknown>[]> {
    const snapshot = await this.getDashboardSnapshot(tradeDate, groupId, null);
    if (snapshot.recommendations.length === 0) {
      return [];
    }

    const traceId = snapshot.meta.trace_id || snapshot.recommendations[0]?.trace_id || `trace-${groupId}-db`;
    const batchId = snapshot.meta.batch_id ?? `batch-${traceId}`;
    const createdAt = snapshot.meta.finished_at ?? snapshot.meta.started_at ?? nowBeijingDateTime();
    const items = snapshot.recommendations.map(row => {
      const score = toNumberOrNull(row.total_score) ?? 0;
      const reason = row.reason_detail || row.reason_summary || '命中真实证据链';
      return {
        id: `${batchId}-${row.symbol}`,
        rank: row.rank,
        symbol: row.symbol,
        ticker: row.symbol,
        name: row.stock_name,
        stage: row.stage,
        ml_score: Number(score.toFixed(2)),
        latest_close: row.latest_close ?? 0,
        tech_score: Number((score / 10).toFixed(3)),
        final_score: score,
        reason,
        summary_text: row.reason_summary || reason,
        tech_json: JSON.stringify({
          industry: row.industry,
          reasons: row.reason_detail ? row.reason_detail.split('；') : [],
          score_breakdown: row.score_breakdown,
        }),
      };
    });

    return [
      {
        id: batchId,
        batch_id: batchId,
        group_id: groupId,
        group_version_id: snapshot.group_version_id ?? `${groupId}-v1`,
        trade_date: tradeDate,
        status: 'COMPLETED',
        summary_text: `共 ${items.length} 条推荐，数据库快照生成`,
        created_at: createdAt,
        trace_id: traceId,
        run_fingerprint: snapshot.meta.run_fingerprint ?? traceId,
        items,
      },
    ];
  }

  public async listRecommendations(tradeDate: string, groupId: string): Promise<readonly Record<string, unknown>[]> {
    const dbRecommendations = await this.listDbRecommendationDocuments(tradeDate, groupId);
    if (dbRecommendations.length > 0) {
      return dbRecommendations;
    }

    const batch = (await this.getLatestSuccessfulBatchByGroup(groupId, tradeDate)) as {
      id: string;
      trace_id: string;
      group_version_id: string;
      run_fingerprint: string;
      created_at: string;
    } | null;
    try {
      const artifacts = await this.deps.artifactsLoader.load();
      return buildRecommendationDocuments({
        artifacts,
        tradeDate,
        groupId,
        groupVersionId: batch?.group_version_id ?? `${groupId}-v1`,
        batchId: batch?.id ?? `batch-${groupId}-synthetic`,
        traceId: batch?.trace_id ?? `trace-${groupId}-synthetic`,
        runFingerprint: batch?.run_fingerprint ?? `synthetic:${groupId}:${tradeDate}`,
        createdAt: batch?.created_at ?? nowBeijingDateTime(),
      });
    }
    catch {
      return [];
    }
  }

  public async listNonTradingRecommendations(displayDate: string, groupId: string): Promise<readonly Record<string, unknown>[]> {
    const dbRecommendations = await this.listDbRecommendationDocuments(displayDate, groupId);
    if (dbRecommendations.length > 0) {
      const source = dbRecommendations[0]!;
      return [{
        ...source,
        id: `nontrading-${String(source.id ?? `batch-${groupId}-db`)}`,
        display_date: displayDate,
        target_trade_date: displayDate,
        recommendation_kind: 'NON_TRADING_SPECIAL',
        summary_text: `非交易日兼容推荐 ${Array.isArray(source.items) ? source.items.length : 0} 条`,
      }];
    }

    const batch = (await this.getLatestSuccessfulBatchByGroup(groupId, displayDate)) as {
      id: string;
      trace_id: string;
      group_version_id: string;
      run_fingerprint: string;
      created_at: string;
    } | null;
    try {
      return buildNonTradingRecommendationDocuments({
        artifacts: await this.deps.artifactsLoader.load(),
        displayDate,
        groupId,
        groupVersionId: batch?.group_version_id ?? `${groupId}-v1`,
        batchId: batch?.id ?? `batch-${groupId}-synthetic`,
        traceId: batch?.trace_id ?? `trace-${groupId}-synthetic`,
        runFingerprint: batch?.run_fingerprint ?? `synthetic:${groupId}:${displayDate}`,
        createdAt: batch?.created_at ?? nowBeijingDateTime(),
      });
    }
    catch {
      return [];
    }
  }

  public async getDailyReport(displayDate: string, groupId: string): Promise<Record<string, unknown>> {
    const dbReport = await this.deps.options.dailyReportReader?.getDailyReport({ displayDate, groupId });
    if (dbReport) {
      return dbReport;
    }

    return {
      available: false,
      report_kind: 'EMPTY',
      warnings: ['未找到数据库 RecommendationSnapshot；已禁用旧 artifact 兼容推荐'],
      summary_text: '未找到数据库推荐快照',
      group_id: groupId,
      group_version_id: `${groupId}-db`,
      display_date: displayDate,
      as_of_trade_date: displayDate,
      recommendation_kind: 'TRADING',
      stage_rules_version: 'db-snapshot-v1',
      batch_quality: {
        schema_checked_count: 0,
        schema_mismatch_count: 0,
        schema_mismatch_rate: 0,
        degraded: true,
        promote_blocked_by_quality: false,
      },
      recommendations: {
        A: [],
        B: [],
        C: [],
      },
      meta: {
        batch_id: '',
        trace_id: '',
        run_fingerprint: '',
        created_at: nowBeijingDateTime(),
        status: 'NO_DB_SNAPSHOT',
      },
    };
  }

  public async getDashboardSnapshot(displayDate: string, groupId: string, strategyId?: string | null): Promise<IDashboardSnapshotPayload> {
    const pool = this.deps.options.pgPool;
    if (!pool) {
      return {
        available: false,
        group_id: groupId,
        group_version_id: null,
        display_date: displayDate,
        strategy_id: strategyId?.trim() || null,
        default_symbol: null,
        recommendations: [],
        execution_history: [],
        theme_forecasts: [],
        expectation_gaps: [],
        warnings: ['DATABASE_URL 未配置，无法读取 dashboard 聚合数据'],
        sla: {
          status: 'no_trace',
          status_label: '今日推荐尚未启动',
          failed_node: null,
          failed_node_label: null,
          error_message: 'DATABASE_URL 未配置，无法读取当天推荐流水线状态',
          next_retry_at: resolveNextDashboardRetryAt(),
          deadline_at: `${displayDate} 17:00`,
        },
        quality: {
          recommendation_count: 0,
          effective_evidence_count: 0,
          l1_coverage: 0,
          schema_checked_count: 0,
          schema_mismatch_count: 0,
          schema_mismatch_rate: 0,
          timeliness_status: '缺少数据库',
          execution_time: null,
        },
        meta: {
          trace_id: '',
          batch_id: null,
          run_fingerprint: null,
          current_stage: null,
          status: null,
          started_at: null,
          finished_at: null,
        },
      };
    }

    const clusterKey = toClusterKey(groupId);
    const normalizedStrategyId = strategyId?.trim() || null;
    const recommendationRows = normalizedStrategyId
      ? await pool.query<IDashboardRecommendationDbRow>(
          [
            'SELECT e."traceId", e."asOf"::text AS "asOf", e.rank, e.symbol, e."stockName", e.industry,',
            '       e."finalScore", e.reasons, e."scoreBreakdown",',
            '       COALESCE(ec.evidence_count, 0)::int AS "evidenceCount",',
            '       COALESCE(ec.l1_evidence_count, 0)::int AS "l1EvidenceCount",',
            '       ec.avg_match_confidence AS "avgMatchConfidence",',
            '       ec.total_contribution AS "totalContribution",',
            '       ms."latestTradingDay"::text AS "latestTradingDay",',
            '       c.close AS "latestClose",',
            '       e."strategyId" AS "strategyId"',
            'FROM public."StrategyRecommendationEvent" e',
            'LEFT JOIN LATERAL (',
            '  SELECT count(*)::int AS evidence_count,',
            '         count(*) FILTER (WHERE COALESCE(ec."matchConfidence", 0) >= 0.8)::int AS l1_evidence_count,',
            '         avg(ec."matchConfidence") AS avg_match_confidence,',
            '         sum(ec."finalContribScore") AS total_contribution',
            '  FROM public."EvidenceContribution" ec',
            '  WHERE ec."traceId" = e."traceId" AND ec.symbol = e.symbol',
            ') ec ON true',
            'LEFT JOIN public."MarketSignalSnapshot" ms ON ms."traceId" = e."traceId" AND ms.symbol = e.symbol',
            'LEFT JOIN LATERAL (',
            '  SELECT c.close',
            '  FROM public."Candle" c',
            '  LEFT JOIN public."Stock" s ON s.id = c."stockId"',
            '  WHERE s.symbol = e.symbol AND s."clusterKey" = e."clusterKey"',
            '    AND (ms."latestTradingDay" IS NULL OR c."tradingDay" = ms."latestTradingDay")',
            '  ORDER BY c."tradingDay" DESC',
            '  LIMIT 1',
            ') c ON true',
            'WHERE e."clusterKey" = $1',
            '  AND (e."asOf" + interval \'8 hours\')::date = $2::date',
            '  AND e."strategyId" = $3',
            'ORDER BY e.rank ASC, e.symbol ASC',
          ].join(' '),
          [clusterKey, displayDate, normalizedStrategyId],
        )
      : await pool.query<IDashboardRecommendationDbRow>(
          [
            'SELECT r."traceId", r."asOf"::text AS "asOf", r.rank, r.symbol, r."stockName", r.industry,',
            '       r."finalScore", r.reasons, r."scoreBreakdown",',
            '       COALESCE(ec.evidence_count, 0)::int AS "evidenceCount",',
            '       COALESCE(ec.l1_evidence_count, 0)::int AS "l1EvidenceCount",',
            '       ec.avg_match_confidence AS "avgMatchConfidence",',
            '       ec.total_contribution AS "totalContribution",',
            '       ms."latestTradingDay"::text AS "latestTradingDay",',
            '       c.close AS "latestClose",',
            '       NULL::text AS "strategyId"',
            'FROM public."RecommendationSnapshot" r',
            'LEFT JOIN LATERAL (',
            '  SELECT count(*)::int AS evidence_count,',
            '         count(*) FILTER (WHERE COALESCE(e."matchConfidence", 0) >= 0.8)::int AS l1_evidence_count,',
            '         avg(e."matchConfidence") AS avg_match_confidence,',
            '         sum(e."finalContribScore") AS total_contribution',
            '  FROM public."EvidenceContribution" e',
            '  WHERE e."traceId" = r."traceId" AND e.symbol = r.symbol',
            ') ec ON true',
            'LEFT JOIN public."MarketSignalSnapshot" ms ON ms."traceId" = r."traceId" AND ms.symbol = r.symbol',
            'LEFT JOIN LATERAL (',
            '  SELECT c.close',
            '  FROM public."Candle" c',
            '  LEFT JOIN public."Stock" s ON s.id = c."stockId"',
            '  WHERE s.symbol = r.symbol AND s."clusterKey" = r."clusterKey"',
            '    AND (ms."latestTradingDay" IS NULL OR c."tradingDay" = ms."latestTradingDay")',
            '  ORDER BY c."tradingDay" DESC',
            '  LIMIT 1',
            ') c ON true',
            'WHERE r."clusterKey" = $1',
            '  AND (r."asOf" + interval \'8 hours\')::date = $2::date',
            'ORDER BY r.rank ASC, r.symbol ASC',
          ].join(' '),
          [clusterKey, displayDate],
        );

    const executionRows = await pool.query<IDashboardExecutionDbRow>(
      [
        'SELECT rt."traceId", rt."clusterKey", rt.status, rt."triggeredAt"::text, rt."completedAt"::text, rt."asOf"::text, rt."errorMessage",',
        '       pst."stepName", pst.status AS "stepStatus", pst."errorMessage" AS "stepErrorMessage"',
        'FROM public."RunTrace" rt',
        'LEFT JOIN LATERAL (',
        '  SELECT pst."stepName", pst.status, pst."errorMessage"',
        '  FROM public."PipelineStepTrace" pst',
        '  WHERE pst."traceId" = rt."traceId"',
        '  ORDER BY CASE WHEN pst.status = \'FAILED\' THEN 0 ELSE 1 END, pst."startedAt" DESC',
        '  LIMIT 1',
        ') pst ON true',
        'WHERE rt."clusterKey" = $1',
        '  AND (rt."asOf" + interval \'8 hours\')::date = $2::date',
        'ORDER BY rt."triggeredAt" DESC',
        'LIMIT 20',
      ].join(' '),
      [clusterKey, displayDate],
    );

    const uniqueRecommendationRows = dedupeDashboardRecommendationRows(recommendationRows.rows, executionRows.rows);

    const stockNameBySymbol = await resolveChineseStockNameMap(
      pool,
      clusterKey,
      uniqueRecommendationRows.map(row => ({ symbol: row.symbol, stockName: row.stockName })),
    );

    // 查询每个股票最近 30 期历史胜率（T+1 / T+3）
    const symbolList = uniqueRecommendationRows.map(r => r.symbol);
    const historicalWinRateBySymbol = new Map<string, { t1: number | null; t3: number | null }>();
    if (symbolList.length > 0) {
      const winRateRows = await pool.query<{
        symbol: string;
        t1_wins: string;
        t1_total: string;
        t3_wins: string;
        t3_total: string;
      }>(
        [
          'SELECT r.symbol,',
          '  count(*) FILTER (WHERE (r.\"scoreBreakdown\"->\'yield1Day\')::numeric > 0)::text AS t1_wins,',
          '  count(*)::text AS t1_total,',
          '  count(*) FILTER (WHERE (r.\"scoreBreakdown\"->\'yield3Day\')::numeric > 0)::text AS t3_wins,',
          '  count(*)::text AS t3_total',
          'FROM (',
          '  SELECT r.symbol, r.\"scoreBreakdown\",',
          '         row_number() OVER (PARTITION BY r.symbol ORDER BY r.\"asOf\" DESC) AS rn',
          '  FROM public.\"RecommendationSnapshot\" r',
          `  WHERE r.\"clusterKey\" = $1 AND r.symbol = ANY($2) AND (r.\"asOf\" + interval '8 hours')::date < $3::date`,
          ') r',
          'WHERE r.rn <= 30',
          'GROUP BY r.symbol',
        ].join(' '),
        [clusterKey, symbolList, displayDate],
      );
      for (const row of winRateRows.rows) {
        const t1Total = Number(row.t1_total);
        const t3Total = Number(row.t3_total);
        historicalWinRateBySymbol.set(row.symbol, {
          t1: t1Total === 0 ? null : Number(row.t1_wins) / t1Total,
          t3: t3Total === 0 ? null : Number(row.t3_wins) / t3Total,
        });
      }
    }

    const recommendations: IDashboardRecommendationItem[] = uniqueRecommendationRows.map((row, index, rows) => {
      const finalScore = toNumberOrNull(row.finalScore) ?? 0;
      const totalContribution = toNumberOrNull(row.totalContribution) ?? 0;
      const confidence = clamp01(toNumberOrNull(row.avgMatchConfidence) ?? (finalScore > 1 ? finalScore / 100 : finalScore));
      const breakdown = row.scoreBreakdown ?? {};
      const signalType = String(breakdown.selectionSignalType ?? breakdown.primarySignalType ?? row.industry ?? '').trim() || null;
      const stockName = stockNameBySymbol.get(row.symbol) ?? row.stockName;
      return {
        symbol: row.symbol,
        stock_name: stockName,
        industry: row.industry,
        rank: row.rank,
        stage: stageByIndex(index, rows.length),
        total_score: finalScore,
        confidence,
        evidence_count: Number(row.evidenceCount ?? 0),
        l1_evidence_count: Number(row.l1EvidenceCount ?? 0),
        total_contribution: totalContribution,
        latest_close: toNumberOrNull(row.latestClose),
        latest_trading_day: row.latestTradingDay,
        macro_mainline: signalType,
        reason_summary: row.reasons[0] ?? '命中真实证据链',
        reason_detail: row.reasons.join('；'),
        score_breakdown: breakdown,
        trace_id: row.traceId,
        strategy_id: row.strategyId,
        win_rate_t1: historicalWinRateBySymbol.get(row.symbol)?.t1 ?? null,
        win_rate_t3: historicalWinRateBySymbol.get(row.symbol)?.t3 ?? null,
      };
    });


    const executionHistory: IDashboardExecutionHistoryItem[] = executionRows.rows.map((row) => {
      const batchId = `batch-${row.traceId}`;
      const targetTradingDate = toIsoText(row.asOf).slice(0, 10);
      return {
        trace_id: row.traceId,
        batch_id: batchId,
        started_at: row.triggeredAt,
        finished_at: row.completedAt,
        target_trading_date: targetTradingDate,
        group_id: toGroupId(row.clusterKey),
        strategy_id: null,
        status: toChineseBatchStatus(row.status),
        current_stage: row.stepName ?? '未记录',
        error_code: row.status === 'FAILED' ? 'PIPELINE_FAILED' : null,
        error_message: row.errorMessage,
      };
    });

    const effectiveEvidenceCount = recommendations.reduce((sum, row) => sum + row.evidence_count, 0);
    const l1EvidenceCount = recommendations.reduce((sum, row) => sum + row.l1_evidence_count, 0);
    const coverageBase = effectiveEvidenceCount > 0 ? effectiveEvidenceCount : 1;
    const metaTraceId = recommendations[0]?.trace_id ?? executionHistory[0]?.trace_id ?? '';
    const metaBatch = executionHistory.find(item => item.trace_id === metaTraceId) ?? executionHistory[0] ?? null;
    const sla = buildDashboardSla(recommendations, executionHistory, executionRows.rows, displayDate);

    // 主题预测 + 弱信号/预期差
    const themeForecasts = await this.loadThemeForecasts(metaTraceId, groupId);
    const expectationGaps = await this.loadExpectationGaps(metaTraceId, groupId);

    return {
      available: recommendations.length > 0,
      group_id: groupId,
      group_version_id: `${groupId}-v1`,
      display_date: displayDate,
      strategy_id: normalizedStrategyId,
      default_symbol: recommendations[0]?.symbol ?? null,
      recommendations,
      execution_history: executionHistory,
      theme_forecasts: themeForecasts,
      expectation_gaps: expectationGaps,
      warnings: recommendations.length > 0 ? [] : ['当前日期无 RecommendationSnapshot 数据'],
      sla,
      quality: {
        recommendation_count: recommendations.length,
        effective_evidence_count: effectiveEvidenceCount,
        l1_coverage: l1EvidenceCount / coverageBase,
        schema_checked_count: recommendations.length,
        schema_mismatch_count: 0,
        schema_mismatch_rate: 0,
        timeliness_status: metaBatch?.finished_at ? '已完成' : (executionHistory[0]?.status ?? '无记录'),
        execution_time: metaBatch?.finished_at ?? metaBatch?.started_at ?? null,
      },
      meta: {
        trace_id: metaTraceId,
        batch_id: metaBatch?.batch_id ?? null,
        run_fingerprint: metaTraceId || null,
        current_stage: metaBatch?.current_stage ?? null,
        status: metaBatch?.status ?? null,
        started_at: metaBatch?.started_at ?? null,
        finished_at: metaBatch?.finished_at ?? null,
      },
    };
  }

  private async loadThemeForecasts(traceId: string, groupId: string): Promise<readonly IThemeForecastDisplayItem[]> {
    const pool = this.deps.options.pgPool;
    if (!pool || !traceId) {
      return [];
    }
    const clusterKey = `cluster-${groupId}`;
    try {
      const rows = await pool.query<{
        theme: string; direction: string; probability: string; horizon: number;
        signal_strength: string; expectation_gap: string; related_symbols: string[];
        evidence_chain: { weakSignal?: boolean }; reasons: string[];
      }>(
        `SELECT theme, direction, probability::text, horizon, "signalStrength"::text AS signal_strength,
                "expectationGap"::text AS expectation_gap, "relatedSymbols" AS related_symbols,
                "evidenceChain" AS evidence_chain, reasons
         FROM "ThemeForecast"
         WHERE "traceId" = $1 AND "clusterKey" = $2 AND direction != 'neutral'
         ORDER BY probability DESC LIMIT 10`,
        [traceId, clusterKey],
      );
      return rows.rows.map(row => ({
        theme: row.theme,
        direction: (['bullish', 'bearish', 'neutral'].includes(row.direction) ? row.direction : 'neutral') as IThemeForecastDisplayItem['direction'],
        probability: Number(row.probability),
        horizon: row.horizon,
        signal_strength: Number(row.signal_strength),
        expectation_gap: Number(row.expectation_gap),
        related_symbols: Array.isArray(row.related_symbols) ? row.related_symbols.map(String) : [],
        weak_signal: Boolean(row.evidence_chain?.weakSignal),
        reasons: Array.isArray(row.reasons) ? row.reasons.map(String) : [],
      }));
    } catch {
      return [];
    }
  }

  private async loadExpectationGaps(traceId: string, groupId: string): Promise<readonly IExpectationGapDisplayItem[]> {
    const pool = this.deps.options.pgPool;
    if (!pool || !traceId) {
      return [];
    }
    const clusterKey = `cluster-${groupId}`;
    try {
      const rows = await pool.query<{
        keyword: string; graph_strength: string; price_reaction: string;
        expectation_gap: string; is_weak_signal: boolean; related_symbols: string[]; reasons: string[];
      }>(
        `SELECT keyword, "graphStrength"::text AS graph_strength, "priceReaction"::text AS price_reaction,
                "expectationGap"::text AS expectation_gap, "isWeakSignal" AS is_weak_signal,
                "relatedSymbols" AS related_symbols, reasons
         FROM "ExpectationGapSnapshot"
         WHERE "traceId" = $1 AND "clusterKey" = $2 AND "isWeakSignal" = true
         ORDER BY "expectationGap" DESC LIMIT 10`,
        [traceId, clusterKey],
      );
      return rows.rows.map(row => ({
        keyword: row.keyword,
        graph_strength: Number(row.graph_strength),
        price_reaction: Number(row.price_reaction),
        expectation_gap: Number(row.expectation_gap),
        is_weak_signal: row.is_weak_signal,
        related_symbols: Array.isArray(row.related_symbols) ? row.related_symbols.map(String) : [],
        reasons: Array.isArray(row.reasons) ? row.reasons.map(String) : [],
      }));
    } catch {
      return [];
    }
  }

  public async getDashboardStockDetail(
    symbol: string,
    traceId: string,
    groupId: string,
    strategyId?: string | null,
  ): Promise<IDashboardStockDetailPayload> {
    const pool = this.deps.options.pgPool;
    if (!traceId.trim()) {
      throw new Error('缺少 trace_id，不能无过滤读取股票详情');
    }
    if (!pool) {
      throw new Error('DATABASE_URL 未配置，无法读取股票详情');
    }

    const normalizedStrategyId = strategyId?.trim() || null;
    const recommendationRows = normalizedStrategyId
      ? await pool.query<IDashboardRecommendationDbRow>(
          [
            'SELECT e."traceId", e."asOf"::text AS "asOf", e.rank, e.symbol, e."stockName", e.industry,',
            '       e."finalScore", e.reasons, e."scoreBreakdown",',
            '       COALESCE(ec.evidence_count, 0)::int AS "evidenceCount",',
            '       COALESCE(ec.l1_evidence_count, 0)::int AS "l1EvidenceCount",',
            '       ec.avg_match_confidence AS "avgMatchConfidence",',
            '       ec.total_contribution AS "totalContribution",',
            '       ms."latestTradingDay"::text AS "latestTradingDay",',
            '       c.close AS "latestClose",',
            '       e."strategyId" AS "strategyId"',
            'FROM public."StrategyRecommendationEvent" e',
            'LEFT JOIN LATERAL (',
            '  SELECT count(*)::int AS evidence_count,',
            '         count(*) FILTER (WHERE COALESCE(ec."matchConfidence", 0) >= 0.8)::int AS l1_evidence_count,',
            '         avg(ec."matchConfidence") AS avg_match_confidence,',
            '         sum(ec."finalContribScore") AS total_contribution',
            '  FROM public."EvidenceContribution" ec',
            '  WHERE ec."traceId" = e."traceId" AND ec.symbol = e.symbol',
            ') ec ON true',
            'LEFT JOIN public."MarketSignalSnapshot" ms ON ms."traceId" = e."traceId" AND ms.symbol = e.symbol',
            'LEFT JOIN LATERAL (',
            '  SELECT c.close',
            '  FROM public."Candle" c',
            '  LEFT JOIN public."Stock" s ON s.id = c."stockId"',
            '  WHERE s.symbol = e.symbol AND s."clusterKey" = e."clusterKey"',
            '    AND (ms."latestTradingDay" IS NULL OR c."tradingDay" = ms."latestTradingDay")',
            '  ORDER BY c."tradingDay" DESC',
            '  LIMIT 1',
            ') c ON true',
            'WHERE e."traceId" = $1 AND e.symbol = $2 AND e."clusterKey" = $3 AND e."strategyId" = $4',
            'LIMIT 1',
          ].join(' '),
          [traceId, symbol, toClusterKey(groupId), normalizedStrategyId],
        )
      : await pool.query<IDashboardRecommendationDbRow>(
          [
            'SELECT r."traceId", r."asOf"::text AS "asOf", r.rank, r.symbol, r."stockName", r.industry,',
            '       r."finalScore", r.reasons, r."scoreBreakdown",',
            '       COALESCE(ec.evidence_count, 0)::int AS "evidenceCount",',
            '       COALESCE(ec.l1_evidence_count, 0)::int AS "l1EvidenceCount",',
            '       ec.avg_match_confidence AS "avgMatchConfidence",',
            '       ec.total_contribution AS "totalContribution",',
            '       ms."latestTradingDay"::text AS "latestTradingDay",',
            '       c.close AS "latestClose",',
            '       NULL::text AS "strategyId"',
            'FROM public."RecommendationSnapshot" r',
            'LEFT JOIN LATERAL (',
            '  SELECT count(*)::int AS evidence_count,',
            '         count(*) FILTER (WHERE COALESCE(e."matchConfidence", 0) >= 0.8)::int AS l1_evidence_count,',
            '         avg(e."matchConfidence") AS avg_match_confidence,',
            '         sum(e."finalContribScore") AS total_contribution',
            '  FROM public."EvidenceContribution" e',
            '  WHERE e."traceId" = r."traceId" AND e.symbol = r.symbol',
            ') ec ON true',
            'LEFT JOIN public."MarketSignalSnapshot" ms ON ms."traceId" = r."traceId" AND ms.symbol = r.symbol',
            'LEFT JOIN LATERAL (',
            '  SELECT c.close',
            '  FROM public."Candle" c',
            '  LEFT JOIN public."Stock" s ON s.id = c."stockId"',
            '  WHERE s.symbol = r.symbol AND s."clusterKey" = r."clusterKey"',
            '    AND (ms."latestTradingDay" IS NULL OR c."tradingDay" = ms."latestTradingDay")',
            '  ORDER BY c."tradingDay" DESC',
            '  LIMIT 1',
            ') c ON true',
            'WHERE r."traceId" = $1 AND r.symbol = $2 AND r."clusterKey" = $3',
            'LIMIT 1',
          ].join(' '),
          [traceId, symbol, toClusterKey(groupId)],
        );

    const rawRow = recommendationRows.rows[0];
    if (!rawRow) {
      throw new Error(`未找到股票详情：${symbol}`);
    }
    const stockNameBySymbol = await resolveChineseStockNameMap(
      pool,
      toClusterKey(groupId),
      [{ symbol: rawRow.symbol, stockName: rawRow.stockName }],
    );
    const displayStockName = stockNameBySymbol.get(rawRow.symbol) ?? rawRow.stockName;
    const finalScore = toNumberOrNull(rawRow.finalScore) ?? 0;

    // 查询该股票最近 30 期历史胜率（T+1 / T+3）
    const winRateRows = await pool.query<{
      t1_wins: string;
      t1_total: string;
      t3_wins: string;
      t3_total: string;
    }>(
      [
        'SELECT',
        '  count(*) FILTER (WHERE (r.\"scoreBreakdown\"->\'yield1Day\')::numeric > 0)::text AS t1_wins,',
        '  count(*)::text AS t1_total,',
        '  count(*) FILTER (WHERE (r.\"scoreBreakdown\"->\'yield3Day\')::numeric > 0)::text AS t3_wins,',
        '  count(*)::text AS t3_total',
        'FROM (',
        '  SELECT r.\"scoreBreakdown\",',
        '         row_number() OVER (ORDER BY r.\"asOf\" DESC) AS rn',
        '  FROM public.\"RecommendationSnapshot\" r',
        `  WHERE r.\"clusterKey\" = $1 AND r.symbol = $2 AND r.\"asOf\" < $3::timestamp`,
        ') r',
        'WHERE r.rn <= 30',
      ].join(' '),
      [toClusterKey(groupId), symbol, new Date(rawRow.asOf)],
    );
    const winRow = winRateRows.rows[0];
    const t1Total = winRow ? Number(winRow.t1_total) : 0;
    const t3Total = winRow ? Number(winRow.t3_total) : 0;
    const winRateT1 = t1Total === 0 ? null : Number(winRow.t1_wins) / t1Total;
    const winRateT3 = t3Total === 0 ? null : Number(winRow.t3_wins) / t3Total;

    const row: IDashboardRecommendationItem = {
      symbol: rawRow.symbol,
      stock_name: displayStockName,
      industry: rawRow.industry,
      rank: rawRow.rank,
      stage: stageByIndex(Math.max(0, rawRow.rank - 1), 30),
      total_score: finalScore,
      confidence: clamp01(toNumberOrNull(rawRow.avgMatchConfidence) ?? (finalScore > 1 ? finalScore / 100 : finalScore)),
      evidence_count: Number(rawRow.evidenceCount ?? 0),
      l1_evidence_count: Number(rawRow.l1EvidenceCount ?? 0),
      total_contribution: toNumberOrNull(rawRow.totalContribution) ?? 0,
      latest_close: toNumberOrNull(rawRow.latestClose),
      latest_trading_day: rawRow.latestTradingDay,
      macro_mainline: String(rawRow.scoreBreakdown.selectionSignalType ?? rawRow.scoreBreakdown.primarySignalType ?? rawRow.industry ?? '').trim() || null,
      reason_summary: rawRow.reasons[0] ?? '命中真实证据链',
      reason_detail: rawRow.reasons.join('；'),
      score_breakdown: rawRow.scoreBreakdown,
      trace_id: rawRow.traceId,
      strategy_id: rawRow.strategyId,
      win_rate_t1: winRateT1,
      win_rate_t3: winRateT3,
    };
    const marketSignal = await pool.query<IMarketSignalDbRow>(
      [
        'SELECT "latestTradingDay"::text, "momentum5dPct", "momentum20dPct", "volumeRatio20d",',
        '       "breakout20d", "volatilityCompression", "recentWeekGainExceeded", reasons',
        'FROM public."MarketSignalSnapshot"',
        'WHERE "traceId" = $1 AND symbol = $2',
        'LIMIT 1',
      ].join(' '),
      [traceId, symbol],
    );
    const signal = marketSignal.rows[0];

    const breakdown = row.score_breakdown ?? {};
    const latestClose = row.latest_close;
    const liveQuote = (await this.getLiveQuoteMap(pool, toClusterKey(groupId), [row.symbol])).get(row.symbol) ?? {
      price: null,
      day_low: null,
      day_high: null,
      market_time: null,
      source: 'unavailable',
      status: 'UNAVAILABLE',
    } satisfies ILiveQuotePayload;
    const totalScore = row.total_score;
    const buyLow = latestClose == null ? null : Number((latestClose * 0.97).toFixed(2));
    const buyHigh = latestClose == null ? null : Number((latestClose * 1.01).toFixed(2));
    const stopLoss = latestClose == null ? null : Number((latestClose * 0.91).toFixed(2));
    const targetLow = latestClose == null ? null : Number((latestClose * 1.06).toFixed(2));
    const targetHigh = latestClose == null ? null : Number((latestClose * 1.12).toFixed(2));
    const momentum5d = toNumberOrNull(signal?.momentum5dPct) ?? toNumberOrNull((breakdown.marketSignal as Record<string, unknown> | undefined)?.momentum5dPct);
    const whyNowReady = Boolean(signal?.breakout20d) || ((momentum5d ?? 0) > 0.05 && totalScore >= 70);

    const detail: Omit<IDashboardStockDetailPayload, 'ui_summary'> = {
      symbol: row.symbol,
      stock_name: row.stock_name,
      industry: row.industry,
      rank: row.rank,
      stage: row.stage,
      total_score: row.total_score,
      confidence: row.confidence,
      trace_id: row.trace_id,
      strategy_id: row.strategy_id,
      macro_mainline: row.macro_mainline,
      latest_close: latestClose,
      latest_trading_day: signal?.latestTradingDay ?? row.latest_trading_day,
      live_quote: liveQuote,
      score_breakdown: {
        evidence: toNumberOrNull(breakdown.evidenceScore) ?? 0,
        graph: toNumberOrNull(breakdown.graphScore) ?? 0,
        exposure: toNumberOrNull(breakdown.exposurePrecisionScore) ?? 0,
        market: toNumberOrNull(breakdown.marketSignalScore) ?? 0,
        total_contribution: row.total_contribution,
        evidence_count: row.evidence_count,
        raw: breakdown,
      },
      why_this_stock: {
        short: row.reason_summary,
        detail: row.reason_detail,
      },
      why_now: {
        headline: whyNowReady ? '当前接近触发买入条件' : '当前不构成买入条件',
        bullets: [
          whyNowReady ? '关注放量确认与关键支撑是否成立' : '等待价格回踩不破关键支撑，不追高',
          `5日涨幅 ${momentum5d == null ? '待观察' : `${momentum5d >= 0 ? '+' : ''}${(momentum5d * 100).toFixed(1)}%`}`,
          `市场确认分 ${((toNumberOrNull(breakdown.marketSignalScore) ?? 0)).toFixed(2)}/20`,
        ],
        tone: whyNowReady ? 'ready' : 'watch',
      },
      trade_plan: latestClose == null
        ? null
        : {
            buy_when: whyNowReady ? '放量突破后观察回踩承接，再分批介入' : '只在回踩不破参考买入区间时观察',
            buy_price_ref: latestClose,
            buy_price_range: buyLow == null || buyHigh == null ? null : [buyLow, buyHigh],
            stop_loss_price: stopLoss,
            take_profit_range: targetLow == null || targetHigh == null ? null : [targetLow, targetHigh],
            sell_when: '跌破止损位、核心证据被证伪或市场确认转弱时退出',
          },
      market_confirmation: {
        momentum5d_pct: momentum5d,
        momentum20d_pct: toNumberOrNull(signal?.momentum20dPct),
        volume_ratio20d: toNumberOrNull(signal?.volumeRatio20d),
        breakout20d: Boolean(signal?.breakout20d),
        volatility_compression: Boolean(signal?.volatilityCompression),
        recent_week_gain_exceeded: Boolean(signal?.recentWeekGainExceeded),
        reasons: signal?.reasons ?? [],
      },
      falsification_conditions: [
        '新闻因果信号被证伪',
        '暴露事实不再匹配当前主题',
        '市场确认转弱或跌破风控位',
      ],
      concept_tags: dedupeStrings([row.industry, row.macro_mainline ?? ''].filter(Boolean)),
    };
    const evidence = await this.getDashboardStockEvidence(symbol, traceId, groupId, 8);
    const traceMetaRows = await pool.query<IDashboardTraceMetaDbRow>(
      [
        'SELECT status, "triggeredAt"::text AS "triggeredAt", "completedAt"::text AS "completedAt"',
        'FROM public."RunTrace"',
        'WHERE "traceId" = $1',
        'LIMIT 1',
      ].join(' '),
      [traceId],
    );
    const traceMeta = traceMetaRows.rows[0] ?? null;

    return {
      ...detail,
      ui_summary: buildDashboardUiSummary({
        stock: detail,
        evidenceItems: evidence.items,
        system: {
          data_updated_at: traceMeta?.completedAt ?? traceMeta?.triggeredAt ?? null,
          schema_mismatch_count: 0,
          pipeline_status: traceMeta ? toChineseBatchStatus(traceMeta.status) : null,
        },
      }),
    };
  }

  public async getDashboardStockEvidence(symbol: string, traceId: string, groupId: string, limit?: number): Promise<IDashboardEvidencePayload> {
    const pool = this.deps.options.pgPool;
    if (!pool) {
      return {
        trace_id: traceId,
        group_id: groupId,
        symbol,
        stock_name: null,
        stats: {
          effective_count: 0,
          total_count: 0,
          coverage: 0,
          average_confidence: 0,
          total_contribution: 0,
        },
        items: [],
      };
    }
    const normalizedLimit = limit === undefined ? null : Math.max(1, Math.floor(limit));
    const rows = await pool.query<IDashboardEvidenceDbRow>(
      [
        'SELECT e.id AS "chainId", e."newsId", e.symbol, rs."stockName" AS "stockName", rs.industry,',
        '       e.keyword, e."sourceKeyword", e."matchedExposureKeyword", e."exposureFactId", e."matchMethod", e."matchConfidence",',
        '       e."baseFrequencyScore", e."timeDecayedScore", e."reprintPenaltyScore", e."finalContribScore", e.reasons,',
        '       n.title AS "newsTitle", n.content AS "newsContent", n.source AS "newsSource", n.url AS "newsUrl", n."publishedAt"::text AS "newsPublishedAt",',
        '       sef."exposureType", sef."taxonomyLevel", sef.source AS "exposureSource", sef."sourceId" AS "exposureSourceId",',
        '       sef."sourceName" AS "exposureSourceName", sef."evidenceJson" AS "exposureEvidenceJson", sef.confidence AS "exposureConfidence",',
        '       sef."validFrom"::text AS "exposureValidFrom", sef."updatedAt"::text AS "exposureUpdatedAt"',
        'FROM public."EvidenceContribution" e',
        'LEFT JOIN public."NormalizedNewsRecord" n ON n.id = e."newsId"',
        'LEFT JOIN public."StockExposureFact" sef ON sef.id = e."exposureFactId"',
        'LEFT JOIN public."RecommendationSnapshot" rs ON rs."traceId" = e."traceId" AND rs.symbol = e.symbol',
        'WHERE e."traceId" = $1 AND e.symbol = $2 AND e."clusterKey" = $3',
        'ORDER BY e."finalContribScore" DESC, e."matchConfidence" DESC NULLS LAST, n."publishedAt" DESC NULLS LAST, e."newsId" ASC, e.id ASC',
        normalizedLimit === null ? '' : 'LIMIT $4',
      ].filter(Boolean).join(' '),
      normalizedLimit === null ? [traceId, symbol, toClusterKey(groupId)] : [traceId, symbol, toClusterKey(groupId), normalizedLimit],
    );

    const stockNameBySymbol = await resolveChineseStockNameMap(
      pool,
      toClusterKey(groupId),
      rows.rows.length > 0
        ? rows.rows.map(row => ({ symbol: row.symbol, stockName: row.stockName }))
        : [{ symbol, stockName: null }],
    );

    const items: IDashboardEvidenceChainItem[] = rows.rows.map((row) => {
      const displayStockName = stockNameBySymbol.get(row.symbol) ?? row.stockName ?? row.symbol;
      const exposureKeyword = row.matchedExposureKeyword ?? row.keyword;
      const sourceKeyword = row.sourceKeyword ?? exposureKeyword;
      const externalFact = buildExposureExternalFact(row);
      const exposureTypeLabel = toExposureTypeLabel(row.exposureType);
      const exposureLabel = [
        exposureTypeLabel,
        row.taxonomyLevel,
        row.matchedExposureKeyword ?? row.keyword,
      ].filter(Boolean).join(' / ');
      const signalReason = findReasonByKeyword(row.reasons, sourceKeyword) ?? '由新闻因果信号贡献';
      const exposureReason = [
        findReasonByKeyword(row.reasons, exposureKeyword) ?? `映射到暴露关键词 ${exposureKeyword ?? '未知'}`,
        `暴露类型 ${exposureTypeLabel}`,
        externalFact.source_name ? `来源 ${externalFact.source_name}` : '',
        externalFact.verification_label,
        externalFact.evidence_text,
      ].filter(Boolean).join('；');
      const linkReason = row.exposureFactId
        ? `${externalFact.verification_label}：通过 ${row.exposureType ?? '暴露事实'} ${row.exposureSourceName ?? row.exposureFactId} 命中 ${displayStockName}`
        : `由暴露关键词 ${exposureKeyword ?? '未知'} 关联到 ${row.symbol}`;
      return {
        chain_id: row.chainId,
        news: {
          news_id: row.newsId,
          title: row.newsTitle ?? `新闻 ${row.newsId}`,
          source: row.newsSource ?? '未知来源',
          published_at: row.newsPublishedAt ?? '',
          url: row.newsUrl ?? '',
          excerpt: trimText(row.newsContent ?? row.newsTitle ?? '', 120),
          anchor_quote: trimText(row.newsContent ?? row.newsTitle ?? '', 48),
        },
        signal: {
          source_keyword: row.sourceKeyword,
          asset_or_theme_keyword: row.keyword,
          match_method: row.matchMethod,
          match_confidence: toNumberOrNull(row.matchConfidence),
          signal_reason: signalReason,
        },
        exposure: {
          matched_exposure_keyword: row.matchedExposureKeyword,
          exposure_fact_id: row.exposureFactId,
          exposure_type: row.exposureType,
          exposure_label: exposureLabel,
          exposure_reason: exposureReason,
          external_fact: externalFact,
        },
        stock_link: {
          symbol: row.symbol,
          stock_name: displayStockName,
          link_reason: linkReason,
          industry: row.industry,
          concept_tags: dedupeStrings([
            row.industry ?? '',
            row.taxonomyLevel ?? '',
            row.exposureSourceName ?? '',
          ].filter(Boolean)),
        },
        score: {
          base_frequency_score: toNumberOrNull(row.baseFrequencyScore) ?? 0,
          time_decayed_score: toNumberOrNull(row.timeDecayedScore) ?? 0,
          reprint_penalty_score: toNumberOrNull(row.reprintPenaltyScore) ?? 0,
          final_contrib_score: toNumberOrNull(row.finalContribScore) ?? 0,
        },
      };
    });

    const effectiveCount = items.filter(item => (item.signal.match_confidence ?? 0) >= 0.8).length;
    const totalConfidence = items.reduce((sum, item) => sum + (item.signal.match_confidence ?? 0), 0);
    const totalContribution = items.reduce((sum, item) => sum + item.score.final_contrib_score, 0);

    return {
      trace_id: traceId,
      group_id: groupId,
      symbol,
      stock_name: stockNameBySymbol.get(symbol) ?? rows.rows[0]?.stockName ?? null,
      stats: {
        effective_count: effectiveCount,
        total_count: items.length,
        coverage: items.length === 0 ? 0 : effectiveCount / items.length,
        average_confidence: items.length === 0 ? 0 : totalConfidence / items.length,
        total_contribution: totalContribution,
      },
      items,
    };
  }

  public async getDashboardStockNetwork(symbol: string, traceId: string, groupId: string): Promise<IDashboardNetworkPayload> {
    const evidence = await this.getDashboardStockEvidence(symbol, traceId, groupId);
    const stockName = evidence.stock_name ?? symbol;
    const stockNodeId = `stock:${symbol}`;
    const nodes = new Map<string, IDashboardNetworkNode>();
    const edges = new Map<string, IDashboardNetworkEdge>();
    const relations: Array<{ source: string; relation: string; target: string; strength: number; source_type: '因果链' | '暴露映射' | '全局图谱' }> = [];

    nodes.set(stockNodeId, {
      id: stockNodeId,
      label: stockName,
      kind: 'stock',
      polarity: 'positive',
      weight: 1,
    });

    const rankedItems = evidence.items
      .map(item => ({
        item,
        weight: (item.score.final_contrib_score * 0.7) + ((item.signal.match_confidence ?? 0) * 0.3),
      }))
      .sort((left, right) => right.weight - left.weight)
      .slice(0, 4);

    for (const { item, weight } of rankedItems) {
      const keywordLabel = item.signal.source_keyword ?? item.signal.asset_or_theme_keyword ?? '未知关键词';
      const exposureLabel = item.exposure.exposure_label || '未知暴露';
      const keywordId = `keyword:${keywordLabel}`;
      const exposureId = `exposure:${exposureLabel}`;
      const industryLabel = item.stock_link.industry ?? '未知行业';
      const industryId = `industry:${industryLabel}`;
      const themeId = `theme:${item.signal.asset_or_theme_keyword ?? exposureLabel}`;

      if (!nodes.has(keywordId)) {
        nodes.set(keywordId, {
          id: keywordId,
          label: keywordLabel,
          kind: 'keyword',
          polarity: 'positive',
          weight: clamp01(weight),
        });
      }
      if (!nodes.has(themeId)) {
        nodes.set(themeId, {
          id: themeId,
          label: item.signal.asset_or_theme_keyword ?? exposureLabel,
          kind: 'theme',
          polarity: 'neutral',
          weight: clamp01(weight),
        });
      }
      if (!nodes.has(exposureId)) {
        nodes.set(exposureId, {
          id: exposureId,
          label: exposureLabel,
          kind: 'exposure',
          polarity: 'positive',
          weight: clamp01(weight),
        });
      }
      if (!nodes.has(industryId)) {
        nodes.set(industryId, {
          id: industryId,
          label: industryLabel,
          kind: 'industry',
          polarity: 'neutral',
          weight: clamp01(weight * 0.7),
        });
      }

      pushDashboardEdge(edges, {
        source: themeId,
        target: keywordId,
        label: '信号抽取',
        confidence: clamp01(item.signal.match_confidence ?? 0.6),
        source_type: '因果链',
      }, nodes);
      pushDashboardEdge(edges, {
        source: keywordId,
        target: exposureId,
        label: item.signal.match_method ?? '暴露映射',
        confidence: clamp01(item.signal.match_confidence ?? 0.6),
        source_type: '暴露映射',
      }, nodes);
      pushDashboardEdge(edges, {
        source: exposureId,
        target: stockNodeId,
        label: '命中股票',
        confidence: clamp01(item.score.final_contrib_score),
        source_type: '暴露映射',
      }, nodes);
      pushDashboardEdge(edges, {
        source: industryId,
        target: stockNodeId,
        label: '所属行业',
        confidence: 0.8,
        source_type: '全局图谱',
      }, nodes);

      relations.push(
        {
          source: item.signal.asset_or_theme_keyword ?? keywordLabel,
          relation: '信号抽取',
          target: keywordLabel,
          strength: clamp01(item.signal.match_confidence ?? 0.6),
          source_type: '因果链',
        },
        {
          source: keywordLabel,
          relation: item.signal.match_method ?? '暴露映射',
          target: exposureLabel,
          strength: clamp01(item.signal.match_confidence ?? 0.6),
          source_type: '暴露映射',
        },
        {
          source: exposureLabel,
          relation: '命中股票',
          target: stockName,
          strength: clamp01(item.score.final_contrib_score),
          source_type: '暴露映射',
        },
      );
    }
    const visibleEdges = [...edges.values()]
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, 4);
    const visibleRelations = relations
      .sort((left, right) => right.strength - left.strength)
      .slice(0, 4);
    const firstRelation = visibleRelations[0] ?? null;

    // 关联主题预测：通过 StockExposureFact keyword → ThemeForecast theme 匹配
    const relatedThemeForecasts = await this.loadRelatedThemeForecasts(traceId, groupId, symbol);

    return {
      trace_id: traceId,
      group_id: groupId,
      symbol,
      stock_name: stockName,
      nodes: [...nodes.values()],
      edges: visibleEdges,
      relations: visibleRelations,
      related_theme_forecasts: relatedThemeForecasts,
      network_preview: {
        explanation: firstRelation ? `${firstRelation.source} 通过 ${firstRelation.relation} 连接到 ${firstRelation.target}` : null,
      },
    };
  }

  private async loadRelatedThemeForecasts(traceId: string, groupId: string, symbol: string): Promise<readonly IThemeForecastDisplayItem[]> {
    const pool = this.deps.options.pgPool;
    if (!pool || !traceId || !symbol) {
      return [];
    }
    const clusterKey = `cluster-${groupId}`;
    try {
      const rows = await pool.query<{
        theme: string; direction: string; probability: string; horizon: number;
        signal_strength: string; expectation_gap: string; related_symbols: string[];
        evidence_chain: { weakSignal?: boolean }; reasons: string[];
      }>(
        `SELECT tf.theme, tf.direction, tf.probability::text, tf.horizon,
                tf."signalStrength"::text AS signal_strength, tf."expectationGap"::text AS expectation_gap,
                tf."relatedSymbols" AS related_symbols, tf."evidenceChain" AS evidence_chain, tf.reasons
         FROM "ThemeForecast" tf
         WHERE tf."traceId" = $1 AND tf."clusterKey" = $2
           AND tf.direction != 'neutral'
           AND $3 = ANY(tf."relatedSymbols")
         ORDER BY tf.probability DESC LIMIT 5`,
        [traceId, clusterKey, symbol],
      );
      return rows.rows.map(row => ({
        theme: row.theme,
        direction: (['bullish', 'bearish', 'neutral'].includes(row.direction) ? row.direction : 'neutral') as IThemeForecastDisplayItem['direction'],
        probability: Number(row.probability),
        horizon: row.horizon,
        signal_strength: Number(row.signal_strength),
        expectation_gap: Number(row.expectation_gap),
        related_symbols: Array.isArray(row.related_symbols) ? row.related_symbols.map(String) : [],
        weak_signal: Boolean(row.evidence_chain?.weakSignal),
        reasons: Array.isArray(row.reasons) ? row.reasons.map(String) : [],
      }));
    } catch {
      return [];
    }
  }

  public async getGraph(_cutoffDate: string, _groupId: string, _maxNodes: number): Promise<Record<string, unknown>> {
    return { nodes: [], edges: [] };
  }

  public async getRuntimeGraph(traceId: string, graphKind: GraphKind, maxNodes: number): Promise<Record<string, unknown>> {
    const trace = (await this.deps.runtimeStateStore.read()).traces[traceId];
    if (!trace) {
      return { trace_id: traceId, graph_kind: graphKind, nodes: [], edges: [] };
    }
    return buildRuntimeGraph(trace, graphKind, maxNodes);
  }

  public async getTraceOverview(traceId: string): Promise<Record<string, unknown>> {
    const dbTrace = await this.getDbTraceRecord(traceId);
    if (dbTrace) {
      return buildTraceOverview(dbTrace);
    }

    const trace = (await this.deps.runtimeStateStore.read()).traces[traceId];
    return trace
      ? buildTraceOverview(trace)
      : buildTraceOverview({
          trace_id: traceId,
          batch_id: '',
          group_id: '',
          status: 'PENDING',
          latest_phase: 'planning',
          started_at: null,
          finished_at: null,
          budget_usd: 0,
          budget_exceeded: false,
          steps: [],
          events: [],
          costs: [],
        });
  }

  public async getTraceSteps(traceId: string, cursor: number | undefined, limit: number): Promise<Record<string, unknown>> {
    const dbTrace = await this.getDbTraceRecord(traceId);
    if (dbTrace) {
      const page = paginateRows(dbTrace.steps, cursor, limit);
      return { trace_id: traceId, ...page };
    }

    const trace = (await this.deps.runtimeStateStore.read()).traces[traceId];
    const page = paginateRows(trace?.steps ?? [], cursor, limit);
    return { trace_id: traceId, ...page };
  }

  public async getTraceEvents(traceId: string, cursor: number | undefined, limit: number): Promise<Record<string, unknown>> {
    const trace = (await this.deps.runtimeStateStore.read()).traces[traceId];
    const page = paginateRows(trace?.events ?? [], cursor, limit);
    return { trace_id: traceId, ...page };
  }

  public async getTraceEventsAfter(traceId: string, lastEventId: number): Promise<readonly unknown[]> {
    const trace = (await this.deps.runtimeStateStore.read()).traces[traceId];
    if (!trace) {
      return [];
    }
    return trace.events.filter(row => row.id > lastEventId);
  }

  public async getTraceCosts(traceId: string): Promise<Record<string, unknown>> {
    const trace = (await this.deps.runtimeStateStore.read()).traces[traceId];
    return trace ? buildTraceCosts(trace) : { trace_id: traceId, total_cost_usd: 0, total_tokens: 0, rows: [] };
  }

  public async getMLRecommendations(query: IMLRecommendationQuery): Promise<Record<string, unknown>> {
    return buildMLRecommendations({
      artifacts: await this.deps.artifactsLoader.load(),
      tradeDate: query.tradeDate,
      topN: query.topN,
    });
  }

  public async getRealtimeQuote(ticker: string): Promise<Record<string, unknown>> {
    const pool = this.deps.options.pgPool;
    if (pool) {
      try {
        const rows = await pool.query<{
          close: string | number | null;
          open: string | number | null;
          high: string | number | null;
          low: string | number | null;
          volume: string | number | null;
          prevClose: string | number | null;
          tradingDay: string;
        }>(
          [
            'SELECT c.open::text AS open, c.high::text AS high, c.low::text AS low, c.close::text AS close,',
            '       c.volume::text AS volume, c."tradingDay"::text AS "tradingDay", prev.close::text AS "prevClose"',
            'FROM public."Stock" s',
            'JOIN public."Candle" c ON c."stockId" = s.id',
            'LEFT JOIN LATERAL (',
            '  SELECT p.close',
            '  FROM public."Candle" p',
            '  WHERE p."stockId" = s.id AND p."tradingDay" < c."tradingDay"',
            '  ORDER BY p."tradingDay" DESC',
            '  LIMIT 1',
            ') prev ON true',
            'WHERE s.symbol = $1 AND s."clusterKey" = \'global\'',
            'ORDER BY c."tradingDay" DESC',
            'LIMIT 1',
          ].join(' '),
          [ticker],
        );
        if (rows.rows.length > 0) {
          const row = rows.rows[0]!;
          const price = toNumberOrNull(row.close);
          const preClose = toNumberOrNull(row.prevClose);
          const change = price !== null && preClose !== null ? price - preClose : null;
          return {
            ticker,
            available: price !== null,
            price,
            close: price,
            change,
            change_pct: change !== null && preClose !== null && preClose > 0 ? (change / preClose) * 100 : null,
            volume: toNumberOrNull(row.volume),
            amount: null,
            market_cap: null,
            high: toNumberOrNull(row.high),
            low: toNumberOrNull(row.low),
            open: toNumberOrNull(row.open),
            pre_close: preClose,
            timestamp: row.tradingDay,
            source: 'database',
          };
        }
      }
      catch { /* fall through */ }
    }
    return {
      ticker,
      available: false,
      price: null,
      close: null,
      change: null,
      change_pct: null,
      volume: null,
      amount: null,
      market_cap: null,
      high: null,
      low: null,
      open: null,
      pre_close: null,
      timestamp: null,
      source: 'no-data',
    };
  }

  public async loadArtifactsForTests(): Promise<IBackendArtifacts> {
    return this.deps.artifactsLoader.load();
  }
}
