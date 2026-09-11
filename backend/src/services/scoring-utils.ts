const BROAD_EXPOSURE_MIN_WEIGHT = 0.08;

export const normalizeDecimalNumber = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const normalizeDirectionWeight = (direction: unknown): number => {
  if (direction === 'positive') {
    return 1;
  }
  if (direction === 'mixed') {
    return 0.35;
  }
  if (direction === 'negative') {
    return -1;
  }
  return 0;
};

export const normalizeKeyword = (value: unknown): string => {
  return String(value ?? '')
    .replace(/\s+/gu, '')
    .replace(/[()（）【】[\]《》"“”、,，.。:：;；/\\|-]/gu, '')
    .replace(/[ⅡⅢ]$/u, '')
    .toLocaleLowerCase('zh-CN');
};

/**
 * Memory-efficient O(min(N,M)) space Longest Common Substring length computation with length pruning.
 */
export const longestCommonSubstringLength = (left: string, right: string): number => {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  // Length difference pruning: abort if ratio is too skewed, preventing expensive O(N*M) calculation
  const minLen = Math.min(left.length, right.length);
  const maxLen = Math.max(left.length, right.length);
  if (maxLen > 0 && minLen / maxLen < 0.6) {
    return 0;
  }

  // Optimize space by making right the shorter string
  let s1 = left;
  let s2 = right;
  if (s1.length < s2.length) {
    s1 = right;
    s2 = left;
  }

  const len2 = s2.length;
  // Use two flat Int32Arrays to avoid 2D array allocation overhead
  let prev = new Int32Array(len2 + 1);
  let curr = new Int32Array(len2 + 1);
  let max = 0;

  for (let i = 1; i <= s1.length; i += 1) {
    for (let j = 1; j <= len2; j += 1) {
      if (s1[i - 1] === s2[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        if (curr[j] > max) {
          max = curr[j];
        }
      } else {
        curr[j] = 0;
      }
    }
    // Swap arrays
    const temp = prev;
    prev = curr;
    curr = temp;
  }

  return max;
};

export const calculateTimeDecay = (
  publishedAt: Date,
  asOf: Date,
  lambda: number,
  maxWindowDays: number,
): { decayFactor: number; t: number } => {
  const diffMs = asOf.getTime() - publishedAt.getTime();
  const t = diffMs / (1000 * 60 * 60 * 24); // 天数，带小数

  if (t < 0 || t > maxWindowDays) {
    return { decayFactor: 0, t };
  }

  const decayFactor = Math.exp(-lambda * t);
  return { decayFactor, t };
};

export const calculateExposureBreadthWeight = (memberCount: unknown): number => {
  const count = Number(memberCount);
  if (!Number.isFinite(count) || count <= 0) {
    return 1;
  }
  return Math.max(BROAD_EXPOSURE_MIN_WEIGHT, Number((1 / Math.sqrt(count)).toFixed(4)));
};

/**
 * 计算 N 日动量（windowDays=5 即近5日涨幅）。
 * 输入 K 线无需预先排序，内部按 tradingDay 升序处理。
 * 不足 windowDays+1 条数据、或基准价 <=0 / 非有限，返回 null（避免被当作"全历史涨幅"误用）。
 */
export const computeMomentumPct = (
  candles: readonly { tradingDay: Date; close: unknown }[],
  windowDays: number,
): number | null => {
  if (candles.length <= windowDays) {
    return null;
  }
  const sorted = [...candles].sort((left, right) => left.tradingDay.getTime() - right.tradingDay.getTime());
  const latestClose = Number(sorted[sorted.length - 1].close);
  const baseClose = Number(sorted[sorted.length - 1 - windowDays].close);
  if (!Number.isFinite(latestClose) || !Number.isFinite(baseClose) || baseClose <= 0) {
    return null;
  }
  return (latestClose - baseClose) / baseClose;
};

/**
 * 计算"单股最新可见 K 线"距"全市场最新可见日"的天数（日历日差，向上取整，至少 1）。
 * 用于市场快照的陈旧度（latestMarketDay 早于 latestCandleDay 视作无陈旧）。
 */
export const computeStaleTradingDays = (
  latestCandleDay: Date | null,
  latestMarketDay: Date | null,
  oneDayMs: number,
): number => {
  if (!latestCandleDay || !latestMarketDay) {
    return 0;
  }
  if (latestCandleDay.getTime() >= latestMarketDay.getTime()) {
    return 0;
  }
  return Math.max(1, Math.round((latestMarketDay.getTime() - latestCandleDay.getTime()) / oneDayMs));
};
