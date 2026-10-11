/**
 * Dashboard 展示层格式化工具。
 *
 * 从 pages/Dashboard.tsx 原样抽出：均为纯函数、不依赖 React 与页面状态，
 * 可独立测试复用。行为与抽取前逐字一致，改动需同步回归测试。
 */
import type { DashboardEvidenceChainItem, DashboardStockDetailPayload } from '@/lib/api-types';
import { formatMinute, formatScore } from '@/lib/format';

export function compactText(value: string | null | undefined, fallback = '--') {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : fallback;
}

export function formatPrice(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)} 元` : '--';
}

export function formatQuoteTime(value: string | null | undefined): string {
  if (!value) {
    return '时间未知';
  }
  return formatMinute(value);
}

export function formatQuoteSource(
  source: DashboardStockDetailPayload['live_quote']['source'] | undefined,
): string {
  if (source === 'tickflow') {
    return 'TickFlow 行情';
  }
  if (source === 'yahoo_finance') {
    return 'Yahoo 行情';
  }
  if (source === 'candle_fallback') {
    return '最新 K 线';
  }
  return '行情不可用';
}

export function formatExternalFactLabel(item: DashboardEvidenceChainItem) {
  const fact = item.exposure.external_fact;
  const sourceName = compactText(fact.sourceName ?? fact.source_name ?? fact.source, '外部事实');
  const exposureType = compactText(
    fact.exposureType ?? fact.exposure_type ?? item.exposure.exposure_type,
    '暴露',
  );
  return `${sourceName} · ${exposureType}`;
}

export function formatExternalFactMeta(item: DashboardEvidenceChainItem) {
  const fact = item.exposure.external_fact;
  const fields = [
    `source=${compactText(fact.source)}`,
    `sourceId=${compactText(fact.sourceId ?? fact.source_id)}`,
    `sourceName=${compactText(fact.sourceName ?? fact.source_name)}`,
    `exposureType=${compactText(fact.exposureType ?? fact.exposure_type ?? item.exposure.exposure_type)}`,
    `rawField=${compactText(fact.rawField ?? fact.raw_field)}`,
    `updatedAt=${compactText(fact.updatedAt ?? fact.updated_at ?? fact.observed_at)}`,
    `confidence=${formatScore(fact.confidence, 2)}`,
  ];
  return fields.join(' · ');
}

export function formatEvidencePath(item: DashboardEvidenceChainItem) {
  const signal = item.signal.source_keyword || item.signal.asset_or_theme_keyword || '未知信号';
  return `${signal} → ${formatExternalFactLabel(item)} → ${item.stock_link.stock_name}`;
}

export function toFiniteScore(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}