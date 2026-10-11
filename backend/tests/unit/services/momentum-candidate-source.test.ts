import { describe, expect, it } from 'vitest';
import {
  MOMENTUM_SIGNAL_TYPE,
  isMomentumChannelCandidate,
  loadMomentumCandidates,
  scoreMomentumCandidate,
  toMomentumRecommendation,
} from '../../../src/services/momentum-candidate-source.js';
import { TempRecommendationSelector } from '../../../src/services/temp-stock-recommendation-service.js';

const DAY_PREV = new Date('2026-10-08T00:00:00.000Z');
const DAY_LATEST = new Date('2026-10-09T00:00:00.000Z');
const AS_OF = new Date('2026-10-09T08:00:00.000Z'); // 北京 16:00 收盘边界

interface MockCandleRow {
  stockId: string;
  tradingDay: Date;
  close: number;
  volume: number;
}

class MockPrisma {
  public readonly candleRows: MockCandleRow[] = [];
  public readonly stockRows: Array<{ id: string; clusterKey: string; symbol: string; name: string }> = [];

  public readonly candle = {
    findMany: async (args: any) => {
      let rows = [...this.candleRows];
      const where = args?.where?.tradingDay ?? {};
      if (where.lte) {
        rows = rows.filter(row => row.tradingDay.getTime() <= new Date(where.lte).getTime());
      }
      if (where.lt) {
        rows = rows.filter(row => row.tradingDay.getTime() < new Date(where.lt).getTime());
      }
      if (where.in) {
        const days = new Set((where.in as Date[]).map(day => new Date(day).getTime()));
        rows = rows.filter(row => days.has(row.tradingDay.getTime()));
      }
      if (args?.orderBy?.tradingDay === 'desc') {
        rows.sort((left, right) => right.tradingDay.getTime() - left.tradingDay.getTime());
      }
      if (typeof args?.take === 'number') {
        rows = rows.slice(0, args.take);
      }
      return rows;
    },
  };

  public readonly stock = {
    findMany: async (args: any) => {
      const ids = new Set<string>(args?.where?.id?.in ?? []);
      return this.stockRows.filter(
        row => row.clusterKey === args?.where?.clusterKey && ids.has(row.id),
      );
    },
  };
}

function addStock(
  db: MockPrisma,
  input: {
    id: string;
    symbol: string;
    name: string;
    prevClose: number;
    latestClose: number;
    prevVolume: number;
    latestVolume: number;
    withPrev?: boolean;
  },
): void {
  db.stockRows.push({ id: input.id, clusterKey: 'global', symbol: input.symbol, name: input.name });
  db.candleRows.push({
    stockId: input.id,
    tradingDay: DAY_PREV,
    close: input.prevClose,
    volume: input.prevVolume,
  });
  db.candleRows.push({
    stockId: input.id,
    tradingDay: DAY_LATEST,
    close: input.latestClose,
    volume: input.latestVolume,
  });
  if (input.withPrev === false) {
    // 模拟只上市一天的新股：移除前一日K线
    const index = db.candleRows.findIndex(
      row => row.stockId === input.id && row.tradingDay.getTime() === DAY_PREV.getTime(),
    );
    if (index >= 0) {
      db.candleRows.splice(index, 1);
    }
  }
}

describe('loadMomentumCandidates（异动通道候选源）', () => {
  it('只收录涨幅与量比双达标的当日强势股', async () => {
    const db = new MockPrisma();
    addStock(db, { id: 's1', symbol: '600812', name: '华北制药', prevClose: 5.0, latestClose: 6.05, prevVolume: 1000, latestVolume: 4200 });
    addStock(db, { id: 's2', symbol: '300530', name: '领湃科技', prevClose: 20, latestClose: 28.9, prevVolume: 2000, latestVolume: 4000 });
    // 688 科创板排除
    addStock(db, { id: 's3', symbol: '688001', name: '科创芯片', prevClose: 10, latestClose: 11.5, prevVolume: 1000, latestVolume: 5000 });
    // ST 排除
    addStock(db, { id: 's4', symbol: '000001', name: 'ST某某', prevClose: 3, latestClose: 3.3, prevVolume: 1000, latestVolume: 3000 });
    // 新股 N 前缀排除
    addStock(db, { id: 's5', symbol: '301001', name: 'N新上市', prevClose: 20, latestClose: 24, prevVolume: 1000, latestVolume: 4000 });
    // 涨幅不足排除
    addStock(db, { id: 's6', symbol: '000002', name: '温和上涨', prevClose: 10, latestClose: 10.5, prevVolume: 1000, latestVolume: 3000 });
    // 无放量排除
    addStock(db, { id: 's7', symbol: '000003', name: '缩量大涨', prevClose: 10, latestClose: 11.2, prevVolume: 1000, latestVolume: 1100 });
    // 高价股排除（>40 元）
    addStock(db, { id: 's8', symbol: '000004', name: '高价股', prevClose: 45, latestClose: 50, prevVolume: 1000, latestVolume: 3000 });
    // 无前一日数据（新股）跳过
    addStock(db, { id: 's9', symbol: '000005', name: '只有一天', prevClose: 10, latestClose: 11.2, prevVolume: 1000, latestVolume: 3000, withPrev: false });

    const candidates = await loadMomentumCandidates(db, 'global', AS_OF);

    expect(candidates.map(item => item.symbol)).toEqual(['300530', '600812']);
    // 涨停幅度越大分数越高（都触及 95 上限时按代码排序）
    expect(candidates[0].score).toBeGreaterThanOrEqual(candidates[1].score);
    expect(candidates[1].surgePct).toBeCloseTo(0.21, 2);
    expect(candidates[1].volumeRatio).toBeCloseTo(4.2, 2);
  });

  it('prisma 缺少 candle 模型时通道自动关闭（兼容既有单测 mock）', async () => {
    const candidates = await loadMomentumCandidates({}, 'global', AS_OF);
    expect(candidates).toEqual([]);
  });

  it('评分为单调函数：涨幅/量比越高分越高，且被夹在 [55, 95]', () => {
    expect(scoreMomentumCandidate(0.095, 1)).toBe(55);
    expect(scoreMomentumCandidate(0.10, 1.2)).toBeGreaterThan(scoreMomentumCandidate(0.095, 1.2));
    expect(scoreMomentumCandidate(0.5, 10)).toBe(95);
  });
});

describe('异动候选与证据通道的合并行为', () => {
  const momentumCandidate = (symbol: string, score = 80): ReturnType<typeof toMomentumRecommendation> =>
    toMomentumRecommendation(
      { symbol, stockName: `异动${symbol}`, score, surgePct: 0.2, volumeRatio: 3, latestClose: 10, latestTradingDay: '2026-10-09' },
      '未归类',
    );

  it('异动候选豁免证据类质量门（5日涨幅>20% 不再拦它）', () => {
    const evidenceBlocked = {
      symbol: '600100',
      stockName: '证据股',
      industry: '有色金属',
      score: 60,
      matchedSignals: ['黄金'],
      matchedBoards: [],
      reasons: [],
      scoreBreakdown: {
        keywordFrequencyScore: 30,
        temperatureScore: 0,
        relationshipConfidenceScore: 5,
        boardMatchScore: 10,
        weakSignalBonus: 0,
        coverageBonus: 0,
        evidenceScore: 30,
        graphScore: 5,
        exposurePrecisionScore: 10,
        marketSignalScore: 10,
        marketSignal: { momentum5dPct: 0.3, staleTradingDays: 0, latestTradingDay: '2026-10-09', latestMarketTradingDay: '2026-10-09' },
      },
      latestClose: 30,
    };
    const momentum = momentumCandidate('600812');

    const result = new TempRecommendationSelector().selectTopRecommendationsWithDiagnostics(
      [evidenceBlocked, momentum],
      10,
      5,
    );

    expect(result.recommendations.map(item => item.symbol)).toEqual(['600812']);
    expect(isMomentumChannelCandidate(result.recommendations[0])).toBe(true);
  });

  it('信号类型上限同样约束异动通道：最多 5 只，超出被 cap', () => {
    const momentumSix = ['600801', '600802', '600803', '600804', '600805', '600806'].map(symbol =>
      momentumCandidate(symbol, 90),
    );
    const result = new TempRecommendationSelector().selectTopRecommendationsWithDiagnostics(
      momentumSix,
      30,
      5,
    );

    expect(result.recommendations).toHaveLength(5);
    expect(result.diagnostics.signalTypeCounts).toEqual({ [MOMENTUM_SIGNAL_TYPE]: 5 });
    expect(result.diagnostics.skippedBySignalTypeCap).toBe(1);
  });

  it('映射结果带通道标记与可读理由', () => {
    const recommendation = momentumCandidate('600812');
    expect(recommendation.scoreBreakdown.selectionChannel).toBe('momentum');
    expect(recommendation.matchedSignals).toEqual([MOMENTUM_SIGNAL_TYPE]);
    expect(recommendation.reasons[0]).toContain('异动通道');
    expect(recommendation.reasons[0]).toContain('20.00%');
  });
});
