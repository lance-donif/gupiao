import { describe, expect, it } from 'vitest';
import {
  compactText,
  formatEvidencePath,
  formatExternalFactLabel,
  formatPrice,
  formatQuoteSource,
  formatQuoteTime,
  toFiniteScore,
} from '@/features/dashboard/dashboard-format';
import type { DashboardEvidenceChainItem } from '@/lib/api-types';

function makeChainItem(overrides: Partial<DashboardEvidenceChainItem> = {}): DashboardEvidenceChainItem {
  return {
    chain_id: 'c1',
    event: '白银库存下降',
    ...overrides,
  } as DashboardEvidenceChainItem;
}

describe('compactText', () => {
  it('空值与空白回落为 fallback', () => {
    expect(compactText(undefined)).toBe('--');
    expect(compactText(null)).toBe('--');
    expect(compactText('   ')).toBe('--');
    expect(compactText('  x ', 'fb')).toBe('x');
  });
});

describe('formatPrice', () => {
  it('保留“元”单位并对非法值回落', () => {
    expect(formatPrice(12.3)).toBe('12.30 元');
    expect(formatPrice(null)).toBe('--');
    expect(formatPrice(Number.NaN)).toBe('--');
  });
});

describe('formatQuoteSource', () => {
  it('按数据源给出可读名称，未知源显式提示', () => {
    expect(formatQuoteSource('tickflow')).toBe('TickFlow 行情');
    expect(formatQuoteSource('yahoo_finance')).toBe('Yahoo 行情');
    expect(formatQuoteSource('candle_fallback')).toBe('最新 K 线');
    expect(formatQuoteSource(undefined)).toBe('行情不可用');
  });
});

describe('formatQuoteTime', () => {
  it('无时间时给出显式提示而非空串', () => {
    expect(formatQuoteTime(null)).toBe('时间未知');
    expect(formatQuoteTime('')).toBe('时间未知');
  });
});

describe('formatExternalFactLabel', () => {
  it('组合来源名与暴露类型', () => {
    const item = makeChainItem({
      exposure: {
        exposure_type: 'industry_exposure',
        external_fact: { sourceName: '期货持仓', exposureType: 'industry_exposure' },
      },
    } as unknown as Partial<DashboardEvidenceChainItem>);
    expect(formatExternalFactLabel(item as DashboardEvidenceChainItem)).toBe('期货持仓 · industry_exposure');
  });
});

describe('formatEvidencePath', () => {
  it('缺少信号词时回落为“未知信号”', () => {
    const item = makeChainItem({
      signal: { source_keyword: '', asset_or_theme_keyword: '白银' },
      exposure: { exposure_type: 'x', external_fact: { sourceName: 'S' } },
      stock_link: { stock_name: '测试股份' },
    } as unknown as Partial<DashboardEvidenceChainItem>);
    const path = formatEvidencePath(item as DashboardEvidenceChainItem);
    expect(path).toContain('白银');
    expect(path).toContain('测试股份');
  });
});

describe('toFiniteScore', () => {
  it('只接受有限数字', () => {
    expect(toFiniteScore(42)).toBe(42);
    expect(toFiniteScore(0)).toBe(0);
    expect(toFiniteScore(null)).toBeNull();
    expect(toFiniteScore(Number.NaN)).toBeNull();
    expect(toFiniteScore(Number.POSITIVE_INFINITY)).toBeNull();
  });
});