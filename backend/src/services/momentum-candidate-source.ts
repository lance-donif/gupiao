/**
 * 异动通道候选源（momentum channel）。
 *
 * 背景：证据通道要求候选必须有 EvidenceContribution（新闻因果证据），而实测
 * 2026-10-09 的 93 只涨停股中仅 9 只有证据、且证据分 0.0-0.1 与其余 760+ 只
 * 候选完全不可区分——新闻热度驱动的评分天然偏向已拥挤的大板块，结构性错过
 * 「无人报道、资金驱动」的涨停股。经产品决策（授权打破「无证据不补位」规则），
 * 恢复此前被移除的异动通道：直接以 asOf 当日行情（涨幅 + 放量）产出候选。
 *
 * 时间边界：只读取 tradingDay <= asOf 的 Candle，不引入任何未来数据。
 * 与证据通道的关系：两路候选合并后走同一个选择器（信号类型上限、行业上限、
 * 冷却规则全部共用）；本通道由 MOMENTUM_SIGNAL_TYPE 的信号类型上限自然限流。
 */
import { toBeijingDayKey } from '../lib/beijing-time.js';
import type { ITempStockRecommendation } from './temp-stock-recommendation-service.js';

export const MOMENTUM_SIGNAL_TYPE = 'momentum异动';

/** 当日涨幅下限：覆盖 10% 主板涨停（含盘中触板回落），20cm 板块自然包含 */
export const MOMENTUM_MIN_SURGE_PCT = 0.095;
/** 放量确认：当日成交量至少为前一交易日的 1.2 倍，排除无量假突破 */
export const MOMENTUM_MIN_VOLUME_RATIO = 1.2;
/** 与证据通道同一价格上限（40 元） */
export const MOMENTUM_MAX_PRICE = 40;
/** 通道候选上限：信号类型上限（默认 5）会在此集合内择优，集合略放大供排序 */
export const MOMENTUM_MAX_CANDIDATES = 24;

const MOMENTUM_BASE_SCORE = 55;
const MOMENTUM_SCORE_CAP = 95;

export interface IMomentumCandidate {
  readonly symbol: string;
  readonly stockName: string;
  readonly score: number;
  readonly surgePct: number;
  readonly volumeRatio: number;
  readonly latestClose: number;
  readonly latestTradingDay: string;
}

/** 异动通道标记：选择器的证据类质量门对它短路（源头已完成自身过滤） */
export const isMomentumChannelCandidate = (
  recommendation: Pick<ITempStockRecommendation, 'scoreBreakdown'>,
): boolean => recommendation.scoreBreakdown?.selectionChannel === 'momentum';

/** 证据通道各质量门的统一包装：异动通道候选直接放行 */
export const momentumAwareGate = (
  recommendation: ITempStockRecommendation,
  evidenceGate: (recommendation: ITempStockRecommendation) => boolean,
): boolean => isMomentumChannelCandidate(recommendation) || evidenceGate(recommendation);

const toFiniteNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const clampScore = (score: number): number =>
  Math.min(MOMENTUM_SCORE_CAP, Math.max(MOMENTUM_BASE_SCORE, score));

/**
 * 评分（0-100）：55 起步（跨过涨停阈值即入围），每超出阈值 1 个百分点 +2.5 分，
 * 量比每 +1 最多再加 15 分（封板强度的代理），上限 95——为证据通道保留排序空间。
 */
export const scoreMomentumCandidate = (surgePct: number, volumeRatio: number): number =>
  clampScore(
    MOMENTUM_BASE_SCORE
      + (surgePct - MOMENTUM_MIN_SURGE_PCT) * 250
      + Math.min(volumeRatio - 1, 3) * 5,
  );

const isExcludedName = (name: string): boolean => {
  const upper = name.trim().toUpperCase();
  // ST/*ST（含全角）；N=上市首日、C=上市次日至第5日（无涨跌幅限制，次日博弈风险失控）
  return upper.includes('ST') || upper.includes('ＳＴ') || /^[NC]/u.test(name.trim());
};

/**
 * 从 Candle 产出异动候选。
 * 依赖 prisma.candle / prisma.stock；缺失（单测 mock）时返回空数组，通道自动关闭。
 */
export const loadMomentumCandidates = async (
  prisma: any,
  clusterKey: string,
  asOf: Date,
): Promise<readonly IMomentumCandidate[]> => {
  if (!prisma?.candle?.findMany || !prisma?.stock?.findMany) {
    return [];
  }

  // 1) asOf 前最近两个交易日（D 与 D-1）；D-1 缺失（新股/长停）无法算涨幅，自然跳过
  const latestRows = await prisma.candle.findMany({
    where: { tradingDay: { lte: asOf } },
    orderBy: { tradingDay: 'desc' },
    take: 1,
    select: { tradingDay: true },
  });
  const latestDay: Date | undefined = latestRows[0]?.tradingDay
    ? new Date(latestRows[0].tradingDay)
    : undefined;
  if (!latestDay) {
    return [];
  }
  const previousRows = await prisma.candle.findMany({
    where: { tradingDay: { lt: latestDay } },
    orderBy: { tradingDay: 'desc' },
    take: 1,
    select: { tradingDay: true },
  });
  const previousDay: Date | undefined = previousRows[0]?.tradingDay
    ? new Date(previousRows[0].tradingDay)
    : undefined;
  if (!previousDay) {
    return [];
  }

  // 2) 两日全量 K 线（约 1 万行，含 select 裁剪）
  const rows: Array<{
    stockId: string;
    tradingDay: Date;
    close: unknown;
    volume: unknown;
  }> = await prisma.candle.findMany({
    where: { tradingDay: { in: [latestDay, previousDay] } },
    select: { stockId: true, tradingDay: true, close: true, volume: true },
  });

  const latestTime = latestDay.getTime();
  const previousTime = previousDay.getTime();
  const latestByStock = new Map<string, { close: number; volume: number }>();
  const previousByStock = new Map<string, { close: number; volume: number }>();
  for (const row of rows) {
    const time = new Date(row.tradingDay).getTime();
    if (time !== latestTime && time !== previousTime) {
      continue;
    }
    const bucket = time === latestTime ? latestByStock : previousByStock;
    bucket.set(row.stockId, {
      close: toFiniteNumber(row.close),
      volume: toFiniteNumber(row.volume),
    });
  }

  // 3) stockId -> symbol/name
  const stockIds = [...latestByStock.keys()];
  if (stockIds.length === 0) {
    return [];
  }
  const stocks: Array<{ id: string; symbol: string; name: string }> = await prisma.stock.findMany({
    where: { clusterKey, id: { in: stockIds } },
    select: { id: true, symbol: true, name: true },
  });
  const stockById = new Map(
    stocks
      .filter(stock => String(stock.symbol ?? '').trim().length > 0)
      .map(stock => [stock.id, { symbol: String(stock.symbol).trim(), name: String(stock.name ?? '').trim() }]),
  );

  // 4) 逐股计算并过滤
  const candidates: IMomentumCandidate[] = [];
  for (const [stockId, latest] of latestByStock) {
    const previous = previousByStock.get(stockId);
    const info = stockById.get(stockId);
    if (!previous || !info) {
      continue;
    }
    if (!(latest.close > 0) || !(previous.close > 0) || !(previous.volume > 0)) {
      continue;
    }
    if (info.symbol.startsWith('688') || isExcludedName(info.name)) {
      continue;
    }
    const surgePct = latest.close / previous.close - 1;
    const volumeRatio = latest.volume / previous.volume;
    if (surgePct < MOMENTUM_MIN_SURGE_PCT || volumeRatio < MOMENTUM_MIN_VOLUME_RATIO) {
      continue;
    }
    if (latest.close > MOMENTUM_MAX_PRICE) {
      continue;
    }
    candidates.push({
      symbol: info.symbol,
      stockName: info.name,
      score: scoreMomentumCandidate(surgePct, volumeRatio),
      surgePct,
      volumeRatio,
      latestClose: latest.close,
      latestTradingDay: toBeijingDayKey(latestDay),
    });
  }

  return candidates
    .sort((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol))
    .slice(0, MOMENTUM_MAX_CANDIDATES);
};

/**
 * 把异动候选映射为与证据通道同构的推荐对象。
 * industry 由调用方用 stockInfoMap（暴露事实）补齐；无暴露事实时落到未归类，
 * 选择器的行业多样化对未归类候选不设限（避免同行业相互挤占）。
 */
export const toMomentumRecommendation = (
  candidate: IMomentumCandidate,
  industry: string,
): ITempStockRecommendation => {
  const surgeText = `${(candidate.surgePct * 100).toFixed(2)}%`;
  const ratioText = candidate.volumeRatio.toFixed(2);
  return {
    symbol: candidate.symbol,
    stockName: candidate.stockName,
    industry,
    score: candidate.score,
    matchedSignals: [MOMENTUM_SIGNAL_TYPE],
    matchedBoards: [],
    reasons: [
      `异动通道：当日涨幅 ${surgeText}，量比 ${ratioText}，收盘 ${candidate.latestClose.toFixed(2)} 元（${candidate.latestTradingDay}）`,
    ],
    scoreBreakdown: {
      keywordFrequencyScore: 0,
      temperatureScore: 0,
      relationshipConfidenceScore: 0,
      boardMatchScore: 0,
      weakSignalBonus: 0,
      coverageBonus: 0,
      evidenceScore: 0,
      graphScore: 0,
      exposurePrecisionScore: 0,
      marketSignalScore: 0,
      totalScoreScale: '0-100',
      selectionChannel: 'momentum',
      selectionSignalType: MOMENTUM_SIGNAL_TYPE,
      marketSignal: {
        latestClose: candidate.latestClose,
        latestTradingDay: candidate.latestTradingDay,
        latestMarketTradingDay: candidate.latestTradingDay,
        staleTradingDays: 0,
        todayChangePct: candidate.surgePct,
      },
    },
    latestClose: candidate.latestClose,
  };
};
