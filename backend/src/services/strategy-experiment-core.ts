import { normalizeSelectionSignalType } from './temp-stock-recommendation-service.js';
import { clamp } from '../lib/number-utils.js';

export interface IStrategyExperimentWeights {
  readonly evidence: number;
  readonly graph: number;
  readonly exposure: number;
  readonly market: number;
}

export interface IMarketSignalWeights {
  readonly momentum5d: number;
  readonly momentum20d: number;
  readonly volumeRatio: number;
  readonly breakout: number;
  readonly compression: number;
  readonly fibonacci: number;
  readonly supportResistance: number;
}

export interface IStrategyExperimentConfig {
  readonly limit: number;
  readonly maxPerSignalType: number;
  readonly maxPrice: number | null;
  readonly exclude688: boolean;
  readonly excludeST: boolean;
  readonly recent5dGainMaxPct: number | null;
  readonly minFinalScore: number | null;
  readonly minEvidenceScore: number | null;
  readonly minExposureScore: number | null;
  readonly minMarketScore: number | null;
  readonly includeSignalTypes: readonly string[];
  readonly excludeSignalTypes: readonly string[];
  readonly weights: IStrategyExperimentWeights;
  
  // Market signals customization
  readonly marketWeights: IMarketSignalWeights;
  readonly fibonacciLookbackDays: number;
  readonly fibonacciThresholdPct: number;
  readonly supportResistanceLookbackDays: number;
  readonly supportResistanceThresholdPct: number;
}

export interface IStrategyExperimentSignal {
  readonly keyword: string;
  readonly score: number;
}

export interface IStrategyExperimentFeatureInput {
  readonly symbol: string;
  readonly stockName: string;
  readonly industry: string;
  readonly newsFrequencyScore: number;
  readonly relationConfidenceScore: number;
  readonly boardMatchScore: number;
  readonly weakSignalBonus: number;
  readonly marketSignalScore: number;
  readonly marketSignal: Record<string, unknown>;
  readonly reasons: readonly string[];
  readonly matchedSignals: readonly IStrategyExperimentSignal[];
  readonly latestClose: number | null;
  readonly baseTradingDay: Date;
  readonly basePrice: number;
  readonly currentTradingDay: Date | null;
  readonly currentPrice: number | null;
  readonly returnPct: number | null;
  readonly returnStatus: string;
  
  // Candles history for strategy-specific recalculation
  readonly candles?: readonly any[];
}

export interface IStrategyExperimentScoreBreakdown {
  readonly baseScore: number;
  readonly rawScores: {
    readonly evidence: number;
    readonly graph: number;
    readonly exposure: number;
    readonly market: number;
  };
  readonly weights: IStrategyExperimentWeights;
  readonly weightedScores: {
    readonly evidence: number;
    readonly graph: number;
    readonly exposure: number;
    readonly market: number;
  };
  readonly selectionSignalType: string;
  readonly marketSignal: Record<string, unknown>;
  readonly matchedSignals: readonly string[];
}

export interface IStrategyExperimentCandidate {
  readonly symbol: string;
  readonly stockName: string;
  readonly industry: string;
  readonly score: number;
  readonly matchedSignals: readonly string[];
  readonly reasons: readonly string[];
  readonly latestClose: number | null;
  readonly baseTradingDay: Date;
  readonly basePrice: number;
  readonly currentTradingDay: Date | null;
  readonly currentPrice: number | null;
  readonly returnPct: number | null;
  readonly returnStatus: string;
  readonly scoreBreakdown: IStrategyExperimentScoreBreakdown;
}

export interface IStrategyExperimentSelectionDiagnostics {
  readonly featureSnapshotCount: number;
  readonly candidateCount: number;
  readonly selectedCount: number;
  readonly limit: number;
  readonly maxPerSignalType: number;
  readonly uniqueSignalTypes: number;
  readonly signalTypeCounts: Record<string, number>;
  readonly excludedByStockFilter: number;
  readonly excludedByRecentWeekGain: number;
  readonly excludedByPrice: number;
  readonly excludedBySignalTypeRule: number;
  readonly excludedByScoreRule: number;
  readonly skippedBySignalTypeCap: number;
  readonly shortfallReasons: readonly string[];
}

const parseNumber = (value: unknown, field: string): number => {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`Invalid numeric value for ${field}: ${String(value)}`);
  }
  if (typeof value === 'string' && value.trim() === '') {
    throw new Error(`Invalid numeric value for ${field}: ${String(value)}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${field}: ${String(value)}`);
  }
  return parsed;
};

const parsePositiveInteger = (value: unknown, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }
  const parsed = parseNumber(value, 'positive integer');
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer value: ${String(value)}`);
  }
  return parsed;
};

const parseNonNegativeNumber = (value: unknown, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }
  const parsed = parseNumber(value, 'non-negative number');
  if (parsed < 0) {
    throw new Error(`Invalid non-negative number value: ${String(value)}`);
  }
  return parsed;
};

const parseOptionalPositiveNumber = (value: unknown, fallback: number | null): number | null => {
  if (value === undefined) {
    return fallback;
  }
  if (value === null) {
    return null;
  }
  const parsed = parseNumber(value, 'optional positive number');
  if (parsed <= 0) {
    throw new Error(`Invalid optional positive number value: ${String(value)}`);
  }
  return parsed;
};

const parseOptionalNonNegativeNumber = (value: unknown, fallback: number | null): number | null => {
  if (value === undefined) {
    return fallback;
  }
  if (value === null) {
    return null;
  }
  const parsed = parseNumber(value, 'optional non-negative number');
  if (parsed < 0) {
    throw new Error(`Invalid optional non-negative number value: ${String(value)}`);
  }
  return parsed;
};

const parseStringList = (value: unknown): readonly string[] => {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('Invalid string list value');
  }
  const items = new Set<string>();
  for (const item of value) {
    const text = String(item ?? '').trim();
    if (text) {
      items.add(text);
    }
  }
  return [...items];
};

const parseBoolean = (value: unknown, fallback: boolean, field: string): boolean => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid boolean value for ${field}: ${String(value)}`);
  }
  return value;
};

const normalizeWeights = (value: unknown): IStrategyExperimentWeights => {
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('Invalid weights value');
  }
  const weights = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    evidence: parseNonNegativeNumber(weights.evidence, 1),
    graph: parseNonNegativeNumber(weights.graph, 1),
    exposure: parseNonNegativeNumber(weights.exposure, 1),
    market: parseNonNegativeNumber(weights.market, 1),
  };
};

const normalizeMarketWeights = (value: unknown): IMarketSignalWeights => {
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('Invalid marketWeights value');
  }
  const weights = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    momentum5d: parseNonNegativeNumber(weights.momentum5d, 6),
    momentum20d: parseNonNegativeNumber(weights.momentum20d, 5),
    volumeRatio: parseNonNegativeNumber(weights.volumeRatio, 4),
    breakout: parseNonNegativeNumber(weights.breakout, 3),
    compression: parseNonNegativeNumber(weights.compression, 2),
    fibonacci: parseNonNegativeNumber(weights.fibonacci, 0),
    supportResistance: parseNonNegativeNumber(weights.supportResistance, 0),
  };
};

export const defaultStrategyExperimentConfig = (): IStrategyExperimentConfig => ({
  limit: 30,
  maxPerSignalType: 30,
  maxPrice: 40,
  exclude688: true,
  excludeST: true,
  recent5dGainMaxPct: 0.2,
  minFinalScore: null,
  minEvidenceScore: null,
  minExposureScore: null,
  minMarketScore: null,
  includeSignalTypes: [],
  excludeSignalTypes: [],
  weights: {
    evidence: 1,
    graph: 1,
    exposure: 1,
    market: 1,
  },
  marketWeights: {
    momentum5d: 6,
    momentum20d: 5,
    volumeRatio: 4,
    breakout: 3,
    compression: 2,
    fibonacci: 0,
    supportResistance: 0,
  },
  fibonacciLookbackDays: 60,
  fibonacciThresholdPct: 0.015,
  supportResistanceLookbackDays: 60,
  supportResistanceThresholdPct: 0.015,
});

export const normalizeStrategyExperimentConfig = (raw: unknown): IStrategyExperimentConfig => {
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error('Strategy config must be an object');
  }
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const defaults = defaultStrategyExperimentConfig();
  return {
    limit: parsePositiveInteger(input.limit, defaults.limit),
    maxPerSignalType: parsePositiveInteger(input.maxPerSignalType, defaults.maxPerSignalType),
    maxPrice: parseOptionalPositiveNumber(input.maxPrice, defaults.maxPrice),
    exclude688: parseBoolean(input.exclude688, defaults.exclude688, 'exclude688'),
    excludeST: parseBoolean(input.excludeST, defaults.excludeST, 'excludeST'),
    recent5dGainMaxPct: parseOptionalPositiveNumber(input.recent5dGainMaxPct, defaults.recent5dGainMaxPct),
    minFinalScore: parseOptionalNonNegativeNumber(input.minFinalScore, defaults.minFinalScore),
    minEvidenceScore: parseOptionalNonNegativeNumber(input.minEvidenceScore, defaults.minEvidenceScore),
    minExposureScore: parseOptionalNonNegativeNumber(input.minExposureScore, defaults.minExposureScore),
    minMarketScore: parseOptionalNonNegativeNumber(input.minMarketScore, defaults.minMarketScore),
    includeSignalTypes: parseStringList(input.includeSignalTypes),
    excludeSignalTypes: parseStringList(input.excludeSignalTypes),
    weights: normalizeWeights(input.weights),
    marketWeights: normalizeMarketWeights(input.marketWeights),
    fibonacciLookbackDays: parsePositiveInteger(input.fibonacciLookbackDays, defaults.fibonacciLookbackDays),
    fibonacciThresholdPct: parseNonNegativeNumber(input.fibonacciThresholdPct, defaults.fibonacciThresholdPct),
    supportResistanceLookbackDays: parsePositiveInteger(input.supportResistanceLookbackDays, defaults.supportResistanceLookbackDays),
    supportResistanceThresholdPct: parseNonNegativeNumber(input.supportResistanceThresholdPct, defaults.supportResistanceThresholdPct),
  };
};

export const scoreStrategyFeature = (
  feature: IStrategyExperimentFeatureInput,
  config: IStrategyExperimentConfig,
): IStrategyExperimentCandidate => {
  const primarySignalType = normalizeSelectionSignalType(feature.matchedSignals[0]?.keyword ?? feature.industry);
  const rawScores = {
    evidence: Number(feature.newsFrequencyScore),
    graph: Number(feature.relationConfidenceScore) + Number(feature.weakSignalBonus),
    exposure: Number(feature.boardMatchScore),
    market: Number(feature.marketSignalScore),
  };
  const weightedScores = {
    evidence: Number((rawScores.evidence * config.weights.evidence).toFixed(4)),
    graph: Number((rawScores.graph * config.weights.graph).toFixed(4)),
    exposure: Number((rawScores.exposure * config.weights.exposure).toFixed(4)),
    market: Number((rawScores.market * config.weights.market).toFixed(4)),
  };
  const score = Number(clamp(
    weightedScores.evidence + weightedScores.graph + weightedScores.exposure + weightedScores.market,
    0,
    100,
  ).toFixed(4));

  return {
    symbol: feature.symbol,
    stockName: feature.stockName,
    industry: feature.industry,
    score,
    matchedSignals: feature.matchedSignals.map(signal => signal.keyword),
    reasons: feature.reasons,
    latestClose: feature.latestClose,
    baseTradingDay: feature.baseTradingDay,
    basePrice: feature.basePrice,
    currentTradingDay: feature.currentTradingDay,
    currentPrice: feature.currentPrice,
    returnPct: feature.returnPct,
    returnStatus: feature.returnStatus,
    scoreBreakdown: {
      baseScore: Number((rawScores.evidence + rawScores.graph + rawScores.exposure + rawScores.market).toFixed(4)),
      rawScores,
      weights: config.weights,
      weightedScores,
      selectionSignalType: primarySignalType,
      marketSignal: feature.marketSignal,
      matchedSignals: feature.matchedSignals.map(signal => signal.keyword),
    },
  };
};

const buildShortfallReasons = (input: {
  readonly candidateCount: number;
  readonly selectedCount: number;
  readonly limit: number;
  readonly maxPerSignalType: number;
  readonly uniqueSignalTypes: number;
  readonly excludedByStockFilter: number;
  readonly excludedByRecentWeekGain: number;
  readonly excludedByPrice: number;
  readonly excludedBySignalTypeRule: number;
  readonly excludedByScoreRule: number;
  readonly skippedBySignalTypeCap: number;
}): readonly string[] => {
  if (input.selectedCount >= input.limit) {
    return [];
  }

  const reasons: string[] = [];
  if (input.candidateCount === 0) {
    reasons.push('策略结果不足：没有带 EvidenceContribution 的股票候选');
  }
  else if (input.candidateCount < input.limit) {
    reasons.push(`策略结果不足：候选只有 ${input.candidateCount} 只，少于目标 ${input.limit} 只`);
  }

  if (input.uniqueSignalTypes * input.maxPerSignalType < input.limit) {
    reasons.push(`策略结果不足：可用信号类型只有 ${input.uniqueSignalTypes} 个，每类最多 ${input.maxPerSignalType} 只`);
  }

  if (input.excludedByStockFilter > 0) {
    reasons.push(`策略结果不足：已排除 ${input.excludedByStockFilter} 只 688 开头或 ST 股票`);
  }

  if (input.excludedByRecentWeekGain > 0) {
    reasons.push(`策略结果不足：已排除 ${input.excludedByRecentWeekGain} 只近 5 日涨幅过快的股票`);
  }

  if (input.excludedByPrice > 0) {
    reasons.push(`策略结果不足：已排除 ${input.excludedByPrice} 只价格超限或缺少收盘价的股票`);
  }

  if (input.excludedBySignalTypeRule > 0) {
    reasons.push(`策略结果不足：已按信号类型规则过滤 ${input.excludedBySignalTypeRule} 只股票`);
  }

  if (input.excludedByScoreRule > 0) {
    reasons.push(`策略结果不足：已按得分门槛过滤 ${input.excludedByScoreRule} 只股票`);
  }

  if (input.skippedBySignalTypeCap > 0) {
    reasons.push(`策略结果不足：主信号类型上限过滤 ${input.skippedBySignalTypeCap} 只`);
  }

  reasons.push('需要更多满足策略条件的候选，不能拿无证据股票补位');
  return reasons;
};

export const selectStrategyRecommendations = (
  recommendations: readonly IStrategyExperimentCandidate[],
  config: IStrategyExperimentConfig,
): {
  readonly recommendations: readonly IStrategyExperimentCandidate[];
  readonly diagnostics: IStrategyExperimentSelectionDiagnostics;
} => {
  const stockEligible = recommendations.filter((item) => {
    const symbol = item.symbol.trim();
    const normalizedName = item.stockName.trim().toUpperCase();
    if (config.exclude688 && symbol.startsWith('688')) {
      return false;
    }
    if (config.excludeST && (normalizedName.includes('ST') || normalizedName.includes('ＳＴ'))) {
      return false;
    }
    return true;
  });
  const excludedByStockFilter = recommendations.length - stockEligible.length;

  const gainEligible = stockEligible.filter((item) => {
    if (config.recent5dGainMaxPct == null) {
      return true;
    }
    const raw = item.scoreBreakdown.marketSignal?.momentum5dPct;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return true;
    }
    return parsed <= config.recent5dGainMaxPct;
  });
  const excludedByRecentWeekGain = stockEligible.length - gainEligible.length;

  const priceEligible = gainEligible.filter((item) => {
    if (item.latestClose == null) {
      return false;
    }
    if (config.maxPrice == null) {
      return true;
    }
    return item.latestClose <= config.maxPrice;
  });
  const excludedByPrice = gainEligible.length - priceEligible.length;

  const signalTypeEligible = priceEligible.filter((item) => {
    const signalType = String(item.scoreBreakdown.selectionSignalType ?? normalizeSelectionSignalType(item.industry));
    if (config.includeSignalTypes.length > 0 && !config.includeSignalTypes.includes(signalType)) {
      return false;
    }
    if (config.excludeSignalTypes.includes(signalType)) {
      return false;
    }
    return true;
  });
  const excludedBySignalTypeRule = priceEligible.length - signalTypeEligible.length;

  const scoreEligible = signalTypeEligible.filter((item) => {
    if (config.minFinalScore != null && item.score < config.minFinalScore) {
      return false;
    }
    if (config.minEvidenceScore != null && item.scoreBreakdown.weightedScores.evidence < config.minEvidenceScore) {
      return false;
    }
    if (config.minExposureScore != null && item.scoreBreakdown.weightedScores.exposure < config.minExposureScore) {
      return false;
    }
    if (config.minMarketScore != null && item.scoreBreakdown.weightedScores.market < config.minMarketScore) {
      return false;
    }
    return true;
  });
  const excludedByScoreRule = signalTypeEligible.length - scoreEligible.length;

  const sorted = [...scoreEligible].sort((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol));
  const signalTypeCounts = new Map<string, number>();
  const selected: IStrategyExperimentCandidate[] = [];
  let skippedBySignalTypeCap = 0;

  for (const candidate of sorted) {
    const signalType = String(candidate.scoreBreakdown.selectionSignalType ?? normalizeSelectionSignalType(candidate.industry));
    const currentCount = signalTypeCounts.get(signalType) ?? 0;
    if (currentCount >= config.maxPerSignalType) {
      skippedBySignalTypeCap += 1;
      continue;
    }

    selected.push(candidate);
    signalTypeCounts.set(signalType, currentCount + 1);

    if (selected.length >= config.limit) {
      break;
    }
  }

  const uniqueSignalTypes = new Set(
    scoreEligible.map(candidate => String(candidate.scoreBreakdown.selectionSignalType ?? normalizeSelectionSignalType(candidate.industry))),
  ).size;

  const diagnostics: IStrategyExperimentSelectionDiagnostics = {
    featureSnapshotCount: recommendations.length,
    candidateCount: scoreEligible.length,
    selectedCount: selected.length,
    limit: config.limit,
    maxPerSignalType: config.maxPerSignalType,
    uniqueSignalTypes,
    signalTypeCounts: Object.fromEntries(signalTypeCounts.entries()),
    excludedByStockFilter,
    excludedByRecentWeekGain,
    excludedByPrice,
    excludedBySignalTypeRule,
    excludedByScoreRule,
    skippedBySignalTypeCap,
    shortfallReasons: buildShortfallReasons({
      candidateCount: scoreEligible.length,
      selectedCount: selected.length,
      limit: config.limit,
      maxPerSignalType: config.maxPerSignalType,
      uniqueSignalTypes,
      excludedByStockFilter,
      excludedByRecentWeekGain,
      excludedByPrice,
      excludedBySignalTypeRule,
      excludedByScoreRule,
      skippedBySignalTypeCap,
    }),
  };

  return {
    recommendations: selected,
    diagnostics,
  };
};
