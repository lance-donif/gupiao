import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { newsFixture, candleFixture } from '../fixtures/pipeline-fixtures.js';
import { ScoringContributionEngine } from '../../../src/services/scoring-contribution-engine.js';

/**
 * 黄金回归测试专用内存 Prisma。
 *
 * 复用 fixture 的 `newsFixture` / `candleFixture` 生成确定性输入；但 fixture 自带的
 * `MemoryPrisma` 在 `clone` 时会把 `Date` 序列化成字符串，导致引擎赖以做日期区间过滤的
 * `publishedAt <= asOf` / `validFrom <= asOf` 等查询全部失配。因此这里内建一个保留 `Date`、
 * 支持 `OR`/`AND` 与嵌套 `where` 的内存实现（集合 API 与 MemoryPrisma 一致），以保证
 * 引擎在纯搬迁后可 100% 复现同一组数字。
 */
type Row = Record<string, any>;

const clone = <T>(value: T): T => {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return new Date((value as Date).getTime()) as T;
  if (typeof value === 'bigint') return value;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as unknown as T;
  if (typeof value === 'object') {
    if ((value as { constructor?: unknown }).constructor !== Object) {
      // 保留类实例（如 Prisma.Decimal），避免被拍平
      return value;
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = clone(val);
    }
    return out as T;
  }
  return value;
};

class Collection {
  public rows: Row[] = [];
  private match(row: Row, where?: Row): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, cond]) => {
      const value = row[key];
      if (key === 'OR') return Array.isArray(cond) && (cond as unknown[]).some((sub) => this.match(row, sub as Row));
      if (key === 'AND') return Array.isArray(cond) && (cond as unknown[]).every((sub) => this.match(row, sub as Row));
      if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
        if ('in' in cond) return (cond.in as unknown[]).includes(value);
        if ('equals' in cond) return value === cond.equals;
        if ('not' in cond) return value !== cond.not;
        if ('gt' in cond) return (value as number) > (cond.gt as number);
        if ('gte' in cond) return (value as number) >= (cond.gte as number);
        if ('lt' in cond) return (value as number) < (cond.lt as number);
        if ('lte' in cond) return (value as number) <= (cond.lte as number);
        if (value && typeof value === 'object') return this.match(value, cond as Row);
        return JSON.stringify(value) === JSON.stringify(cond);
      }
      return value === cond;
    });
  }
  public async findMany(args?: { where?: Row }): Promise<Row[]> {
    return clone(this.rows.filter((row) => this.match(row, args?.where)));
  }
  public async findFirst(args?: { where?: Row }): Promise<Row | null> {
    return this.findMany(args).then((rows) => rows[0] ?? null);
  }
  public async findUnique(args?: { where?: Row }): Promise<Row | null> {
    return this.findFirst(args);
  }
  public async count(args?: { where?: Row }): Promise<number> {
    return this.findMany(args).then((rows) => rows.length);
  }
  public async create(args: { data: Row }): Promise<Row> {
    const row = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...clone(args.data) };
    this.rows.push(row);
    return clone(row);
  }
  public async createMany(args: { data: Row[] }): Promise<{ count: number }> {
    for (const data of args.data) await this.create({ data });
    return { count: args.data.length };
  }
  public async update(args: { where: Row; data: Row }): Promise<Row> {
    const row = this.rows.find((item) => this.match(item, args.where));
    if (!row) throw new Error('update target not found');
    Object.assign(row, clone(args.data), { updatedAt: new Date() });
    return clone(row);
  }
  public async updateMany(args: { where: Row; data: Row }): Promise<{ count: number }> {
    const rows = this.rows.filter((item) => this.match(item, args.where));
    for (const row of rows) Object.assign(row, clone(args.data));
    return { count: rows.length };
  }
  public async upsert(args: { where: Row; create: Row; update: Row }): Promise<Row> {
    const existing = this.rows.find((item) => this.match(item, args.where));
    if (existing) {
      Object.assign(existing, clone(args.update));
      return clone(existing);
    }
    return this.create({ data: { ...args.where, ...args.create } });
  }
  public async deleteMany(args?: { where?: Row }): Promise<{ count: number }> {
    const before = this.rows.length;
    this.rows = args?.where ? this.rows.filter((row) => !this.match(row, args.where)) : [];
    return { count: before - this.rows.length };
  }
}

class InMemoryPrisma {
  [key: string]: any;
  private readonly collections = new Map<string, Collection>();
  public collection(name: string): Collection {
    let collection = this.collections.get(name);
    if (!collection) {
      collection = new Collection();
      this.collections.set(name, collection);
    }
    return collection;
  }
  public constructor() {
    return new Proxy(this, {
      get(target, property) {
        if (typeof property === 'string' && property in target && !(property in target.collections)) {
          const value = Reflect.get(target, property);
          if (typeof value === 'function') return value.bind(target);
          return value;
        }
        if (typeof property === 'string') return target.collection(property);
        return Reflect.get(target, property);
      },
    }) as InMemoryPrisma;
  }
}

const CLUSTER_KEY = 'global';
const TRACE_ID = 'golden-trace';
const AS_OF = new Date('2026-05-24T12:00:00.000Z');

interface IGoldenRow {
  readonly symbol: string;
  readonly finalScore: number;
  readonly evidenceScore: number;
  readonly graphScore: number;
  readonly exposureScore: number;
  readonly marketScore: number;
  readonly breakdown: string;
}

const buildRows = async (prisma: InMemoryPrisma): Promise<IGoldenRow[]> => {
  const featureSnapshots = (await prisma.stockFeatureSnapshot.findMany()) as Array<Record<string, unknown>>;
  const bySymbol = [...featureSnapshots].sort((left, right) => String(left.symbol).localeCompare(String(right.symbol)));
  return bySymbol.map((row) => {
    const evidenceScore = Number(row.newsFrequencyScore);
    const relationConfidenceScore = Number(row.relationConfidenceScore);
    const weakSignalBonus = Number(row.weakSignalBonus);
    const exposureScore = Number(row.boardMatchScore);
    const graphScore = Number((relationConfidenceScore + weakSignalBonus).toFixed(4));
    const finalScore = Number(row.aggregatedScore);
    const marketScore = Number((finalScore - evidenceScore - graphScore - exposureScore).toFixed(4));
    const reasons = (Array.isArray(row.reasons) ? row.reasons : []) as string[];
    const breakdown = typeof reasons[0] === 'string' ? reasons[0] : '';
    return {
      symbol: String(row.symbol),
      finalScore,
      evidenceScore,
      graphScore,
      exposureScore,
      marketScore,
      breakdown,
    };
  });
};

describe('scoring contribution engine golden regression', () => {
  it('produces deterministic candidate scores under a fixed input contract', async () => {
    const prisma = new InMemoryPrisma();

    // 新闻：2 条固定新闻（白银 / 铜），复用 fixture 的 newsFixture
    const news = newsFixture(2, { publishedAt: new Date('2026-05-24T08:00:00.000Z') });
    await prisma.normalizedNewsRecord.createMany({
      data: news.map((item, index) => ({
        id: item.id,
        title: index === 0 ? '白银库存下降 供给不足' : '铜库存下降 需求回暖',
        content: item.content,
        source: item.source,
        url: `https://example.com/${item.id}`,
        publishedAt: item.publishedAt,
        clusterKey: CLUSTER_KEY,
        reprintWeight: 1,
      })),
    });

    // 因果信号候选
    await prisma.causalSignalCandidate.createMany({
      data: [
        {
          traceId: TRACE_ID,
          asOf: AS_OF,
          clusterKey: CLUSTER_KEY,
          newsId: 'news-1',
          event: '白银相关事件',
          businessVariable: '供给不足',
          assetOrThemeKeyword: '白银',
          direction: 'positive',
          confidence: '0.8000',
          evidenceText: '白银证据',
          extractorType: 'llm',
          modelVersion: 'test-model',
          promptVersion: 'causal-signal-extraction-v1',
          status: 'candidate',
        },
        {
          traceId: TRACE_ID,
          asOf: AS_OF,
          clusterKey: CLUSTER_KEY,
          newsId: 'news-2',
          event: '铜相关事件',
          businessVariable: '需求回暖',
          assetOrThemeKeyword: '铜',
          direction: 'positive',
          confidence: '0.8000',
          evidenceText: '铜证据',
          extractorType: 'llm',
          modelVersion: 'test-model',
          promptVersion: 'causal-signal-extraction-v1',
          status: 'candidate',
        },
      ],
    });

    // 股票暴露事实
    await prisma.stockExposureFact.createMany({
      data: [
        {
          clusterKey: CLUSTER_KEY,
          symbol: '600111',
          stockName: '北方稀土',
          keyword: '白银',
          exposureType: 'business_exposure',
          taxonomyLevel: null,
          source: 'manual_verified',
          sourceId: '白银-600111',
          sourceName: '白银伴生矿',
          confidence: '0.9000',
          memberCount: 1,
          validFrom: new Date('2026-05-24T00:00:00.000Z'),
          validTo: null,
          status: 'active',
        },
        {
          clusterKey: CLUSTER_KEY,
          symbol: '000630',
          stockName: '铜陵有色',
          keyword: '铜',
          exposureType: 'business_exposure',
          taxonomyLevel: null,
          source: 'manual_verified',
          sourceId: '铜-000630',
          sourceName: '铜矿产能',
          confidence: '0.9000',
          memberCount: 1,
          validFrom: new Date('2026-05-24T00:00:00.000Z'),
          validTo: null,
          status: 'active',
        },
      ],
    });

    // 股票与行情（复用 fixture 的 candleFixture，映射到 stockId 供 market signal 查询）
    for (const symbol of ['600111', '000630']) {
      await prisma.stock.createMany({
        data: [{ id: `stock-${symbol}`, clusterKey: CLUSTER_KEY, symbol }],
      });
      const candles = candleFixture(symbol, 22, '2026-04-24').map((candle) => ({
        stockId: `stock-${symbol}`,
        tradingDay: candle.tradingDay,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      }));
      await prisma.candle.createMany({ data: candles });
    }

    // 图谱快照
    await prisma.graphSnapshot.create({
      data: {
        traceId: TRACE_ID,
        asOf: AS_OF,
        clusterKey: CLUSTER_KEY,
        nodesJson: [
          { keyword: '白银', category: 'theme', frequency: 1, temperature: 'warming', weakSignal: true },
          { keyword: '铜', category: 'theme', frequency: 1, temperature: 'warming', weakSignal: true },
          { keyword: '光伏', category: 'industry', frequency: 3, temperature: 'hot', weakSignal: false },
        ],
        edgesJson: [
          {
            sourceKeyword: '白银',
            targetKeyword: '光伏',
            relationType: 'supply_chain',
            direction: 'source_to_target',
            confidence: 0.9,
            status: 'active',
            weakSignal: true,
            evidence: ['光伏用银需求抬升'],
            reasoning: '白银是光伏产业链瓶颈材料',
            updatedAt: '2026-05-24T08:00:00.000Z',
          },
          {
            sourceKeyword: '铜',
            targetKeyword: '光伏',
            relationType: 'supply_chain',
            direction: 'source_to_target',
            confidence: 0.85,
            status: 'active',
            weakSignal: true,
            evidence: ['光伏用铜需求抬升'],
            reasoning: '铜是光伏辅材',
            updatedAt: '2026-05-24T08:00:00.000Z',
          },
        ],
      },
    });

    // 关键词表现惩罚（仅作用于 铜，factor 0.6）
    await prisma.keywordPerformancePenalty.createMany({
      data: [
        {
          clusterKey: CLUSTER_KEY,
          keyword: '铜',
          factor: '0.6000',
          lossPct: '-0.041000',
          triggerSymbol: '600200',
          triggerTraceId: 'trace-loss',
          validFrom: new Date('2026-05-24T09:00:00.000Z'),
          validTo: new Date('2026-06-05T09:00:00.000Z'),
          reason: '测试有效惩罚',
        },
      ],
    });

    const result = await new ScoringContributionEngine().execute(prisma, {
      traceId: TRACE_ID,
      asOf: AS_OF,
      clusterKey: CLUSTER_KEY,
      scoringProfile: 'short_news',
    });

    const rows = await buildRows(prisma);

    // 搬迁回归防线：以下数值为搬迁前实跑结果，硬编码于此。
    // 任何"看起来等价"的搬迁若改动了行为，这里都会变红——禁止改期望值来迁就实现。
    const expectedRows: readonly IGoldenRow[] = [
      {
        symbol: '000630',
        finalScore: 43.8832,
        evidenceScore: 13.0364,
        graphScore: 11.1,
        exposureScore: 13.5,
        marketScore: 6.2468,
        breakdown: '评分组件：证据 13.0364/45，图谱 11.1000/20，暴露 13.5000/15，市场 6.2468/20，总分 43.8832/100',
      },
      {
        symbol: '600111',
        finalScore: 49.3545,
        evidenceScore: 18.2077,
        graphScore: 11.4,
        exposureScore: 13.5,
        marketScore: 6.2468,
        breakdown: '评分组件：证据 18.2077/45，图谱 11.4000/20，暴露 13.5000/15，市场 6.2468/20，总分 49.3545/100',
      },
    ];

    // 完整断言：按 symbol 排序后的 symbol + finalScore + 证据分 + 图谱分 + 暴露分 + 市场分 清单
    expect(rows.map(({ symbol, finalScore, evidenceScore, graphScore, exposureScore, marketScore }) => ({
      symbol,
      finalScore,
      evidenceScore,
      graphScore,
      exposureScore,
      marketScore,
    }))).toEqual(expectedRows.map(({ symbol, finalScore, evidenceScore, graphScore, exposureScore, marketScore }) => ({
      symbol,
      finalScore,
      evidenceScore,
      graphScore,
      exposureScore,
      marketScore,
    })));

    // 组件明细字符串（证据/图谱/暴露/市场的封顶格式）
    expect(rows.map(row => row.breakdown)).toEqual(expectedRows.map(row => row.breakdown));

    // 引擎输出元数据
    expect(result.contributionCount).toBe(2);
    expect(result.snapshotCount).toBe(2);
    expect(result.profileUsed).toBe('short_news');
    expect(result.halfLifeDaysUsed).toBe(2);
    expect(result.maxWindowDaysUsed).toBe(7);
  });
});
