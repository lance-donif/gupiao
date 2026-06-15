import { Prisma } from '@prisma/client';
import { hasPrismaDelegateMethod } from './prisma-utils.js';

/**
 * 弱信号/预期差引擎
 *
 * 核心：计算"关键词在因果图谱中的累积强度"与"相关股票近期5日涨跌幅"的差值。
 * 关系强但股价没动 = 预期差大 = 弱信号（市场还没意识到）。
 *
 * 数据来源：
 * - 图谱强度：GraphSnapshot.edgesJson（因果边 + 共现降级边）
 * - 股价反应：Candle（tradingDay <= asOf，5日涨跌幅）
 * - 关键词→股票：StockExposureFact（keyword → symbol）
 */

export interface IExpectationGapInput {
  readonly traceId: string;
  readonly asOf: Date;
  readonly clusterKey: string;
}

export interface IExpectationGapKeywordResult {
  readonly keyword: string;
  readonly graphStrength: number;
  readonly priceReaction: number;
  readonly expectationGap: number;
  readonly isWeakSignal: boolean;
  readonly relatedSymbols: readonly string[];
  readonly evidenceEdges: readonly Record<string, unknown>[];
  readonly reasons: readonly string[];
}

export interface IExpectationGapResult {
  readonly snapshotCount: number;
  readonly weakSignalCount: number;
  readonly topGaps: readonly IExpectationGapKeywordResult[];
}

// 经验阈值，跑几次真实数据后校准
const WEAK_SIGNAL_GAP_THRESHOLD = 0.40;
const WEAK_SIGNAL_FLAT_PRICE_THRESHOLD = 0.03;
const GRAPH_STRENGTH_NORMALIZATION_FACTOR = 10.0;  // top关键词原始强度约9，归一化后~0.9

// 泛化词黑名单：这些词不是有意义的资产/主题
const GENERIC_KEYWORD_BLACKLIST = new Set([
  '行业', '产业', '产业链', '项目', '公司', '建设', '发展', '投资', '市场', '企业',
  '业务', '产品', '服务', '板块', '概念', '主题', '领域', '方向', '趋势',
]);

interface IGraphEdge {
  readonly sourceKeyword: string;
  readonly targetKeyword: string;
  readonly confidence: number;
  readonly weakSignal?: boolean;
  readonly relationType?: string;
  readonly evidence?: readonly string[];
}

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(value, max));
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const parseGraphEdges = (edgesJson: unknown): readonly IGraphEdge[] => {
  if (!Array.isArray(edgesJson)) {
    return [];
  }
  return edgesJson
    .filter(isRecord)
    .filter(edge => typeof edge.sourceKeyword === 'string' && typeof edge.targetKeyword === 'string')
    .map(edge => ({
      sourceKeyword: String(edge.sourceKeyword),
      targetKeyword: String(edge.targetKeyword),
      confidence: typeof edge.confidence === 'number' ? edge.confidence : Number(edge.confidence ?? 0),
      weakSignal: edge.weakSignal === true,
      relationType: typeof edge.relationType === 'string' ? edge.relationType : undefined,
      evidence: Array.isArray(edge.evidence) ? edge.evidence.filter((item): item is string => typeof item === 'string') : undefined,
    }))
    .filter(edge => Number.isFinite(edge.confidence) && edge.confidence > 0);
};

/**
 * 按 targetKeyword 聚合边 confidence 作为该关键词的图谱强度。
 * 因果边（非 weakSignal）权重为1.0，共现降级边（weakSignal）权重为0.5。
 */
const aggregateGraphStrengthByKeyword = (
  edges: readonly IGraphEdge[],
): ReadonlyMap<string, { strength: number; evidenceEdges: IGraphEdge[] }> => {
  const result = new Map<string, { strength: number; evidenceEdges: IGraphEdge[] }>();
  for (const edge of edges) {
    const keyword = edge.targetKeyword;
    if (!keyword || GENERIC_KEYWORD_BLACKLIST.has(keyword)) {
      continue;
    }
    const weight = edge.weakSignal ? 0.5 : 1.0;
    const contribution = edge.confidence * weight;
    const current = result.get(keyword) ?? { strength: 0, evidenceEdges: [] };
    current.strength += contribution;
    current.evidenceEdges.push(edge);
    result.set(keyword, current);
  }
  return result;
};

/**
 * 计算5日涨跌幅，复用 scoring-contribution-engine 的 momentum5dPct 逻辑。
 */
const calculateMomentum5dPct = (candlesDesc: readonly { tradingDay: Date; close: unknown }[]): number | null => {
  if (candlesDesc.length < 6) {
    return null;
  }
  const candles = [...candlesDesc].sort((left, right) => left.tradingDay.getTime() - right.tradingDay.getTime());
  const latestClose = toNumber(candles[candles.length - 1].close);
  const close5 = toNumber(candles[Math.max(0, candles.length - 6)].close);
  return close5 > 0 ? (latestClose - close5) / close5 : null;
};

const hasDelegate = (prisma: any, delegateName: string, methodName: string): boolean => {
  return hasPrismaDelegateMethod(prisma, delegateName, methodName);
};

export class ExpectationGapService {
  /**
   * 计算并落库预期差快照。
   */
  public async calculate(prisma: any, input: IExpectationGapInput): Promise<IExpectationGapResult> {
    if (!hasDelegate(prisma, 'graphSnapshot', 'findUnique')) {
      return { snapshotCount: 0, weakSignalCount: 0, topGaps: [] };
    }

    // 1. 读取本 trace 的 GraphSnapshot
    const graphSnapshot = await prisma.graphSnapshot.findUnique({
      where: { traceId: input.traceId },
    });
    if (!graphSnapshot || graphSnapshot.clusterKey !== input.clusterKey) {
      return { snapshotCount: 0, weakSignalCount: 0, topGaps: [] };
    }
    const edges = parseGraphEdges(graphSnapshot.edgesJson);
    if (edges.length === 0) {
      return { snapshotCount: 0, weakSignalCount: 0, topGaps: [] };
    }

    // 2. 按 targetKeyword 聚合图谱强度
    const strengthByKeyword = aggregateGraphStrengthByKeyword(edges);

    // 3. 读取 StockExposureFact 关键词→股票映射
    const keywords = [...strengthByKeyword.keys()];
    const exposureFacts = hasDelegate(prisma, 'stockExposureFact', 'findMany')
      ? await prisma.stockExposureFact.findMany({
          where: {
            clusterKey: input.clusterKey,
            status: 'active',
            keyword: { in: keywords },
            validFrom: { lte: input.asOf },
            OR: [{ validTo: null }, { validTo: { gte: input.asOf } }],
          },
          select: { symbol: true, keyword: true },
        })
      : [];

    const symbolsByKeyword = new Map<string, Set<string>>();
    for (const fact of exposureFacts) {
      const keyword = String(fact.keyword);
      const symbol = String(fact.symbol);
      const set = symbolsByKeyword.get(keyword) ?? new Set<string>();
      set.add(symbol);
      symbolsByKeyword.set(keyword, set);
    }

    // 4. 批量读取所有相关股票的 Candle
    const allSymbols = [...new Set(
      [...symbolsByKeyword.values()].flatMap(set => [...set]),
    )];
    const stockIdBySymbol = new Map<string, string>();
    if (allSymbols.length > 0 && hasDelegate(prisma, 'stock', 'findMany')) {
      const stocks = await prisma.stock.findMany({
        where: { clusterKey: input.clusterKey, symbol: { in: allSymbols } },
        select: { id: true, symbol: true },
      });
      for (const stock of stocks) {
        stockIdBySymbol.set(String(stock.symbol), String(stock.id));
      }
    }

    const momentumBySymbol = new Map<string, number | null>();
    if (stockIdBySymbol.size > 0 && hasDelegate(prisma, 'candle', 'findMany')) {
      const lookbackStart = new Date(input.asOf.getTime() - 20 * 24 * 60 * 60 * 1000);
      const candles = await prisma.candle.findMany({
        where: {
          stockId: { in: [...stockIdBySymbol.values()] },
          tradingDay: { gte: lookbackStart, lte: input.asOf },
        },
        orderBy: [{ stockId: 'asc' }, { tradingDay: 'desc' }],
      });
      const candlesByStockId = new Map<string, { tradingDay: Date; close: unknown }[]>();
      for (const candle of candles) {
        const list = candlesByStockId.get(String(candle.stockId)) ?? [];
        list.push({ tradingDay: candle.tradingDay, close: candle.close });
        candlesByStockId.set(String(candle.stockId), list);
      }
      for (const [symbol, stockId] of stockIdBySymbol) {
        const symbolCandles = candlesByStockId.get(stockId) ?? [];
        momentumBySymbol.set(symbol, calculateMomentum5dPct(symbolCandles));
      }
    }

    // 5. 计算每个关键词的预期差
    const results: IExpectationGapKeywordResult[] = [];
    for (const [keyword, { strength, evidenceEdges }] of strengthByKeyword) {
      const normalizedGraphStrength = clamp(strength / GRAPH_STRENGTH_NORMALIZATION_FACTOR, 0, 1);
      const symbols = [...(symbolsByKeyword.get(keyword) ?? [])];

      // priceReaction = 关联股票5日涨跌幅的平均值
      const momenta = symbols
        .map(symbol => momentumBySymbol.get(symbol))
        .filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
      const priceReaction = momenta.length > 0
        ? momenta.reduce((sum, value) => sum + value, 0) / momenta.length
        : 0;

      const expectationGap = Number((normalizedGraphStrength - priceReaction).toFixed(4));
      const isWeakSignal = expectationGap > WEAK_SIGNAL_GAP_THRESHOLD
        && Math.abs(priceReaction) < WEAK_SIGNAL_FLAT_PRICE_THRESHOLD;

      const reasons: string[] = [
        `图谱强度 ${normalizedGraphStrength.toFixed(4)}（原始 ${strength.toFixed(4)}，归一化系数 ${GRAPH_STRENGTH_NORMALIZATION_FACTOR}）`,
        `股价反应 ${priceReaction.toFixed(4)}（关联 ${symbols.length} 只股票，${momenta.length} 只有5日数据）`,
        `预期差 ${expectationGap.toFixed(4)} = 图谱强度 - 股价反应`,
        isWeakSignal
          ? `弱信号命中：预期差 > ${WEAK_SIGNAL_GAP_THRESHOLD} 且股价波动 < ${WEAK_SIGNAL_FLAT_PRICE_THRESHOLD}`
          : '非弱信号',
      ];

      results.push({
        keyword,
        graphStrength: Number(normalizedGraphStrength.toFixed(4)),
        priceReaction: Number(priceReaction.toFixed(4)),
        expectationGap,
        isWeakSignal,
        relatedSymbols: symbols.slice(0, 20),
        evidenceEdges: evidenceEdges.map(edge => ({
          sourceKeyword: edge.sourceKeyword,
          targetKeyword: edge.targetKeyword,
          confidence: edge.confidence,
          weakSignal: edge.weakSignal,
          relationType: edge.relationType,
        })),
        reasons,
      });
    }

    // 按 expectationGap 降序
    results.sort((left, right) => right.expectationGap - left.expectationGap);

    // 6. 落库
    if (results.length > 0 && hasDelegate(prisma, 'expectationGapSnapshot', 'createMany')) {
      const rows = results.map(item => ({
        traceId: input.traceId,
        asOf: input.asOf,
        clusterKey: input.clusterKey,
        keyword: item.keyword,
        graphStrength: new Prisma.Decimal(item.graphStrength.toFixed(4)),
        priceReaction: new Prisma.Decimal(item.priceReaction.toFixed(4)),
        expectationGap: new Prisma.Decimal(item.expectationGap.toFixed(4)),
        isWeakSignal: item.isWeakSignal,
        relatedSymbols: [...item.relatedSymbols],
        evidenceEdges: item.evidenceEdges as unknown as Prisma.InputJsonValue,
        reasons: [...item.reasons],
      }));
      await prisma.expectationGapSnapshot.createMany({ data: rows, skipDuplicates: true });
    }

    return {
      snapshotCount: results.length,
      weakSignalCount: results.filter(item => item.isWeakSignal).length,
      topGaps: results.slice(0, 20),
    };
  }
}
