import { Prisma } from '@prisma/client';

export interface ITempStockQuote {
  readonly symbol: string;
  readonly price: number;
  readonly currency: string;
  readonly marketTime: string;
  readonly capturedAt: string;
  readonly providerMetadata: {
    readonly yahooSymbol: string;
    readonly source: string;
  };
}

export interface ITempStockPayload {
  readonly syncedAtBeijing: string;
  readonly totalSymbols: number;
  readonly successCount: number;
  readonly failedCount: number;
  readonly failedSymbols: readonly string[];
  readonly requestedSymbols: readonly string[];
  readonly data: readonly ITempStockQuote[];
}

export interface ITempRecommendationScoreBreakdown {
  keywordFrequencyScore: number;
  temperatureScore: number;
  relationshipConfidenceScore: number;
  boardMatchScore: number;
  weakSignalBonus: number;
  coverageBonus: number;
  evidenceScore?: number;
  graphScore?: number;
  exposurePrecisionScore?: number;
  marketSignalScore?: number;
  totalScoreScale?: string;
  marketSignal?: Record<string, unknown>;
  primarySignalType?: string;
  selectionSignalType?: string;
  exposureFactId?: string;
  supplementalSource?: string;
}

export interface ITempStockRecommendation {
  readonly symbol: string;
  readonly stockName: string;
  readonly industry: string;
  readonly score: number;
  readonly matchedSignals: readonly string[];
  readonly matchedBoards: readonly string[];
  readonly reasons: readonly string[];
  readonly scoreBreakdown: ITempRecommendationScoreBreakdown;
  readonly latestClose: number | null;
}

export interface ITempRecommendationSelectionDiagnostics {
  readonly featureSnapshotCount: number;
  readonly evidenceCandidateCount: number;
  readonly selectedCount: number;
  readonly limit: number;
  readonly maxPerSignalType: number;
  readonly uniqueSignalTypes: number;
  readonly signalTypeCounts: Record<string, number>;
  readonly excludedByStockFilter: number;
  readonly excludedByRecentWeekGain: number;
  readonly excludedByPrice: number;
  readonly excludedByPreviousDayStock: number;
  readonly excludedByPreviousDayKeyword: number;
  readonly skippedBySignalTypeCap: number;
  readonly supplementalCandidateCount: number;
  readonly supplementalSelectedCount: number;
  readonly shortfallReasons: readonly string[];
}

export interface ITempRecommendationGenerationResult {
  readonly recommendations: readonly ITempStockRecommendation[];
  readonly diagnostics: ITempRecommendationSelectionDiagnostics;
}

interface IRecommendationCooldownExclusions {
  readonly previousDayStockSymbols: ReadonlySet<string>;
  readonly previousDayKeywords: ReadonlySet<string>;
}

interface IStockInfo {
  readonly name: string;
  readonly industry: string;
}

interface IMarketSignalSummary {
  readonly latestClose: number | null;
  readonly latestTradingDay: string | null;
  readonly momentum5dPct: number | null;
}

const SCORE_COMPONENT_PATTERN = /评分组件：证据\s+([\d.]+)\/45，图谱\s+([\d.]+)\/20，暴露\s+([\d.]+)\/15，市场\s+([\d.]+)\/20，总分\s+([\d.]+)\/100/u;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const createEmptyCooldownExclusions = (): IRecommendationCooldownExclusions => ({
  previousDayStockSymbols: new Set<string>(),
  previousDayKeywords: new Set<string>(),
});

const stockInfoExposureSources = new Set([
  'tickflow_sw_universe',
  'akshare_industry_board_em',
  'akshare_concept_board_em',
  'akshare_individual_info_em',
  'manual_verified',
  'test_exposure',
]);

const stockInfoExposureRank = (exposure: any): number => {
  const source = String(exposure.source ?? '');
  const exposureType = String(exposure.exposureType ?? '');
  const taxonomyLevel = String(exposure.taxonomyLevel ?? '').toUpperCase();
  if (source === 'historical_limitup_news' || exposureType === 'movement_evidence') {
    return -1;
  }
  if (!source && !exposureType) {
    return 1;
  }
  if (!stockInfoExposureSources.has(source)) {
    return -1;
  }
  if (source === 'tickflow_sw_universe') {
    if (taxonomyLevel === 'SW3') {
      return 100;
    }
    if (taxonomyLevel === 'SW2') {
      return 90;
    }
    if (taxonomyLevel === 'SW1') {
      return 80;
    }
    return 70;
  }
  if (source === 'akshare_industry_board_em') {
    return 75;
  }
  if (source === 'akshare_concept_board_em') {
    return 65;
  }
  if (source === 'akshare_individual_info_em') {
    return 55;
  }
  return 40;
};

const parseFeatureReasonMetadata = (
  reasons: readonly string[] | undefined,
): {
  readonly marketSignalScore: number;
  readonly marketSignal: Record<string, unknown>;
} => {
  const reasonList = reasons ?? [];
  const scoreLine = reasonList.find(reason => SCORE_COMPONENT_PATTERN.test(reason));
  const scoreMatch = scoreLine?.match(SCORE_COMPONENT_PATTERN);
  const marketSignalLine = reasonList.find(reason => reason.startsWith('marketSignal='));
  let marketSignal: Record<string, unknown> = {};
  if (marketSignalLine) {
    try {
      marketSignal = JSON.parse(marketSignalLine.slice('marketSignal='.length)) as Record<string, unknown>;
    }
    catch {
      marketSignal = {};
    }
  }

  return {
    marketSignalScore: scoreMatch ? Number(scoreMatch[4]) : Number(marketSignal.score ?? 0),
    marketSignal,
  };
};

const buildShortfallReasons = (input: {
  readonly evidenceCandidateCount: number;
  readonly selectedCount: number;
  readonly limit: number;
  readonly maxPerSignalType: number;
  readonly uniqueSignalTypes: number;
  readonly excludedByStockFilter: number;
  readonly excludedByRecentWeekGain: number;
  readonly excludedByPrice: number;
  readonly excludedByPreviousDayStock: number;
  readonly excludedByPreviousDayKeyword: number;
  readonly skippedBySignalTypeCap: number;
  readonly supplementalCandidateCount: number;
  readonly supplementalSelectedCount: number;
}): readonly string[] => {
  if (input.selectedCount >= input.limit) {
    return [];
  }

  const reasons: string[] = [];
  if (input.evidenceCandidateCount === 0 && input.supplementalCandidateCount === 0) {
    reasons.push('推荐不足：没有带 EvidenceContribution 的股票候选，严格单向流程不允许补位');
  }
  else if (input.evidenceCandidateCount < input.limit) {
    reasons.push(`推荐不足：因果贡献候选只有 ${input.evidenceCandidateCount} 只，少于目标 ${input.limit} 只`);
  }

  if (input.supplementalCandidateCount > 0) {
    reasons.push(`推荐不足：真实异动证据补充通过 ${input.supplementalCandidateCount} 只，仍少于目标 ${input.limit} 只`);
  }

  if (input.uniqueSignalTypes * input.maxPerSignalType < input.limit) {
    reasons.push(`推荐不足：可贡献信号类型只有 ${input.uniqueSignalTypes} 个，每类型最多 ${input.maxPerSignalType} 只，理论上限 ${input.uniqueSignalTypes * input.maxPerSignalType} 只`);
  }

  if (input.skippedBySignalTypeCap > 0) {
    reasons.push(`推荐不足：主信号类型上限过滤 ${input.skippedBySignalTypeCap} 只，未用无证据股票硬凑`);
  }

  if (input.excludedByStockFilter > 0) {
    reasons.push(`推荐不足：已按股票池规则排除 ${input.excludedByStockFilter} 只 688 开头或 ST 股票`);
  }

  if (input.excludedByRecentWeekGain > 0) {
    reasons.push(`推荐不足：已排除 ${input.excludedByRecentWeekGain} 只最近 5 个交易日涨幅超过 20% 的股票`);
  }

  if (input.excludedByPrice > 0) {
    reasons.push(`推荐不足：已排除 ${input.excludedByPrice} 只收盘价超过 40 元的股票`);
  }

  if (input.excludedByPreviousDayStock > 0) {
    reasons.push(`推荐不足：昨日已推荐股票过滤 ${input.excludedByPreviousDayStock} 只`);
  }

  if (input.excludedByPreviousDayKeyword > 0) {
    reasons.push(`推荐不足：昨日已推荐关键词过滤 ${input.excludedByPreviousDayKeyword} 只`);
  }

  reasons.push('如需增加推荐数量，需要更多通过质量门槛的因果贡献或真实异动证据候选');
  return reasons;
};

const buildSelectionDiagnostics = (
  features: readonly unknown[],
  candidates: readonly ITempStockRecommendation[],
  limit: number,
  maxPerIndustry: number,
): ITempRecommendationSelectionDiagnostics => {
  const selected = new TempRecommendationSelector().selectTopRecommendationsWithDiagnostics(
    candidates,
    limit,
    maxPerIndustry,
    createEmptyCooldownExclusions(),
  );
  return {
    featureSnapshotCount: features.length,
    ...selected.diagnostics,
  };
};

export const normalizeSelectionSignalType = (value: string): string => {
  if (/(半导体|芯片|集成电路|分立器件|电子化学品)/u.test(value)) {
    return '半导体';
  }
  if (/(航运|港口|交通运输|运输)/u.test(value)) {
    return '航运交通';
  }
  if (/(军工|航空装备|航天装备|航海装备|导弹|护卫舰)/u.test(value)) {
    return '国防军工';
  }
  if (/(算力|计算机设备|通信设备|通信网络|软件开发|大模型|数据中心)/u.test(value)) {
    return '算力通信';
  }
  if (/(家电|电器|电烤箱|烘焙|厨卫|小家电)/u.test(value)) {
    return '家电消费';
  }
  if (/(氟化工|玻纤|玻璃|化肥|农化|复合肥|氮肥|钾肥|磷肥)/u.test(value)) {
    return '化工材料';
  }
  if (/(乳品|饮料乳品|食品|白酒|养殖|饲料|肉制品)/u.test(value)) {
    return '食品农业';
  }
  if (/(机器人|自动化设备|专用设备|通用设备)/u.test(value)) {
    return '机器人设备';
  }
  if (/(钢铁|铁矿|能源|石油|油气|燃气|煤炭)/u.test(value)) {
    return '资源能源';
  }
  return value;
};

const isRecommendationStockEligible = (recommendation: ITempStockRecommendation): boolean => {
  const symbol = recommendation.symbol.trim();
  const normalizedName = recommendation.stockName.trim().toUpperCase();
  return !symbol.startsWith('688') && !normalizedName.includes('ST') && !normalizedName.includes('ＳＴ');
};

const getRecentWeekGain = (recommendation: ITempStockRecommendation): number | null => {
  const raw = recommendation.scoreBreakdown.marketSignal?.momentum5dPct;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const isRecentWeekGainEligible = (recommendation: ITempStockRecommendation): boolean => {
  const recentWeekGain = getRecentWeekGain(recommendation);
  return recentWeekGain === null || recentWeekGain <= 0.2;
};

const isPriceEligible = (recommendation: ITempStockRecommendation): boolean => {
  const close = recommendation.latestClose;
  return close == null || close <= 40;
};

const isSupplementalRecommendation = (recommendation: ITempStockRecommendation): boolean => {
  return recommendation.scoreBreakdown.supplementalSource === 'movement_evidence';
};

const resolveRecommendationSignalType = (recommendation: ITempStockRecommendation): string => {
  return normalizeSelectionSignalType(
    recommendation.scoreBreakdown.selectionSignalType
    ?? recommendation.matchedSignals[0]
    ?? recommendation.industry,
  );
};

const parseJsonRecord = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    }
    catch {
      return {};
    }
  }
  return {};
};

const getMovementRawFields = (fact: any): Record<string, unknown> => {
  const evidenceJson = parseJsonRecord(fact.evidenceJson);
  return parseJsonRecord(evidenceJson.rawFields);
};

const getMovementRawText = (fact: any): string => {
  return [
    fact.keyword,
    fact.sourceName,
    getMovementRawFields(fact)['板块异动最频繁个股及所属类型-买卖方向'],
  ].map(value => String(value ?? '')).join(' ');
};

const isPositiveMovementFact = (fact: any): boolean => {
  const text = getMovementRawText(fact);
  return /大笔买入|有大买盘|拉升|净流入|向上缺口|60日新高/u.test(text)
    && !/大笔卖出|大卖盘|净流出/u.test(text);
};

const isFactActiveAt = (fact: any, asOf: Date): boolean => {
  const validFrom = fact.validFrom ? new Date(fact.validFrom).getTime() : Number.NEGATIVE_INFINITY;
  const validTo = fact.validTo ? new Date(fact.validTo).getTime() : Number.POSITIVE_INFINITY;
  const current = asOf.getTime();
  return String(fact.status ?? 'active') === 'active'
    && validFrom <= current
    && validTo >= current;
};

const resolveMovementStockName = (fact: any): string => {
  const rawName = getMovementRawFields(fact)['板块异动最频繁个股及所属类型-股票名称'];
  const name = String(rawName ?? fact.stockName ?? '').trim();
  return name || `股票-${String(fact.symbol ?? '').trim()}`;
};

const resolveMovementBoardName = (fact: any): string => {
  const rawBoard = getMovementRawFields(fact)['板块名称'];
  const board = String(rawBoard ?? '').trim();
  if (board) {
    return board;
  }
  return String(fact.sourceName ?? fact.keyword ?? '异动确认').trim() || '异动确认';
};

const normalizeCooldownKeyword = (value: unknown): string => {
  return String(value ?? '').replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
};


const resolvePreviousBeijingDayRange = (asOf: Date): { startInclusive: Date; endExclusive: Date } => {
  const beijingDateKey = new Date(asOf.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
  const currentDayStart = new Date(`${beijingDateKey}T00:00:00.000+08:00`);
  return {
    startInclusive: new Date(currentDayStart.getTime() - ONE_DAY_MS),
    endExclusive: currentDayStart,
  };
};

export class TempStockRecommendationService {
  public async generatePhysicalRecommendationsWithDiagnostics(
    prisma: any,
    traceId: string,
    asOf: Date,
    clusterKey: string,
    limit: number = 30,
    maxPerIndustry: number = 5,
  ): Promise<ITempRecommendationGenerationResult> {
    return this.buildPhysicalRecommendations(
      prisma,
      traceId,
      asOf,
      clusterKey,
      limit,
      maxPerIndustry,
    );
  }

  public async generatePhysicalRecommendations(
    prisma: any,
    traceId: string,
    asOf: Date,
    clusterKey: string,
    limit: number = 30,
    maxPerIndustry: number = 5,
  ): Promise<readonly ITempStockRecommendation[]> {
    const result = await this.buildPhysicalRecommendations(
      prisma,
      traceId,
      asOf,
      clusterKey,
      limit,
      maxPerIndustry,
    );
    return result.recommendations;
  }

  private async buildPhysicalRecommendations(
    prisma: any,
    traceId: string,
    asOf: Date,
    clusterKey: string,
    limit: number,
    maxPerIndustry: number,
  ): Promise<ITempRecommendationGenerationResult> {
    // 1. 查询该 traceId 下的所有 StockFeatureSnapshot
    const features = await prisma.stockFeatureSnapshot.findMany({
      where: { traceId },
    });

    if (features.length === 0) {
      return {
        recommendations: [],
        diagnostics: buildSelectionDiagnostics([], [], limit, maxPerIndustry),
      };
    }

    const featureSymbols = features.map((f: any) => String(f.symbol));
    // 2. 只使用股票真实暴露事实补全名称与行业。
    const stockInfoMap = await this.loadStockInfoMap(prisma, clusterKey, asOf, featureSymbols);

    const signalMap = await this.loadContributionSignals(
      prisma,
      traceId,
      featureSymbols,
    );
    const cooldownExclusions = await this.loadPreviousDayRecommendationExclusions(prisma, clusterKey, asOf);

    // 2.5 查 asOf 前最新收盘价
    const marketSignalMap = await this.loadLatestMarketSignals(prisma, clusterKey, asOf, featureSymbols);

    // 3. 将特征转换并根据 aggregatedScore 降序排序；没有贡献明细的股票不进入推荐。
    const candidates = features.flatMap((f: any) => {
      const signals = signalMap.get(f.symbol);
      if (!signals || signals.length === 0) {
        return [];
      }
      const info = stockInfoMap.get(f.symbol) ?? { name: `股票-${f.symbol}`, industry: '未归类' };
      const parsedFeatureReasons = parseFeatureReasonMetadata(f.reasons);
      const marketSignal = marketSignalMap.get(f.symbol);
      return [{
        symbol: f.symbol,
        stockName: info.name,
        industry: info.industry,
        score: Number(f.aggregatedScore),
        matchedSignals: signals.map(signal => signal.keyword),
        matchedBoards: [],
        reasons: f.reasons,
        latestClose: marketSignal?.latestClose ?? null,
        scoreBreakdown: {
          keywordFrequencyScore: Number(f.newsFrequencyScore),
          temperatureScore: 0.0,
          relationshipConfidenceScore: Number(f.relationConfidenceScore),
          boardMatchScore: Number(f.boardMatchScore),
          weakSignalBonus: Number(f.weakSignalBonus),
          coverageBonus: 0.0,
          evidenceScore: Number(f.newsFrequencyScore),
          graphScore: Number(f.relationConfidenceScore) + Number(f.weakSignalBonus),
          exposurePrecisionScore: Number(f.boardMatchScore),
          marketSignalScore: parsedFeatureReasons.marketSignalScore,
          totalScoreScale: '0-100',
          marketSignal: {
            ...parsedFeatureReasons.marketSignal,
            latestClose: marketSignal?.latestClose ?? parsedFeatureReasons.marketSignal.latestClose,
            latestTradingDay: marketSignal?.latestTradingDay ?? parsedFeatureReasons.marketSignal.latestTradingDay,
            momentum5dPct: parsedFeatureReasons.marketSignal.momentum5dPct ?? marketSignal?.momentum5dPct,
          },
          primarySignalType: signals[0]?.keyword,
          selectionSignalType: normalizeSelectionSignalType(signals[0]?.keyword ?? info.industry),
        },
      }];
    });

    candidates.sort((a: any, b: any) => b.score - a.score || a.symbol.localeCompare(b.symbol));

    // 4. 按主贡献信号类型限制单类数量，避免一个主题占满榜单。
    const selector = new TempRecommendationSelector();
    const initialSelection = selector.selectTopRecommendationsWithDiagnostics(
      candidates as unknown as readonly ITempStockRecommendation[],
      limit,
      maxPerIndustry,
      cooldownExclusions,
    );

    const supplementalCandidates = initialSelection.recommendations.length < limit && candidates.length > 0
      ? await this.buildSupplementalMovementRecommendations(
          prisma,
          asOf,
          clusterKey,
          candidates as unknown as readonly ITempStockRecommendation[],
        )
      : [];
    const combinedCandidates = [...candidates, ...supplementalCandidates]
      .sort((a: any, b: any) => b.score - a.score || a.symbol.localeCompare(b.symbol));
    const selection = supplementalCandidates.length > 0
      ? selector.selectTopRecommendationsWithDiagnostics(
          combinedCandidates as unknown as readonly ITempStockRecommendation[],
          limit,
          maxPerIndustry,
          cooldownExclusions,
        )
      : initialSelection;
    const selected = selection.recommendations;

    // 5. 组装 RecommendationSnapshot 快照数据
    const snapshotData = selected.map((item: any, index: number) => {
      return {
        traceId,
        asOf,
        clusterKey,
        rank: index + 1,
        symbol: item.symbol,
        stockName: item.stockName,
        industry: item.industry,
        finalScore: new Prisma.Decimal(item.score),
        reasons: item.reasons,
        scoreBreakdown: item.scoreBreakdown,
        isReconciled: false,
      };
    });

    // 6. 写入物理快照表
    if (snapshotData.length > 0) {
      await prisma.recommendationSnapshot.createMany({
        data: snapshotData,
        skipDuplicates: true,
      });
    }

    return {
      recommendations: selected,
      diagnostics: {
        featureSnapshotCount: features.length,
        ...selection.diagnostics,
      },
    };
  }

  private async loadStockInfoMap(
    prisma: any,
    clusterKey: string,
    asOf: Date,
    symbols: readonly string[],
  ): Promise<Map<string, IStockInfo>> {
    const stockInfoMap = new Map<string, IStockInfo>();
    const uniqueSymbols = [...new Set(symbols.map(symbol => String(symbol).trim()).filter(Boolean))];
    if (uniqueSymbols.length === 0) {
      return stockInfoMap;
    }

    if (prisma.stock?.findMany) {
      const stocks = await prisma.stock.findMany({
        where: {
          clusterKey,
          symbol: { in: uniqueSymbols },
        },
      });
      for (const stock of stocks) {
        const symbol = String(stock.symbol ?? '').trim();
        if (!symbol) {
          continue;
        }
        const name = String(stock.name ?? '').trim();
        const industry = String(stock.industry ?? '').trim();
        if (name || industry) {
          stockInfoMap.set(symbol, {
            name: name || `股票-${symbol}`,
            industry: industry && industry !== '未分类' ? industry : '未归类',
          });
        }
      }
    }

    if (!prisma.stockExposureFact?.findMany) {
      return stockInfoMap;
    }

    const exposureFacts = await prisma.stockExposureFact.findMany({
      where: {
        clusterKey,
        status: 'active',
        symbol: { in: uniqueSymbols },
        validFrom: { lte: asOf },
        OR: [
          { validTo: null },
          { validTo: { gte: asOf } },
        ],
      },
      orderBy: [
        { taxonomyLevel: 'desc' },
        { confidence: 'desc' },
      ],
    });

    const stockInfoExposures = exposureFacts
      .filter((exposure: any) => isFactActiveAt(exposure, asOf))
      .filter((exposure: any) => stockInfoExposureRank(exposure) >= 0)
      .sort((left: any, right: any) => {
        return stockInfoExposureRank(right) - stockInfoExposureRank(left)
          || Number(right.confidence ?? 0) - Number(left.confidence ?? 0)
          || String(left.keyword ?? '').localeCompare(String(right.keyword ?? ''));
      });

    for (const exposure of stockInfoExposures) {
      const symbol = String(exposure.symbol ?? '').trim();
      if (!symbol) {
        continue;
      }
      stockInfoMap.set(symbol, {
        name: String(exposure.stockName ?? '').trim() || stockInfoMap.get(symbol)?.name || `股票-${symbol}`,
        industry: String(exposure.keyword ?? '').trim() || stockInfoMap.get(symbol)?.industry || '未归类',
      });
    }

    return stockInfoMap;
  }

  private async loadLatestMarketSignals(
    prisma: any,
    clusterKey: string,
    asOf: Date,
    symbols: readonly string[],
  ): Promise<Map<string, IMarketSignalSummary>> {
    const uniqueSymbols = [...new Set(symbols.map(symbol => String(symbol).trim()).filter(Boolean))];
    const result = new Map<string, IMarketSignalSummary>();
    if (uniqueSymbols.length === 0 || !prisma.candle?.findMany) {
      return result;
    }

    const candles = await prisma.candle.findMany({
      where: {
        tradingDay: { lte: asOf },
        stock: {
          clusterKey,
          symbol: { in: uniqueSymbols },
        },
      },
      orderBy: [
        { stockId: 'asc' },
        { tradingDay: 'desc' },
      ],
      select: {
        close: true,
        tradingDay: true,
        stock: { select: { symbol: true } },
      },
    });

    const rowsBySymbol = new Map<string, { close: number; tradingDay: Date }[]>();
    for (const candle of candles) {
      const symbol = String(candle.stock?.symbol ?? '').trim();
      if (!symbol) {
        continue;
      }
      const rows = rowsBySymbol.get(symbol) ?? [];
      rows.push({
        close: Number(candle.close),
        tradingDay: new Date(candle.tradingDay),
      });
      rowsBySymbol.set(symbol, rows);
    }

    for (const [symbol, rows] of rowsBySymbol.entries()) {
      rows.sort((left, right) => right.tradingDay.getTime() - left.tradingDay.getTime());
      const latest = rows[0];
      if (!latest) {
        continue;
      }
      const base = rows[5] ?? rows[rows.length - 1];
      const momentum5dPct = base && Number.isFinite(base.close) && base.close > 0 && base !== latest
        ? (latest.close - base.close) / base.close
        : null;
      result.set(symbol, {
        latestClose: latest.close,
        latestTradingDay: latest.tradingDay.toISOString().slice(0, 10),
        momentum5dPct,
      });
    }

    return result;
  }

  private async buildSupplementalMovementRecommendations(
    prisma: any,
    asOf: Date,
    clusterKey: string,
    existingCandidates: readonly ITempStockRecommendation[],
  ): Promise<readonly ITempStockRecommendation[]> {
    if (!prisma.stockExposureFact?.findMany || existingCandidates.length === 0) {
      return [];
    }

    const existingSymbols = new Set(existingCandidates.map(candidate => candidate.symbol.trim()));
    const movementFacts = await prisma.stockExposureFact.findMany({
      where: {
        clusterKey,
        status: 'active',
        exposureType: 'movement_evidence',
        validFrom: { lte: asOf },
        OR: [
          { validTo: null },
          { validTo: { gte: asOf } },
        ],
      },
      orderBy: [
        { confidence: 'desc' },
        { updatedAt: 'desc' },
      ],
    });

    const bestFactBySymbol = new Map<string, any>();
    for (const fact of movementFacts) {
      const symbol = String(fact.symbol ?? '').trim();
      if (!symbol || existingSymbols.has(symbol)) {
        continue;
      }
      if (String(fact.exposureType ?? '') !== 'movement_evidence' || !isFactActiveAt(fact, asOf) || !isPositiveMovementFact(fact)) {
        continue;
      }
      const current = bestFactBySymbol.get(symbol);
      if (!current || Number(fact.confidence ?? 0) > Number(current.confidence ?? 0)) {
        bestFactBySymbol.set(symbol, fact);
      }
    }

    const facts = [...bestFactBySymbol.values()].sort((left, right) => {
      return Number(right.confidence ?? 0) - Number(left.confidence ?? 0)
        || String(left.symbol ?? '').localeCompare(String(right.symbol ?? ''));
    });
    const symbols = facts.map(fact => String(fact.symbol).trim());
    const stockInfoMap = await this.loadStockInfoMap(prisma, clusterKey, asOf, symbols);
    const marketSignalMap = await this.loadLatestMarketSignals(prisma, clusterKey, asOf, symbols);
    const lowestEvidenceScore = Math.min(...existingCandidates.map(candidate => candidate.score));
    const supplementalScoreCeiling = Number.isFinite(lowestEvidenceScore)
      ? Math.max(1, lowestEvidenceScore - 0.1)
      : 10;

    return facts.map((fact, index) => {
      const symbol = String(fact.symbol).trim();
      const marketSignal = marketSignalMap.get(symbol);
      const boardName = resolveMovementBoardName(fact);
      const info = stockInfoMap.get(symbol);
      const industry = info?.industry && info.industry !== '未归类'
        ? info.industry
        : boardName;
      const stockName = resolveMovementStockName(fact);
      const rawFields = getMovementRawFields(fact);
      const rawChangePct = Number(rawFields['涨跌幅']);
      const score = Math.max(1, supplementalScoreCeiling - index * 0.001);
      return {
        symbol,
        stockName: stockName || info?.name || `股票-${symbol}`,
        industry,
        score,
        matchedSignals: [String(fact.keyword ?? '大笔买入'), boardName, industry].filter(Boolean),
        matchedBoards: [boardName],
        reasons: [
          `真实异动证据补充：${String(fact.keyword ?? '大笔买入')}`,
          `板块异动：${boardName}`,
          marketSignal?.latestClose != null ? `最新收盘价 ${marketSignal.latestClose.toFixed(2)}` : '缺少最新收盘价，保留为低优先级候选',
        ],
        latestClose: marketSignal?.latestClose ?? null,
        scoreBreakdown: {
          keywordFrequencyScore: 0,
          temperatureScore: 0,
          relationshipConfidenceScore: 0,
          boardMatchScore: 0,
          weakSignalBonus: 0,
          coverageBonus: 0,
          evidenceScore: 0,
          graphScore: 0,
          exposurePrecisionScore: Number(fact.confidence ?? 0) * 15,
          marketSignalScore: Number.isFinite(rawChangePct) ? Math.max(0, Math.min(20, Math.abs(rawChangePct))) : 0,
          totalScoreScale: '0-100',
          marketSignal: {
            source: 'movement_evidence',
            keyword: String(fact.keyword ?? ''),
            boardName,
            latestClose: marketSignal?.latestClose ?? null,
            latestTradingDay: marketSignal?.latestTradingDay ?? null,
            momentum5dPct: marketSignal?.momentum5dPct ?? null,
            rawChangePct: Number.isFinite(rawChangePct) ? rawChangePct : null,
          },
          primarySignalType: String(fact.keyword ?? '大笔买入'),
          selectionSignalType: boardName,
          exposureFactId: String(fact.id ?? ''),
          supplementalSource: 'movement_evidence',
        },
      };
    });
  }

  private async loadContributionSignals(
    prisma: any,
    traceId: string,
    symbols: readonly string[],
  ): Promise<Map<string, readonly { keyword: string; score: number }[]>> {
    if (!prisma.evidenceContribution?.findMany || symbols.length === 0) {
      return new Map();
    }

    const rows = await prisma.evidenceContribution.findMany({
      where: {
        traceId,
        symbol: { in: [...symbols] },
      },
    });

    const keywordScoreBySymbol = new Map<string, Map<string, number>>();
    for (const row of rows) {
      const symbol = String(row.symbol);
      const keyword = String(row.matchedExposureKeyword ?? row.keyword);
      const current = keywordScoreBySymbol.get(symbol) ?? new Map<string, number>();
      current.set(keyword, (current.get(keyword) ?? 0) + Number(row.finalContribScore));
      keywordScoreBySymbol.set(symbol, current);
    }

    const signalsBySymbol = new Map<string, readonly { keyword: string; score: number }[]>();
    for (const [symbol, keywordScores] of keywordScoreBySymbol.entries()) {
      const signals = [...keywordScores.entries()]
        .map(([keyword, score]) => ({ keyword, score }))
        .sort((a, b) => b.score - a.score || a.keyword.localeCompare(b.keyword));
      signalsBySymbol.set(symbol, signals);
    }

    return signalsBySymbol;
  }

  private async loadPreviousDayRecommendationExclusions(
    prisma: any,
    clusterKey: string,
    asOf: Date,
  ): Promise<IRecommendationCooldownExclusions> {
    const empty = createEmptyCooldownExclusions();
    if (!prisma.recommendationSnapshot?.findMany) {
      return empty;
    }

    const { startInclusive, endExclusive } = resolvePreviousBeijingDayRange(asOf);
    const previousRecommendations = await prisma.recommendationSnapshot.findMany({
      where: {
        clusterKey,
        asOf: {
          gte: startInclusive,
          lt: endExclusive,
        },
      },
      select: {
        traceId: true,
        symbol: true,
      },
    });

    const previousDayStockSymbols = new Set<string>();
    const previousPairs = new Map<string, { traceId: string; symbol: string }>();
    for (const row of previousRecommendations) {
      const traceId = String(row.traceId ?? '').trim();
      const symbol = String(row.symbol ?? '').trim();
      if (!traceId || !symbol) {
        continue;
      }
      previousDayStockSymbols.add(symbol);
      previousPairs.set(`${traceId}\u0000${symbol}`, { traceId, symbol });
    }

    if (previousPairs.size === 0 || !prisma.evidenceContribution?.findMany) {
      return {
        previousDayStockSymbols,
        previousDayKeywords: empty.previousDayKeywords,
      };
    }

    const previousEvidence = await prisma.evidenceContribution.findMany({
      where: {
        clusterKey,
        OR: [...previousPairs.values()].map(pair => ({
          traceId: pair.traceId,
          symbol: pair.symbol,
        })),
      },
      select: {
        keyword: true,
        matchedExposureKeyword: true,
        sourceKeyword: true,
      },
    });

    const previousDayKeywords = new Set<string>();
    for (const row of previousEvidence) {
      for (const keyword of [row.keyword, row.matchedExposureKeyword, row.sourceKeyword]) {
        const normalized = normalizeCooldownKeyword(keyword);
        if (normalized) {
          previousDayKeywords.add(normalized);
        }
      }
    }

    return {
      previousDayStockSymbols,
      previousDayKeywords,
    };
  }
}

export class TempRecommendationSelector {
  public selectTopRecommendationsWithDiagnostics(
    recommendations: readonly ITempStockRecommendation[],
    limit: number,
    maxPerIndustry: number,
    _cooldownExclusions: IRecommendationCooldownExclusions = createEmptyCooldownExclusions(),
  ): {
    readonly recommendations: readonly ITempStockRecommendation[];
    readonly diagnostics: Omit<ITempRecommendationSelectionDiagnostics, 'featureSnapshotCount'>;
  } {
    const stockEligibleRecommendations = recommendations.filter(isRecommendationStockEligible);
    const excludedByStockFilter = recommendations.length - stockEligibleRecommendations.length;
    const gainEligibleRecommendations = stockEligibleRecommendations.filter(isRecentWeekGainEligible);
    const excludedByRecentWeekGain = stockEligibleRecommendations.length - gainEligibleRecommendations.length;
    const priceEligibleRecommendations = gainEligibleRecommendations.filter(isPriceEligible);
    const excludedByPrice = gainEligibleRecommendations.length - priceEligibleRecommendations.length;
    const previousStockEligibleRecommendations = priceEligibleRecommendations;
    const excludedByPreviousDayStock = 0;
    const eligibleRecommendations = previousStockEligibleRecommendations;
    const excludedByPreviousDayKeyword = 0;
    const signalTypeCounts = new Map<string, number>();
    const selected: ITempStockRecommendation[] = [];
    let skippedBySignalTypeCap = 0;

    for (const recommendation of eligibleRecommendations) {
      const signalType = resolveRecommendationSignalType(recommendation);
      const currentCount = signalTypeCounts.get(signalType) ?? 0;
      if (currentCount >= maxPerIndustry) {
        skippedBySignalTypeCap += 1;
        continue;
      }

      selected.push(recommendation);
      signalTypeCounts.set(signalType, currentCount + 1);

      if (selected.length >= limit) {
        break;
      }
    }

    const uniqueSignalTypes = new Set(
      eligibleRecommendations.map(resolveRecommendationSignalType),
    ).size;
    const supplementalCandidateCount = eligibleRecommendations.filter(isSupplementalRecommendation).length;
    const supplementalSelectedCount = selected.filter(isSupplementalRecommendation).length;
    const evidenceCandidateCount = eligibleRecommendations.length - supplementalCandidateCount;
    const diagnostics = {
      evidenceCandidateCount,
      selectedCount: selected.length,
      limit,
      maxPerSignalType: maxPerIndustry,
      uniqueSignalTypes,
      signalTypeCounts: Object.fromEntries(signalTypeCounts.entries()),
      excludedByStockFilter,
      excludedByRecentWeekGain,
      excludedByPrice,
      excludedByPreviousDayStock,
      excludedByPreviousDayKeyword,
      skippedBySignalTypeCap,
      supplementalCandidateCount,
      supplementalSelectedCount,
      shortfallReasons: buildShortfallReasons({
        evidenceCandidateCount,
        selectedCount: selected.length,
        limit,
        maxPerSignalType: maxPerIndustry,
        uniqueSignalTypes,
        excludedByStockFilter,
        excludedByRecentWeekGain,
        excludedByPrice,
        excludedByPreviousDayStock,
        excludedByPreviousDayKeyword,
        skippedBySignalTypeCap,
        supplementalCandidateCount,
        supplementalSelectedCount,
      }),
    };

    return {
      recommendations: selected,
      diagnostics,
    };
  }

  public selectTopRecommendations(
    recommendations: readonly ITempStockRecommendation[],
    limit: number,
    maxPerIndustry: number,
  ): readonly ITempStockRecommendation[] {
    return this.selectTopRecommendationsWithDiagnostics(recommendations, limit, maxPerIndustry).recommendations;
  }
}
