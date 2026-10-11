/**
 * 市场确认信号评分（单一真源）。
 *
 * SRP：原实现内嵌在 scoring-contribution-engine.ts（1900+ 行）中，
 * 现独立成模块，供评分引擎与 strategy-runner 共用；消除 strategy-runner
 * 对整个评分引擎模块的依赖。
 *
 * 输入为按 tradingDay 升序排列前的任意顺序 Candle 列表（函数内部自行排序），
 * 输出 0-20 分市场确认信号及可追溯的 reasons 文案；文案即契约，不得随意改动。
 */

import type { IStrategyExperimentConfig } from '../strategy-experiment-core.js';
import { clamp, toNumber } from '../../lib/number-utils.js';
import { computeMomentumPct } from '../scoring-utils.js';

export interface IMarketSignalScore {
  readonly score: number;
  readonly latestTradingDay: string | null;
  readonly latestTradingDayDate?: Date | null;
  readonly latestMarketTradingDay?: string | null;
  readonly staleTradingDays?: number;
  readonly isFresh?: boolean;
  readonly momentum5dPct: number | null;
  readonly momentum20dPct: number | null;
  readonly longTermMomentumPct: number | null;
  readonly volumeRatio20d: number | null;
  readonly breakout20d: boolean;
  readonly volatilityCompression: boolean;
  readonly recentWeekGainExceeded: boolean;
  // 当日涨跌（最新 close vs 前一日 close），不足 2 条 Candle 记 null
  readonly todayChangePct?: number | null;
  readonly reasons: readonly string[];
}

const average = (values: readonly number[]): number | null => {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

export const calculateMarketSignalScore = (
  candlesDesc: readonly any[],
  strategyConfig?: IStrategyExperimentConfig,
): IMarketSignalScore => {
  const candles = [...candlesDesc].sort((left, right) => left.tradingDay.getTime() - right.tradingDay.getTime());
  if (candles.length < 6) {
    return {
      score: 0,
      latestTradingDay: candles.at(-1)?.tradingDay?.toISOString?.().slice(0, 10) ?? null,
      latestTradingDayDate: candles.at(-1)?.tradingDay ?? null,
      latestMarketTradingDay: candles.at(-1)?.tradingDay?.toISOString?.().slice(0, 10) ?? null,
      staleTradingDays: 0,
      isFresh: true,
      momentum5dPct: null,
      momentum20dPct: null,
      longTermMomentumPct: null,
      volumeRatio20d: null,
      breakout20d: false,
      volatilityCompression: false,
      recentWeekGainExceeded: false,
      reasons: ['市场确认信号：asOf 前可见 Candle 少于 6 条，记 0 分'],
    };
  }

  const latest = candles[candles.length - 1];
  const latestClose = toNumber(latest.close);
  const latestVolume = toNumber(latest.volume);
  // 当日涨跌：最新 close vs 前一日 close，不足 2 条 Candle 记 null
  const prevClose = candles.length >= 2 ? toNumber(candles[candles.length - 2]?.close) : null;
  const todayChangePct = prevClose && prevClose > 0 ? (latestClose - prevClose) / prevClose : null;
  // 动量统一通过 scoring-utils.computeMomentumPct 计算，确保与 temp/expectation 口径一致。
  const momentum5dPct = computeMomentumPct(candles, 5);
  const momentum20dPct = computeMomentumPct(candles, 20);
  const longTermMomentumPct = computeMomentumPct(candles, 120);
  const previous20 = candles.slice(Math.max(0, candles.length - 21), -1);
  const avgVolume20 = average(previous20.map(candle => toNumber(candle.volume)).filter(value => value > 0));
  const volumeRatio20d = avgVolume20 && avgVolume20 > 0 ? latestVolume / avgVolume20 : null;
  const previous20High = previous20.length > 0
    ? Math.max(...previous20.map(candle => toNumber(candle.high)))
    : 0;
  const breakout20d = previous20High > 0 && latestClose >= previous20High;

  const recent5Ranges = candles.slice(Math.max(0, candles.length - 6)).map((candle) => {
    const close = toNumber(candle.close);
    return close > 0 ? (toNumber(candle.high) - toNumber(candle.low)) / close : 0;
  }).filter(value => value > 0);
  const previous20Ranges = previous20.map((candle) => {
    const close = toNumber(candle.close);
    return close > 0 ? (toNumber(candle.high) - toNumber(candle.low)) / close : 0;
  }).filter(value => value > 0);
  const recentRangeAvg = average(recent5Ranges);
  const previousRangeAvg = average(previous20Ranges);
  const avgClose20 = average(previous20.map(candle => toNumber(candle.close)).filter(value => value > 0));
  const volatilityCompression = Boolean(
    recentRangeAvg !== null
    && previousRangeAvg !== null
    && avgClose20 !== null
    && previousRangeAvg > 0
    && recentRangeAvg / previousRangeAvg <= 0.75
    && latestClose >= avgClose20,
  );

  // 低位区判定：最新收盘价低于 20 日均价的 95% 视为庄家吸筹区
  const isLowZone = avgClose20 !== null && latestClose < avgClose20 * 0.95;
  // 低位放量吸筹：低位区 + 量比 > 1.2
  const isAccumulation = isLowZone && volumeRatio20d !== null && volumeRatio20d > 1.2;
  const isLowVolumeRebound = isLowZone && (volumeRatio20d ?? 0) < 0.8;

  // 映射基本组件原始得分 (0 到 1)
  // S_m5：庄家吸筹验证（替代旧追涨逻辑：旧公式 (momentum5dPct+0.02)/0.1 涨越多分越高，与"发现弱信号"目标背离）
  let S_m5: number;
  let m5Reason: string;
  if (momentum5dPct === null) {
    S_m5 = 0;
    m5Reason = '5日动量NA';
  } else if (momentum5dPct > 0.1) {
    // 5日已涨超10%，追涨风险高，降权避免追涨
    S_m5 = 0.2;
    m5Reason = `5日涨幅 ${(momentum5dPct * 100).toFixed(2)}% > 10%，触发追涨降权 S_m5=0.2`;
  } else if (isAccumulation) {
    // 低位区+放量，庄家吸筹，最高分
    S_m5 = 1.0;
    m5Reason = '低位放量，庄家吸筹验证 S_m5=1.0';
  } else if (isLowVolumeRebound) {
    S_m5 = 0.1;
    m5Reason = '低位区但量能不足，弱反弹降权 S_m5=0.1';
  } else if (isLowZone) {
    // 低位区但量能不足
    S_m5 = 0.6;
    m5Reason = '低位区量能不足 S_m5=0.6';
  } else {
    // 中性区间：横盘整理得中等分，大起大落降分
    S_m5 = clamp((0.05 - Math.abs(momentum5dPct)) / 0.05, 0, 0.5);
    m5Reason = `中性区间横盘整理 S_m5=${S_m5.toFixed(4)}`;
  }

  // S_m20：20日动量分量，保持类似的低位吸筹偏好但更宽松
  let S_m20: number;
  if (momentum20dPct === null) {
    S_m20 = 0;
  } else if (momentum20dPct > 0.15) {
    // 20日已大涨，避免追高
    S_m20 = 0.3;
  } else if (momentum20dPct < -0.05 && isLowZone) {
    // 20日下跌且处于低位区，可能超跌反弹机会
    S_m20 = isLowVolumeRebound ? 0.2 : 0.9;
  } else {
    // 横盘整理得中等分
    S_m20 = clamp((0.1 - Math.abs(momentum20dPct)) / 0.1, 0, 0.6);
  }

  const S_vol = volumeRatio20d === null ? 0 : clamp((volumeRatio20d - 1) / 1.5, 0, 1);
  const S_br = breakout20d
    ? 1
    : (previous20High > 0 && latestClose >= previous20High * 0.97 ? 0.5 : 0);
  const S_cmp = volatilityCompression ? 1 : 0;

  // 新增指标 1：斐波那契回调计算与打分
  const fibLookback = strategyConfig?.fibonacciLookbackDays ?? 60;
  const fibThreshold = strategyConfig?.fibonacciThresholdPct ?? 0.015;
  const fibCandles = candles.slice(-fibLookback);
  let fibHit = false;
  let matchedFibLevel: number | null = null;
  if (fibCandles.length >= 10) {
    const fibHigh = Math.max(...fibCandles.map(c => toNumber(c.high)));
    const fibLow = Math.min(...fibCandles.map(c => toNumber(c.low)));
    const diff = fibHigh - fibLow;
    if (diff > 0) {
      const targetLevels = [0.382, 0.500, 0.618];
      for (const r of targetLevels) {
        const levelVal = fibHigh - r * diff;
        if (Math.abs(latestClose - levelVal) / latestClose <= fibThreshold) {
          fibHit = true;
          matchedFibLevel = r;
          break;
        }
      }
    }
  }
  const S_fib = fibHit ? 1 : 0;

  // 新增指标 2：支撑压力检测与打分
  const srLookback = strategyConfig?.supportResistanceLookbackDays ?? 60;
  const srThreshold = strategyConfig?.supportResistanceThresholdPct ?? 0.015;
  const srCandles = candles.slice(-srLookback);
  let srHit = false;
  let srType: 'support' | 'resistance' | null = null;
  if (srCandles.length >= 10) {
    const srHigh = Math.max(...srCandles.map(c => toNumber(c.high)));
    const srLow = Math.min(...srCandles.map(c => toNumber(c.low)));
    const nearSupport = Math.abs(latestClose - srLow) / latestClose <= srThreshold;
    const nearResistance = Math.abs(latestClose - srHigh) / latestClose <= srThreshold;
    if (nearSupport) {
      srHit = true;
      srType = 'support';
    } else if (nearResistance) {
      srHit = true;
      srType = 'resistance';
    }
  }
  const S_sr = srHit ? 1 : 0;

  // 行情权重配置读取与归一化打分
  const w = strategyConfig?.marketWeights ?? {
    momentum5d: 6,
    momentum20d: 5,
    volumeRatio: 4,
    breakout: 3,
    compression: 2,
    fibonacci: 0,
    supportResistance: 0,
  };
  const totalWeight = w.momentum5d + w.momentum20d + w.volumeRatio + w.breakout + w.compression + w.fibonacci + w.supportResistance;
  const weightedSum =
    (w.momentum5d * S_m5) +
    (w.momentum20d * S_m20) +
    (w.volumeRatio * S_vol) +
    (w.breakout * S_br) +
    (w.compression * S_cmp) +
    (w.fibonacci * S_fib) +
    (w.supportResistance * S_sr);

  const score = totalWeight > 0
    ? Number(clamp((weightedSum / totalWeight) * 20, 0, 20).toFixed(4))
    : 0;

  const fibDesc = fibHit ? `斐波那契回调 ${matchedFibLevel! * 100}% 水平命中` : '斐波那契回调未命中';
  const srDesc = srHit ? `支撑压力位 [${srType!}] 触碰` : '支撑压力未触碰';

  return {
    score,
    latestTradingDay: latest.tradingDay.toISOString().slice(0, 10),
    latestTradingDayDate: latest.tradingDay,
    latestMarketTradingDay: latest.tradingDay.toISOString().slice(0, 10),
    staleTradingDays: 0,
    isFresh: true,
    momentum5dPct: momentum5dPct === null ? null : Number(momentum5dPct.toFixed(6)),
    momentum20dPct: momentum20dPct === null ? null : Number(momentum20dPct.toFixed(6)),
    longTermMomentumPct: longTermMomentumPct === null ? null : Number(longTermMomentumPct.toFixed(6)),
    volumeRatio20d: volumeRatio20d === null ? null : Number(volumeRatio20d.toFixed(4)),
    breakout20d,
    volatilityCompression,
    recentWeekGainExceeded: momentum5dPct !== null && momentum5dPct > 0.2,
    todayChangePct: todayChangePct === null ? null : Number(todayChangePct.toFixed(6)),
    reasons: [
      `市场确认信号 ${score.toFixed(4)}/20：5日涨跌 ${momentum5dPct === null ? 'NA' : (momentum5dPct * 100).toFixed(2)}%，20日涨跌 ${momentum20dPct === null ? 'NA' : (momentum20dPct * 100).toFixed(2)}%，20日量比 ${volumeRatio20d === null ? 'NA' : volumeRatio20d.toFixed(2)}`,
      `长期趋势：120日涨跌 ${longTermMomentumPct === null ? 'NA' : (longTermMomentumPct * 100).toFixed(2)}%`,
      `低位区: ${isLowZone ? '是' : '否'}, 量比 ${volumeRatio20d === null ? 'NA' : volumeRatio20d.toFixed(2)}, 吸筹信号: ${isAccumulation ? '是' : '否'}`,
      `5日动量判定: ${m5Reason}`,
      `量化指标：${fibDesc}，${srDesc}`,
      `行情可见边界 tradingDay <= asOf，最新用于评分交易日 ${latest.tradingDay.toISOString().slice(0, 10)}`,
      `20日突破 ${breakout20d ? '是' : '否'}，波动压缩/突破组合 ${volatilityCompression ? '是' : '否'}`,
    ],
  };
};
