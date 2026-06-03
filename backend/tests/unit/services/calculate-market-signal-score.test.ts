import { describe, expect, it } from 'vitest';
import { calculateMarketSignalScore } from '../../../src/services/scoring-contribution-engine.js';
import { defaultStrategyExperimentConfig } from '../../../src/services/strategy-experiment-core.js';

interface ITestCandle {
  tradingDay: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const buildCandles = (
  closes: readonly number[],
  options: { readonly highOffset?: number; readonly lowOffset?: number; readonly volumeBase?: number } = {},
): ITestCandle[] => {
  const highOffset = options.highOffset ?? 0.02;
  const lowOffset = options.lowOffset ?? 0.02;
  const volumeBase = options.volumeBase ?? 1_000_000;
  const start = new Date('2026-01-01T00:00:00.000Z');
  return closes.map((close, index) => ({
    tradingDay: new Date(start.getTime() + index * 24 * 60 * 60 * 1000),
    open: close * (1 - 0.005),
    high: close * (1 + highOffset),
    low: close * (1 - lowOffset),
    close,
    volume: volumeBase + index * 1_000,
  }));
};

const buildAscendingCandles = (
  startClose: number,
  endClose: number,
  count: number,
): ITestCandle[] => {
  const closes: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const progress = i / Math.max(1, count - 1);
    closes.push(Number((startClose + (endClose - startClose) * progress).toFixed(2)));
  }
  return buildCandles(closes, { volumeBase: 1_000_000, highOffset: 0.02, lowOffset: 0.02 });
};

describe('calculateMarketSignalScore - 斐波那契与支撑阻力', () => {
  it('reverts less than 6 candles to 0 score and records a clear reason', () => {
    const result = calculateMarketSignalScore(
      buildCandles([10, 10, 10, 10, 10]),
      defaultStrategyExperimentConfig(),
    );

    expect(result.score).toBe(0);
    expect(result.momentum5dPct).toBeNull();
    expect(result.reasons[0]).toContain('asOf 前可见 Candle 少于 6 条');
  });

  it('在 61.8% 斐波那契水平命中并把 fibonacci 组件计入打分', () => {
    // 60 日窗口：最高 20，最低 10，差 10。当前收盘 13.82 -> 接近 (20 - 0.618 * 10) = 13.82
    const closes = [
      ...Array.from({ length: 30 }, (_, i) => 10 + i * (10 / 30)),
      ...Array.from({ length: 30 }, (_, i) => 20 - i * (10 / 30)),
    ];
    // 最后一根价格收到 13.82
    const candles = buildCandles([...closes, 13.82]);
    const config = { ...defaultStrategyExperimentConfig(), fibonacciLookbackDays: 60, fibonacciThresholdPct: 0.02 };

    const result = calculateMarketSignalScore(candles, config);

    expect(result.score).toBeGreaterThan(0);
    expect(result.reasons.some(reason => reason.includes('61.8%') || reason.includes('50%') || reason.includes('38.2%'))).toBe(true);
    expect(result.reasons.some(reason => reason.includes('斐波那契回调'))).toBe(true);
  });

  it('未命中斐波那契水平时 reasons 明确说明未命中', () => {
    // 60 日窗口：10 -> 20 -> 10。差 10。当前价 19.5，离 38.2% (16.18) 很远
    const candles = buildCandles(
      [
        ...Array.from({ length: 30 }, (_, i) => 10 + i * (10 / 30)),
        ...Array.from({ length: 30 }, (_, i) => 20 - i * (10 / 30)),
        19.5,
      ],
    );
    const config = { ...defaultStrategyExperimentConfig(), fibonacciLookbackDays: 60, fibonacciThresholdPct: 0.005 };

    const result = calculateMarketSignalScore(candles, config);

    expect(result.reasons.some(reason => reason.includes('斐波那契回调未命中'))).toBe(true);
  });

  it('在窗口最低点附近识别为支撑触碰', () => {
    // 60 日窗口：20 跌到 8 再涨到 10。直接构造 explicit low=8 出现在 30 位置
    // 最后一根 close=8.05。low_offset=0 让 srLow=8 严格成为最低点
    const start = new Date('2026-01-01T00:00:00.000Z');
    const candles: ITestCandle[] = [];
    for (let i = 0; i < 61; i += 1) {
      const close = i < 30 ? 20 - i * (12 / 30) : 8 + (i - 30) * (2 / 30);
      const finalClose = i === 60 ? 8.05 : close;
      candles.push({
        tradingDay: new Date(start.getTime() + i * 24 * 60 * 60 * 1000),
        open: finalClose,
        high: finalClose,
        low: i === 30 ? 8 : finalClose,
        close: finalClose,
        volume: 1_000_000,
      });
    }
    const config = { ...defaultStrategyExperimentConfig(), supportResistanceLookbackDays: 60, supportResistanceThresholdPct: 0.015 };

    const result = calculateMarketSignalScore(candles, config);

    expect(result.reasons.some(reason => reason.includes('支撑压力位 [support]'))).toBe(true);
  });

  it('在窗口最高点附近识别为阻力触碰', () => {
    // 60 日窗口最高点出现在 i=30，close=20。最后一根 close=20.20 (差 1.0% < 1.5%)
    const start = new Date('2026-01-01T00:00:00.000Z');
    const candles: ITestCandle[] = [];
    for (let i = 0; i < 61; i += 1) {
      const close = i < 30 ? 10 + i * (10 / 30) : 20 - (i - 30) * (10 / 30);
      const finalClose = i === 60 ? 20.2 : close;
      candles.push({
        tradingDay: new Date(start.getTime() + i * 24 * 60 * 60 * 1000),
        open: finalClose,
        high: i === 30 ? 20 : finalClose,
        low: finalClose,
        close: finalClose,
        volume: 1_000_000,
      });
    }
    const config = { ...defaultStrategyExperimentConfig(), supportResistanceLookbackDays: 60, supportResistanceThresholdPct: 0.015 };

    const result = calculateMarketSignalScore(candles, config);

    expect(result.reasons.some(reason => reason.includes('支撑压力位 [resistance]'))).toBe(true);
  });

  it('价格远高于最高点或远低于最低点时不会误判支撑阻力', () => {
    // 60 日窗口 10~20，当前价 25.0 (在窗口外)
    const candles = buildCandles(
      [
        ...Array.from({ length: 30 }, (_, i) => 10 + i * (10 / 30)),
        ...Array.from({ length: 30 }, (_, i) => 20 - i * (10 / 30)),
        25,
      ],
    );
    const config = { ...defaultStrategyExperimentConfig(), supportResistanceLookbackDays: 60, supportResistanceThresholdPct: 0.015 };

    const result = calculateMarketSignalScore(candles, config);

    expect(result.reasons.some(reason => reason.includes('支撑压力未触碰'))).toBe(true);
  });

  it('marketWeights 提升 fibonacci 权重时命中水平时总分应明显提高', () => {
    // 制造一组 fibonacci 命中的 candles：61.8% 水平
    const closes = [
      ...Array.from({ length: 30 }, (_, i) => 10 + i * (10 / 30)),
      ...Array.from({ length: 30 }, (_, i) => 20 - i * (10 / 30)),
      13.82, // = 20 - 0.618 * 10
    ];
    const candles = buildCandles(closes);
    const baseConfig = { ...defaultStrategyExperimentConfig(), fibonacciLookbackDays: 60, fibonacciThresholdPct: 0.02 };

    const lowFibConfig = { ...baseConfig, marketWeights: { ...baseConfig.marketWeights, fibonacci: 0 } };
    const highFibConfig = { ...baseConfig, marketWeights: { ...baseConfig.marketWeights, fibonacci: 10 } };

    const lowFibScore = calculateMarketSignalScore(candles, lowFibConfig);
    const highFibScore = calculateMarketSignalScore(candles, highFibConfig);

    expect(highFibScore.score).toBeGreaterThan(lowFibScore.score);
  });

  it('marketWeights 总和为 0 时得 0 分', () => {
    const candles = buildCandles(
      [
        ...Array.from({ length: 30 }, (_, i) => 10 + i * (10 / 30)),
        ...Array.from({ length: 30 }, (_, i) => 20 - i * (10 / 30)),
        13.82,
      ],
    );
    const zeroConfig = {
      ...defaultStrategyExperimentConfig(),
      fibonacciLookbackDays: 60,
      marketWeights: {
        momentum5d: 0,
        momentum20d: 0,
        volumeRatio: 0,
        breakout: 0,
        compression: 0,
        fibonacci: 0,
        supportResistance: 0,
      },
    };

    const result = calculateMarketSignalScore(candles, zeroConfig);

    expect(result.score).toBe(0);
  });

  it('窗口内不足 6 根 K 线时返回 0 分', () => {
    // 5 根：直接走 < 6 的早返回
    const candles = buildAscendingCandles(10, 11, 5);
    const config = defaultStrategyExperimentConfig();

    const result = calculateMarketSignalScore(candles, config);

    expect(result.score).toBe(0);
    expect(result.reasons[0]).toContain('少于 6 条');
  });

  it('7 根 K 线时基础动量分会被计算，但 fibonacci/supportResistance 因 <10 根不命中（贡献为 0）', () => {
    // 7 根：动量计算运行（>= 6），但 fib/sr 需 >= 10 根
    // 用同样的总权重，比较 fibonacci 权重变化对分数的影响
    const candles: ITestCandle[] = [];
    const start = new Date('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 7; i += 1) {
      const close = 10 + i * 0.5;
      candles.push({
        tradingDay: new Date(start.getTime() + i * 24 * 60 * 60 * 1000),
        open: close,
        high: close,
        low: close,
        close,
        volume: 1_000_000 + i * 1_000,
      });
    }

    const baseline = calculateMarketSignalScore(candles, defaultStrategyExperimentConfig());
    const withFib = calculateMarketSignalScore(candles, {
      ...defaultStrategyExperimentConfig(),
      marketWeights: {
        momentum5d: 6,
        momentum20d: 5,
        volumeRatio: 4,
        breakout: 3,
        compression: 2,
        fibonacci: 20,
        supportResistance: 0,
      },
    });

    // 把 fibonacci 权重从 0 拉到 20 但不增加其他权重，总权重从 20 变成 40
    // 但 S_fib=0，所以 withFib.score 应当等于 baseline.score * (20/40) = baseline.score * 0.5
    expect(baseline.score).toBeGreaterThan(0);
    expect(withFib.score).toBeCloseTo(baseline.score * 0.5, 4);
  });

  it('reasons 包含 strict 边界说明 (tradingDay <= asOf)', () => {
    const candles = buildAscendingCandles(10, 11, 25);
    const result = calculateMarketSignalScore(candles, defaultStrategyExperimentConfig());

    expect(result.reasons.some(reason => reason.includes('tradingDay <= asOf'))).toBe(true);
    expect(result.latestTradingDay).not.toBeNull();
  });
});
