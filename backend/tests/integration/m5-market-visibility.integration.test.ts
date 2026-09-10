// M5：时间可见性 / 交易日历 / 行情数据契约 / 收益对账 集成测试。
// 全部连真实测试库 gupiao_test（AI_TEST_DATABASE_URL），绝不连生产 gupiaodb。
// 每个测试文件使用独立 schema（CREATE TABLE ... LIKE public."X"），避免与其他集成
// 测试并发 TRUNCATE public schema 时互相干扰。
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import {
  readCandles,
  isCandleVisibleAsOf,
  candleVisibleAt,
  DatasetVersionResolver,
} from '../../src/services/market-data/market-data-reader.js';
import {
  loadRecentCandlesRawSql,
  loadMarketSignalFreshnessBySymbol,
} from '../../src/services/scoring/market-signal-loader.js';
import {
  VersionedTradingCalendar,
  loadTradingCalendar,
  CalendarCoverageGapError,
} from '../../src/types/value-objects/trading-calendar.js';
import {
  importMarketDataset,
  importMarketDatasetFromJsonl,
  assertStrictBacktestAllowed,
  assertStrictMarketDataAdmission,
  collectMarketDataAdmission,
  StrictBacktestRejectedError,
} from '../../src/services/market-data/dataset-contract.js';
import {
  resolveStockStatusAsOf,
  StockStatusCoverageGapError,
} from '../../src/services/market-data/stock-status-history.js';
import {
  computeMarginWindow,
  buildYieldRecordDrafts,
  YIELD_COMPUTE_VERSION,
} from '../../src/services/backtest-engine.js';

const connection = process.env.AI_TEST_DATABASE_URL;
const CLUSTER_KEY = 'm5test';

// 独立 schema 中需要复制的表（"Stock" 必须先于 "Candle"，以满足潜在 FK 依赖）。
const SCHEMA_TABLES = [
  '"Stock"',
  '"Candle"',
  '"RecommendationSnapshot"',
  '"MarketDatasetVersion"',
  '"TradingCalendarDay"',
  '"YieldRecord"',
  '"StockStatusHistory"',
];

const TRUNCATE_TABLES = [
  '"YieldRecord"',
  '"StockStatusHistory"',
  '"MarketDatasetVersion"',
  '"TradingCalendarDay"',
  '"RecommendationSnapshot"',
  '"Candle"',
  '"Stock"',
];

// 2026 年 11 个「工作日但非交易日」（来自任务说明）。
const HOLIDAYS_2026 = [
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23',
  '2026-04-06', '2026-05-01', '2026-05-04', '2026-05-05', '2026-06-19',
];

describe.skipIf(!connection)('M5 时间可见性 / 交易日历 / 行情契约 / 收益对账', () => {
  const schema = `m5_test_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let prisma: PrismaClient;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: connection! });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    for (const table of SCHEMA_TABLES) {
      await admin.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    const scoped = new URL(connection!);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: scoped.toString() }, { schema }) });
    process.env.DATABASE_URL = scoped.toString();
  }, 30000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (admin) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  }, 30000);

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE ${TRUNCATE_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  });

  async function insertStock(symbol: string, id: string): Promise<void> {
    await prisma.stock.create({
      data: { id, symbol, name: `${symbol}名`, industry: '', exchange: 'SSE', clusterKey: CLUSTER_KEY },
    });
  }

  async function insertCandle(
    stockId: string,
    tradingDay: Date,
    close: number,
    opts: {
      visibleAt?: Date | null;
      datasetVersionId?: string | null;
      tradingStatus?: string | null;
      adjType?: string | null;
    } = {},
  ): Promise<void> {
    await prisma.candle.create({
      data: {
        stockId,
        tradingDay,
        open: close,
        high: close,
        low: close,
        close,
        volume: BigInt(1000),
        visibleAt: opts.visibleAt === undefined ? null : opts.visibleAt,
        datasetVersionId: opts.datasetVersionId === undefined ? null : opts.datasetVersionId,
        tradingStatus: opts.tradingStatus === undefined ? null : opts.tradingStatus,
        adjType: opts.adjType === undefined ? null : opts.adjType,
      },
    });
  }

  // ============ 1. 盘中泄漏 ============
  describe('1. 盘中未来数据泄漏守卫', () => {
    it('盘中 14:00 时当日日线不进入特征；收盘后当日日线可用（行为等价/更严格）', async () => {
      const stockId = 'stk-leak';
      await insertStock('600100', stockId);
      const dPrev = new Date('2026-03-02T00:00:00Z'); // 周一
      const dToday = new Date('2026-03-03T00:00:00Z'); // 周二
      await insertCandle(stockId, dPrev, 10);
      await insertCandle(stockId, dToday, 11); // 无 visibleAt → 回退 15:00+08

      // 盘中 14:00 北京时间 = 06:00Z；dailyCloseVisibleAt(dToday)=07:00Z → 当日未可见
      const asOfIntraday = new Date('2026-03-03T06:00:00Z');
      // 收盘后 16:00 北京时间 = 08:00Z → 当日可见
      const asOfClose = new Date('2026-03-03T08:00:00Z');

      const intraday = await loadRecentCandlesRawSql(prisma, {
        clusterKey: CLUSTER_KEY, asOf: asOfIntraday, stockIds: [stockId],
      }, 30, undefined);
      const closed = await loadRecentCandlesRawSql(prisma, {
        clusterKey: CLUSTER_KEY, asOf: asOfClose, stockIds: [stockId],
      }, 30, undefined);

      expect(intraday.get(stockId)?.map(c => c.tradingDay.toISOString())).not.toContain(dToday.toISOString());
      expect(intraday.get(stockId)?.length).toBe(1); // 仅前一日
      expect(closed.get(stockId)?.map(c => c.tradingDay.toISOString())).toContain(dToday.toISOString());
      expect(closed.get(stockId)?.length).toBe(2);
    });

    it('freshness 在盘中不把当日未收盘日线计入 latestMarketTradingDay', async () => {
      const stockId = 'stk-fresh';
      await insertStock('600101', stockId);
      const dPrev = new Date('2026-03-02T00:00:00Z');
      const dToday = new Date('2026-03-03T00:00:00Z');
      await insertCandle(stockId, dPrev, 10);
      await insertCandle(stockId, dToday, 11);

      const asOfIntraday = new Date('2026-03-03T06:00:00Z');
      const freshness = await loadMarketSignalFreshnessBySymbol(prisma, {
        clusterKey: CLUSTER_KEY, asOf: asOfIntraday, snapshots: [{ symbol: '600101', latestTradingDay: null }],
      }, undefined);
      const f = freshness.get('600101');
      expect(f?.latestMarketTradingDay).toBe('2026-03-02'); // 不是当日
    });
  });

  // ============ 2. visibleAt 缺失回退 15:00 且不放行 ============
  describe('2. visibleAt 缺失回退与显式覆盖', () => {
    it('visibleAt 缺失时回退到 15:00+08 可见性，且不会因字段缺失而放行', async () => {
      const stockId = 'stk-vis';
      await insertStock('600200', stockId);
      const d = new Date('2026-03-03T00:00:00Z');
      await insertCandle(stockId, d, 11, { visibleAt: null }); // 缺失

      // 15:00 之前（14:55 北京时间 = 06:55Z）：回退 15:00 → 不可见
      const before = await readCandles(prisma, {
        clusterKey: CLUSTER_KEY, asOf: new Date('2026-03-03T06:55:00Z'), stockIds: [stockId],
      });
      expect(before.length).toBe(0);

      // 15:00 之后（15:01 北京时间 = 07:01Z）：可见
      const after = await readCandles(prisma, {
        clusterKey: CLUSTER_KEY, asOf: new Date('2026-03-03T07:01:00Z'), stockIds: [stockId],
      });
      expect(after.length).toBe(1);
    });

    it('显式 visibleAt 优先于 15:00 回退', async () => {
      const stockId = 'stk-vis2';
      await insertStock('600201', stockId);
      const d = new Date('2026-03-03T00:00:00Z');
      // 显式可见时间 = 16:00 北京时间 = 08:00Z
      await insertCandle(stockId, d, 11, { visibleAt: new Date('2026-03-03T08:00:00Z') });

      const at1530 = new Date('2026-03-03T07:30:00Z'); // 15:30 北京，早于显式 16:00
      const r1 = await readCandles(prisma, { clusterKey: CLUSTER_KEY, asOf: at1530, stockIds: [stockId] });
      expect(r1.length).toBe(0); // 显式可见时间未到

      const at1601 = new Date('2026-03-03T08:01:00Z');
      const r2 = await readCandles(prisma, { clusterKey: CLUSTER_KEY, asOf: at1601, stockIds: [stockId] });
      expect(r2.length).toBe(1);
    });

    it('isCandleVisibleAsOf / candleVisibleAt 单元行为', () => {
      const d = new Date('2026-03-03T00:00:00Z');
      expect(candleVisibleAt({ tradingDay: d, visibleAt: null }).toISOString()).toBe('2026-03-03T07:00:00.000Z');
      expect(candleVisibleAt({ tradingDay: d, visibleAt: new Date('2026-03-03T08:00:00Z') }).toISOString()).toBe('2026-03-03T08:00:00.000Z');
      expect(isCandleVisibleAsOf({ tradingDay: d, visibleAt: null }, new Date('2026-03-03T06:00:00Z'))).toBe(false);
      expect(isCandleVisibleAsOf({ tradingDay: d, visibleAt: null }, new Date('2026-03-03T08:00:00Z'))).toBe(true);
    });
  });

  // ============ 3. 交易日历版本化 ============
  describe('3. 交易日历版本化与数据缺口', () => {
    async function seed2026Calendar(version: string): Promise<void> {
      for (const h of HOLIDAYS_2026) {
        await prisma.tradingCalendarDay.create({
          data: { exchange: 'SSE', date: new Date(`${h}T00:00:00Z`), isOpen: false, source: 'test', calendarVersion: version },
        });
      }
      for (const t of ['2026-02-24', '2026-02-25', '2026-03-02', '2026-03-03']) {
        await prisma.tradingCalendarDay.create({
          data: { exchange: 'SSE', date: new Date(`${t}T00:00:00Z`), isOpen: true, source: 'test', calendarVersion: version },
        });
      }
    }

    it('2026 年 11 个假期均被识别为非交易日', async () => {
      await seed2026Calendar('test-2026');
      const cal = await VersionedTradingCalendar.load(prisma, { exchange: 'SSE', calendarVersion: 'test-2026' });
      for (const h of HOLIDAYS_2026) {
        expect(cal.isTradingDay(new Date(`${h}T00:00:00Z`))).toBe(false);
      }
      // 相邻真实交易日仍开市
      expect(cal.isTradingDay(new Date('2026-02-24T00:00:00Z'))).toBe(true);
      expect(cal.isTradingDay(new Date('2026-03-03T00:00:00Z'))).toBe(true);
    });

    it('缺覆盖年份返回数据缺口（不按工作日推断）', async () => {
      await seed2026Calendar('test-2026');
      const cal = await VersionedTradingCalendar.load(prisma, { exchange: 'SSE', calendarVersion: 'test-2026' });
      // 2027 不在覆盖范围内
      expect(() => cal.isTradingDay(new Date('2027-01-04T00:00:00Z'))).toThrow(CalendarCoverageGapError);
      expect(cal.resolve(new Date('2027-01-04T00:00:00Z'))).toEqual({ covered: false, isOpen: null });
    });

    it('loadTradingCalendar 默认不回退到工作日推断；仅显式 fallbackToLegacy 才用旧逻辑', async () => {
      // 空覆盖（不 seed）→ 默认版本化返回空日历，任何日期都是缺口
      const empty = await loadTradingCalendar(prisma, { exchange: 'SSE', calendarVersion: 'nope', fallbackToLegacy: false });
      expect(() => empty.isTradingDay(new Date('2026-03-03T00:00:00Z'))).toThrow(CalendarCoverageGapError);

      const legacy = await loadTradingCalendar(prisma, { exchange: 'SSE', calendarVersion: 'nope', fallbackToLegacy: true });
      // 旧逻辑：2026-03-03 周二非假期 → 开市（工作日推断）
      expect(legacy.isTradingDay(new Date('2026-03-03T00:00:00Z'))).toBe(true);
    });
  });

  // ============ 4. 数据集版本固定 ============
  describe('4. 数据集版本固定与恢复沿用', () => {
    it('同一轮读取固定 revision；恢复（显式同 id）沿用同一 revision', async () => {
      const stockId = 'stk-dv';
      await insertStock('600300', stockId);
      const v1 = await prisma.marketDatasetVersion.create({
        data: { source: 'src', asOf: new Date('2026-03-01T00:00:00Z'), revision: 'r1', coverageStart: new Date('2026-03-01T00:00:00Z'), coverageEnd: new Date('2026-03-03T00:00:00Z') },
      });
      const v2 = await prisma.marketDatasetVersion.create({
        data: { source: 'src', asOf: new Date('2026-03-01T00:00:00Z'), revision: 'r2', coverageStart: new Date('2026-03-01T00:00:00Z'), coverageEnd: new Date('2026-03-03T00:00:00Z') },
      });
      const d1 = new Date('2026-03-02T00:00:00Z');
      const d2 = new Date('2026-03-03T00:00:00Z');
      await insertCandle(stockId, d1, 10, { datasetVersionId: v1.id });
      await insertCandle(stockId, d2, 11, { datasetVersionId: v2.id });

      const r1 = new DatasetVersionResolver(v1.id);
      expect(await r1.resolve(prisma)).toBe(v1.id);
      expect(await r1.resolve(prisma)).toBe(v1.id); // 固定/缓存

      // 恢复：用同一显式 id 新建 resolver，仍得到 v1
      const resumed = new DatasetVersionResolver(v1.id);
      expect(await resumed.resolve(prisma)).toBe(v1.id);

      const onlyV1 = await readCandles(prisma, { clusterKey: CLUSTER_KEY, asOf: new Date('2026-03-04T08:00:00Z'), stockIds: [stockId], datasetVersionId: v1.id });
      expect(onlyV1.length).toBe(1);
      expect(onlyV1[0].tradingDay.toISOString()).toBe(d1.toISOString());

      // 默认路径：取最新版本（v2）
      const def = new DatasetVersionResolver();
      expect(await def.resolve(prisma)).toBe(v2.id);
    });
  });

  // ============ 5. JSONL 导入与未知字段 ============
  describe('5. JSONL 导入与未知字段标为未知', () => {
    it('缺失字段标为未知（null）且不被填充；写入 MarketDatasetVersion 与校验和', async () => {
      await insertStock('600400', 'stk-j1');
      await insertStock('600401', 'stk-j2');
      const jsonl = [
        JSON.stringify({ stockId: 'stk-j1', tradingDay: '2026-03-02T00:00:00Z', open: 10, high: 11, low: 9, close: 10, volume: 1000, adjType: 'hfq', tradingStatus: 'NORMAL' }),
        JSON.stringify({ stockId: 'stk-j2', tradingDay: '2026-03-03T00:00:00Z', open: 10, high: 11, low: 9, close: 11, volume: 1000 }), // 缺 tradingStatus/limit/adjType
      ].join('\n');
      const file = join(tmpdir(), `m5-jsonl-${Date.now()}.jsonl`);
      writeFileSync(file, jsonl);

      const report = await importMarketDatasetFromJsonl(prisma, {
        filePath: file, source: 'jsonl-test', asOf: new Date('2026-03-03T08:00:00Z'),
      });

      expect(report.recordCount).toBe(2);
      expect(report.representation).toBe('null-means-unknown');
      expect(report.unknownFieldCounts.adjType).toBe(1);
      expect(report.unknownFieldCounts.tradingStatus).toBe(1);
      expect(report.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(report.coverageStart).not.toBeNull();

      // 缺字段的 candle 落地为 null，未被推测填充
      const candle = await prisma.candle.findFirst({ where: { stockId: 'stk-j2' } });
      expect(candle?.tradingStatus).toBeNull();
      expect(candle?.adjType).toBeNull();
      expect(candle?.limitUpPrice).toBeNull();

      const version = await prisma.marketDatasetVersion.findFirst({ where: { id: report.versionId } });
      expect(version?.checksum).toBe(report.checksum);
      expect(version?.coverageEnd).not.toBeNull();
    });

    it('importMarketDataset 显式字段标记未知', async () => {
      await insertStock('600402', 'stk-j3');
      const report = await importMarketDataset(prisma, {
        source: 'raw', asOf: new Date('2026-03-03T08:00:00Z'),
        records: [{ stockId: 'stk-j3', tradingDay: new Date('2026-03-03T00:00:00Z'), open: 1, high: 1, low: 1, close: 1, volume: 1 }],
        writeCandles: true,
      });
      expect(report.unknownFieldCounts.adjType).toBe(1);
      expect(report.unknownFieldCounts.tradingStatus).toBe(1);
    });
  });

  // ============ 6. 前复权未校验拒绝 ============
  describe('6. 前复权旧数据在严格回测路径被拒绝', () => {
    it('adjType=qfq（前复权）或未指定 → 严格回测抛错', async () => {
      await insertStock('600500', 'stk-q1');
      await insertStock('600501', 'stk-q2');
      const qfq = await importMarketDataset(prisma, {
        source: 'qfq', asOf: new Date('2026-03-03T08:00:00Z'),
        records: [{ stockId: 'stk-q1', tradingDay: new Date('2026-03-03T00:00:00Z'), open: 1, high: 1, low: 1, close: 1, volume: 1, adjType: 'qfq' }],
      });
      expect(() => assertStrictBacktestAllowed(qfq)).toThrow(StrictBacktestRejectedError);

      const unknown = await importMarketDataset(prisma, {
        source: 'unknown', asOf: new Date('2026-03-03T08:00:00Z'),
        records: [{ stockId: 'stk-q2', tradingDay: new Date('2026-03-03T00:00:00Z'), open: 1, high: 1, low: 1, close: 1, volume: 1 }],
      });
      expect(() => assertStrictBacktestAllowed(unknown)).toThrow(StrictBacktestRejectedError);
    });

    it('adjType=hfq（后复权）通过严格校验', async () => {
      await insertStock('600502', 'stk-q3');
      const hfq = await importMarketDataset(prisma, {
        source: 'hfq', asOf: new Date('2026-03-03T08:00:00Z'),
        records: [{ stockId: 'stk-q3', tradingDay: new Date('2026-03-03T00:00:00Z'), open: 1, high: 1, low: 1, close: 1, volume: 1, adjType: 'hfq', tradingStatus: 'NORMAL' }],
      });
      expect(() => assertStrictBacktestAllowed(hfq)).not.toThrow();
    });
  });

  // ============ 7. 股票历史状态数据缺口 ============
  describe('7. 股票历史状态按 asOf 解析与数据缺口', () => {
    it('无适用历史状态记录 → 返回数据缺口，不套用当前名单', async () => {
      await expect(resolveStockStatusAsOf(prisma, 'NOPE', new Date('2026-03-03T00:00:00Z')))
        .rejects.toThrow(StockStatusCoverageGapError);
    });

    it('返回 asOf 所属历史区间的状态；不把未来记录套到过去', async () => {
      await prisma.stockStatusHistory.create({
        data: { symbol: '600600', effectiveFrom: new Date('2026-01-01T00:00:00Z'), isST: false, industry: '银行', source: 'test' },
      });
      await prisma.stockStatusHistory.create({
        data: { symbol: '600600', effectiveFrom: new Date('2026-06-01T00:00:00Z'), isST: true, industry: '保险', source: 'test' },
      });

      const atMar = await resolveStockStatusAsOf(prisma, '600600', new Date('2026-03-03T00:00:00Z'));
      expect(atMar.isST).toBe(false);
      expect(atMar.industry).toBe('银行'); // 用 1 月记录，而非 6 月未来记录

      const atJul = await resolveStockStatusAsOf(prisma, '600600', new Date('2026-07-01T00:00:00Z'));
      expect(atJul.isST).toBe(true);
      expect(atJul.industry).toBe('保险');
    });
  });

  // ============ 8. 收益与对账 ============
  describe('8. 收益分别记录与 marginAfter 不回退 now', () => {
    it('futureCandles 不足 5 日时 5 日收益不成熟、不被短周期填充', () => {
      const drafts = buildYieldRecordDrafts({
        snapshotId: 'snap-1', symbol: '600700', p0: 10,
        futureCandles: [
          { tradingDay: new Date('2026-03-04T00:00:00Z'), close: 11, tradingStatus: 'NORMAL' },
          { tradingDay: new Date('2026-03-05T00:00:00Z'), close: 12, tradingStatus: 'NORMAL' },
          { tradingDay: new Date('2026-03-06T00:00:00Z'), close: 13, tradingStatus: 'NORMAL' },
        ],
        computeVersion: YIELD_COMPUTE_VERSION,
        maturityReferenceTime: new Date('2026-03-10T00:00:00Z'),
      });
      const h1 = drafts.find(d => d.horizon === 1)!;
      const h3 = drafts.find(d => d.horizon === 3)!;
      const h5 = drafts.find(d => d.horizon === 5)!;
      expect(h1.value).toBeCloseTo(0.1);
      expect(h3.value).toBeCloseTo(0.3);
      expect(h5.value).toBeNull(); // 不被 3 日填充
      expect(h5.status).toBe('immature');
    });

    it('缺失交易状态 → 该周期 status=coverage_gap，actualExitDay=null（不默认成交）', () => {
      const drafts = buildYieldRecordDrafts({
        snapshotId: 'snap-2', symbol: '600701', p0: 10,
        futureCandles: [
          { tradingDay: new Date('2026-03-04T00:00:00Z'), close: 11, tradingStatus: null },
          { tradingDay: new Date('2026-03-05T00:00:00Z'), close: 12, tradingStatus: 'NORMAL' },
          { tradingDay: new Date('2026-03-06T00:00:00Z'), close: 13, tradingStatus: 'LIMIT_UP' },
          { tradingDay: new Date('2026-03-09T00:00:00Z'), close: 14, tradingStatus: 'NORMAL' },
          { tradingDay: new Date('2026-03-10T00:00:00Z'), close: 15, tradingStatus: 'NORMAL' },
        ],
        computeVersion: YIELD_COMPUTE_VERSION,
        maturityReferenceTime: new Date('2026-03-20T00:00:00Z'),
      });
      const h1 = drafts.find(d => d.horizon === 1)!;
      expect(h1.status).toBe('coverage_gap');
      expect(h1.actualExitDay).toBeNull();
      const h3 = drafts.find(d => d.horizon === 3)!;
      expect(h3.status).toBe('pending'); // 涨停受限
      expect(h3.actualExitDay).toBeNull();
      const h5 = drafts.find(d => d.horizon === 5)!;
      expect(h5.value).toBeCloseTo(0.5);
      expect(h5.status).toBe('mature');
    });

    it('YieldRecord 落库：1/3/5 分别记录，5 日不成熟时 value 为 null', async () => {
      const snap = await prisma.recommendationSnapshot.create({
        data: { traceId: 't-yield', asOf: new Date('2026-03-03T00:00:00Z'), clusterKey: CLUSTER_KEY, rank: 1, symbol: '600702', stockName: 'X', industry: 'Y', finalScore: 1, reasons: [], scoreBreakdown: {} },
      });
      const drafts = buildYieldRecordDrafts({
        snapshotId: snap.id, symbol: '600702', p0: 10,
        futureCandles: [
          { tradingDay: new Date('2026-03-04T00:00:00Z'), close: 11, tradingStatus: 'NORMAL' },
          { tradingDay: new Date('2026-03-05T00:00:00Z'), close: 12, tradingStatus: 'NORMAL' },
          { tradingDay: new Date('2026-03-06T00:00:00Z'), close: 13, tradingStatus: 'NORMAL' },
        ],
        computeVersion: YIELD_COMPUTE_VERSION,
        maturityReferenceTime: new Date('2026-03-10T00:00:00Z'),
      });
      for (const d of drafts) {
        await prisma.yieldRecord.upsert({
          where: { snapshotId_symbol_horizon_computeVersion: { snapshotId: d.snapshotId, symbol: d.symbol, horizon: d.horizon, computeVersion: d.computeVersion } },
          create: d,
          update: { value: d.value, status: d.status, plannedExitDay: d.plannedExitDay, actualExitDay: d.actualExitDay, maturityAt: d.maturityAt },
        });
      }
      const rows = await prisma.yieldRecord.findMany({ where: { snapshotId: snap.id }, orderBy: { horizon: 'asc' } });
      expect(rows.length).toBe(3);
      expect(rows[0].horizon).toBe(1);
      expect(rows[2].horizon).toBe(5);
      expect(rows[2].value).toBeNull();
      expect(rows[2].status).toBe('immature');
    });

    it('computeMarginWindow：以 asOf 为基准 + 固定 20 天窗口，绝不回退到 now', () => {
      const asOf = new Date('2026-03-03T08:00:00Z');
      const { marginBefore, marginAfter } = computeMarginWindow(asOf);
      expect(marginAfter.getTime()).toBe(asOf.getTime() + 20 * 24 * 60 * 60 * 1000);
      expect(marginBefore.getTime()).toBe(asOf.getTime() - 30 * 24 * 60 * 60 * 1000);
      // 关键：marginAfter 不依赖 now，且恒等于 asOf+20d（即便 now 远在其后）
      const now = new Date();
      expect(marginAfter.getTime()).not.toBe(now.getTime());
    });

    it('盘中运行不纳入尚未可见的收盘价（可见性过滤独立于 marginAfter）', async () => {
      const stockId = 'stk-intraday';
      await insertStock('600703', stockId);
      const dToday = new Date('2026-03-03T00:00:00Z');
      await insertCandle(stockId, dToday, 11); // 无 visibleAt
      // asOf 盘中：marginAfter = asOf+20d，但当日 15:00 前仍不可见
      const asOf = new Date('2026-03-03T06:00:00Z');
      const rows = await readCandles(prisma, { clusterKey: CLUSTER_KEY, asOf, stockIds: [stockId] });
      expect(rows.length).toBe(0);
    });
  });

  // ============ 9. 行情准入模式（默认 permissive / 显式 strict） ============
  describe('9. 复权口径准入：默认 permissive 记录缺口，strict 显式拒绝', () => {
    it('readCandles 回传 tradingStatus/adjType，并同时施加 SQL 与 JS 可见性过滤', async () => {
      const stockId = 'stk-adj-visible';
      await insertStock('600800', stockId);
      const d = new Date('2026-03-03T00:00:00Z');
      await insertCandle(stockId, d, 11, { visibleAt: null, tradingStatus: 'NORMAL', adjType: 'hfq' });

      const hiddenId = 'stk-adj-hidden';
      await insertStock('600801', hiddenId);
      await insertCandle(hiddenId, d, 12, { visibleAt: new Date('2026-03-05T00:00:00Z'), adjType: 'qfq' });

      const asOf = new Date('2026-03-03T07:01:00Z'); // 15:01 北京，当日已收盘可见
      const rows = await readCandles(prisma, {
        clusterKey: CLUSTER_KEY,
        asOf,
        stockIds: [stockId, hiddenId],
      });
      expect(rows.map(row => row.stockId)).toEqual([stockId]);
      expect(rows[0].tradingStatus).toBe('NORMAL');
      expect(rows[0].adjType).toBe('hfq');
    });

    it('默认 permissive 只记录 unknown adjType 计数；strict 与行级校验显式拒绝', async () => {
      const stockId = 'stk-adj-gap';
      await insertStock('600802', stockId);
      const d = new Date('2026-03-03T00:00:00Z');
      await insertCandle(stockId, d, 11, { adjType: null }); // 生产现状：adjType 未知

      const asOf = new Date('2026-03-03T07:01:00Z');
      const admissionWindow = {
        clusterKey: CLUSTER_KEY,
        fromTradingDay: new Date('2026-03-01T00:00:00Z'),
        toTradingDay: new Date('2026-03-10T00:00:00Z'),
      };

      const permissive = await collectMarketDataAdmission(prisma, admissionWindow);
      expect(permissive.mode).toBe('permissive');
      expect(permissive.unknownAdjTypeCount).toBe(1);

      await expect(collectMarketDataAdmission(prisma, admissionWindow, { strict: true }))
        .rejects.toThrow(StrictBacktestRejectedError);

      const rows = await readCandles(prisma, { clusterKey: CLUSTER_KEY, asOf, stockIds: [stockId] });
      expect(rows.length).toBe(1);
      expect(rows[0].adjType).toBeNull();
      expect(() => assertStrictMarketDataAdmission(rows)).toThrow(StrictBacktestRejectedError);
    });
  });
});
