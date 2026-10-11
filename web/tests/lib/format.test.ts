import { describe, expect, it } from 'vitest';
import { changeToneClass, formatPercent, formatScore } from '@/lib/format';

describe('changeToneClass（A 股约定：红涨绿跌）', () => {
  it('上涨用 stock-up（红），下跌用 stock-down（绿）', () => {
    expect(changeToneClass(0.0123)).toBe('stock-up');
    expect(changeToneClass(0)).toBe('stock-up');
    expect(changeToneClass(-0.0123)).toBe('stock-down');
  });

  it('空值与非法值回落为中性色，绝不误判方向', () => {
    expect(changeToneClass(null)).toBe('text-muted-foreground');
    expect(changeToneClass(undefined)).toBe('text-muted-foreground');
    expect(changeToneClass(Number.NaN)).toBe('text-muted-foreground');
  });

  it('支持自定义中性色', () => {
    expect(changeToneClass(null, 'text-gray-400')).toBe('text-gray-400');
  });
});

describe('格式化函数单一实现', () => {
  it('formatPercent 对齐符号并处理空值', () => {
    expect(formatPercent(0.0512, 2)).toBe('+5.12%');
    expect(formatPercent(-0.0512, 2)).toBe('-5.12%');
    expect(formatPercent(null)).toBe('--');
    expect(formatPercent(Number.NaN)).toBe('--');
  });

  it('formatScore 不加正号', () => {
    expect(formatScore(72.4, 1)).toBe('72.4');
    expect(formatScore(72.55, 2)).toBe('72.55');
    expect(formatScore(null)).toBe('--');
  });
});