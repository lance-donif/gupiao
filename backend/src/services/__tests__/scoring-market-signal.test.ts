import { describe, expect, it } from 'vitest';
import { calculateMarketSignalScore } from '../scoring-contribution-engine.js';
import { defaultStrategyExperimentConfig } from '../strategy-experiment-core.js';

interface ITestCandle {
  tradingDay: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// 构造 K 线序列：closes 决定每根收盘价，volumeBase 起始成交量，highOffset/lowOffset 控制 high/low 偏移
const buildCandles = (
  closes: readonly number[],
  options: {
    readonly highOffset?: number;
    readonly lowOffset?: number;
    readonly volumeBase?: number;
    readonly volumes?: readonly number[];
  } = {},
): ITestCandle[] => {
  const highOffset = options.highOffset ?? 0;
  const lowOffset = options.lowOffset ?? 0;
  const volumeBase = options.volumeBase ?? 1_000_000;
  const start = new Date('2026-01-01T00:00:00.000Z');
  return closes.map((close, index) => ({
    tradingDay: new Date(start.getTime() + index * 24 * 60 * 60 * 1000),
    open: close,
    high: close * (1 + highOffset),
    low: close * (1 - lowOffset),
    close,
    volume: options.volumes?.[index] ?? volumeBase + index * 1_000,
  }));
};

describe('calculateMarketSignalScore - 庄家低位吸筹验证', () => {
  it('场景1：低位放量吸筹得高分（庄家吸筹验证 S_m5=1.0）', () => {
    // 前 20 根 close=10，第 21-24 根 close=9.2，第 25 根 close=9.0 且放量
    // avgClose20 = 10，latestClose=9.0 < 10*0.95=9.5 → 低位区
    // avgVolume20 = 1000000，latestVolume=2000000 → 量比=2.0 > 1.2 → 吸筹信号
    // momentum5dPct = (9-10)/10 = -0.1，不 > 0.1，走吸筹分支 → S_m5=1.0
    // momentum20dPct = -0.1 < -0.05 且低位区 → S_m20=0.9
    const closes = [
      ...Array.from({ length: 20 }, () => 10),
      ...Array.from({ length: 4 }, () => 9.2),
      9.0,
    ];
    const volumes = [
      ...Array.from({ length: 24 }, () => 1_000_000),
      2_000_000,
    ];
    const candles = buildCandles(closes, { volumes, highOffset: 0, lowOffset: 0 });

    const result = calculateMarketSignalScore(candles, defaultStrategyExperimentConfig());

    // 低位放量吸筹应得高分
    expect(result.score).toBeGreaterThan(10);
    // reasons 应明确标注低位区与吸筹信号
    expect(result.reasons.some(r => r.includes('低位区: 是'))).toBe(true);
    expect(result.reasons.some(r => r.includes('吸筹信号: 是'))).toBe(true);
    expect(result.reasons.some(r => r.includes('庄家吸筹验证'))).toBe(true);
  });

  it('场景2：追涨股（5日涨超10%）得低分并触发追涨降权', () => {
    // 前 20 根 close=10，第 21-25 根持续上涨到 11.9
    // momentum5dPct = (11.9-10)/10 = 0.19 > 0.1 → S_m5=0.2 追涨降权
    // momentum20dPct = 0.19 > 0.15 → S_m20=0.3
    // latestClose=11.9 > 10*0.95=9.5 → 非低位区，非吸筹
    const closes = [
      ...Array.from({ length: 20 }, () => 10),
      10.3, 10.7, 11.1, 11.5, 11.9,
    ];
    const candles = buildCandles(closes, { highOffset: 0, lowOffset: 0 });

    const result = calculateMarketSignalScore(candles, defaultStrategyExperimentConfig());

    // 追涨股得分应显著受限（远低于场景1的 10+）
    expect(result.score).toBeLessThan(8);
    // reasons 应含追涨降权字样
    expect(result.reasons.some(r => r.includes('追涨降权'))).toBe(true);
    // 非低位区，吸筹信号为否
    expect(result.reasons.some(r => r.includes('低位区: 否'))).toBe(true);
    expect(result.reasons.some(r => r.includes('吸筹信号: 否'))).toBe(true);
  });

  it('场景3：candles 少于 6 条直接记 0 分', () => {
    const candles = buildCandles([10, 10, 10, 10, 10]);

    const result = calculateMarketSignalScore(candles, defaultStrategyExperimentConfig());

    expect(result.score).toBe(0);
    expect(result.reasons[0]).toContain('少于 6 条');
  });
});
