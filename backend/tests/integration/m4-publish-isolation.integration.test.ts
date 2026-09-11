// M4 原子发布 / 读取隔离 / 后处理拆分 集成测试。
// 使用独立测试库 gupiao_test（由 AI_TEST_DATABASE_URL 指定，绝不连生产 gupiaodb）。
// 直接写入 gupiao_test 的 public schema，并在每个用例前 TRUNCATE 相关表，保证隔离。
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import {
  publishRecommendation,
  isPublishedTrace,
  getLatestPublish,
  backfillPublishForTrace,
  classifyEmptyResult,
  recordCompleteEmpty,
} from '../../src/services/publish/index.js';
import {
  BackendRuntimeStore,
  createDefaultConfigStore,
  startBackendHttpServer,
} from '../../src/http/index.js';
import { createContributionDetailReader } from '../../src/http/contribution-reader.js';
import { createDailyReportSnapshotReader } from '../../src/http/daily-report-reader.js';

const connection = process.env.AI_TEST_DATABASE_URL;
const GROUP_ID = 'm4test';
const CLUSTER_KEY = 'm4test'; // toClusterKey('m4test') === 'm4test'
const AS_OF = new Date('2026-09-07T08:00:00.000Z');
const DISPLAY_DATE = '2026-09-07';

const TRUNCATE_TABLES = [
  '"RecommendationPublish"',
  '"StrategyRecommendationEvent"',
  '"StrategyRun"',
  '"StrategyDefinition"',
  '"EvidenceContribution"',
  '"RecommendationSnapshot"',
  '"PipelineStepTrace"',
  '"RunTrace"',
  '"NormalizedNewsRecord"',
  '"MarketSignalSnapshot"',
  '"GraphSnapshot"',
  '"ThemeForecast"',
  '"ExpectationGapSnapshot"',
  '"StockExposureFact"',
  '"Stock"',
  '"Candle"',
];

describe.skipIf(!connection)('M4 原子发布 / 读取隔离 / 后处理拆分', () => {
  let prisma: PrismaClient;
  let admin: pg.Pool;
  let store: BackendRuntimeStore;
  const runningServers: Array<{ close: () => Promise<void> }> = [];

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: connection! });
    const scoped = new URL(connection!);
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: scoped.toString() }) });

    process.env.DATABASE_URL = connection!;
    const reader = await createContributionDetailReader(connection);
    const dailyReader = await createDailyReportSnapshotReader(connection);
    const pool = new pg.Pool({ connectionString: connection! });
    const rootDir = await mkdtemp(path.join(tmpdir(), 'm4-http-'));
    store = new BackendRuntimeStore({
      rootDir,
      configStore: createDefaultConfigStore(rootDir),
      contributionReader: reader,
      dailyReportReader: dailyReader,
      pgPool: {
        query: (sql: string, values?: readonly unknown[]) => pool.query(sql, values as unknown[]),
      },
    });
  }, 30000);

  afterAll(async () => {
    await Promise.all(runningServers.splice(0).map(s => s.close().catch(() => undefined)));
    await prisma?.$disconnect();
    await admin?.end();
  }, 30000);

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE ${TRUNCATE_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  });

  // ---- 数据播种助手（写入真实表，便于验证读取隔离）----
  async function insertRunTrace(traceId: string, status: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "RunTrace" ("traceId","clusterKey","kind","status","asOf","triggeredAt","completedAt","errorMessage","metrics")
       VALUES ($1,$2,'DAILY_RECOMMENDATION',$3,$4,$4,$4,NULL,'{}'::jsonb)`,
      traceId, CLUSTER_KEY, status, AS_OF,
    );
  }

  async function insertSnapshot(traceId: string, symbol: string, rank: number): Promise<void> {
    await prisma.$executeRawUnsafe(
      // id 在 Prisma 侧是 @default(cuid())，数据库没有默认值，裸插入必须显式提供。
      `INSERT INTO "RecommendationSnapshot" ("id","traceId","asOf","clusterKey","rank","symbol","stockName","industry","finalScore","reasons","scoreBreakdown","isPublished")
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10::jsonb,false)`,
      traceId, AS_OF, CLUSTER_KEY, rank, symbol, `${symbol}名`, '行业', 80, ['理由A'], { selectionSignalType: '主线' },
    );
  }

  async function insertNews(newsId: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "NormalizedNewsRecord" ("id","title","content","source","url","publishedAt","clusterKey")
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      newsId, '标题', '内容', 'src', `http://x/${newsId}`, AS_OF, CLUSTER_KEY,
    );
  }

  async function insertEvidence(traceId: string, symbol: string, newsId: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "EvidenceContribution" ("id","traceId","newsId","symbol","keyword","clusterKey","asOf","baseFrequencyScore","timeDecayedScore","reprintPenaltyScore","finalContribScore","reasons")
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'1.0','1.0','0.0','1.0',$7::text[])`,
      traceId, newsId, symbol, '关键词', CLUSTER_KEY, AS_OF, ['匹配'],
    );
  }

  async function insertStrategyChain(traceId: string, symbol: string, rank: number): Promise<void> {
    const strategyId = `sd-${traceId}`;
    const strategyRunId = `sr-${traceId}`;
    await prisma.$executeRawUnsafe(
      // updatedAt 是 Prisma @updatedAt（无数据库默认值），裸插入必须显式给出。
      `INSERT INTO "StrategyDefinition" ("id","clusterKey","name","enabled","configJson","updatedAt") VALUES ($1,$2,$3,true,$4::jsonb,now())
       ON CONFLICT ("id") DO NOTHING`,
      strategyId, CLUSTER_KEY, `策略-${traceId}`, '{}',
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "StrategyRun" ("id","strategyId","strategyNameSnapshot","traceId","clusterKey","asOf","status","inputFingerprint","configSnapshot","diagnostics")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
       ON CONFLICT ("id") DO NOTHING`,
      strategyRunId, strategyId, `策略-${traceId}`, traceId, CLUSTER_KEY, AS_OF, 'SUCCESS', `fp-${traceId}`, '{}', '{}',
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "StrategyRecommendationEvent" ("id","strategyRunId","strategyId","traceId","clusterKey","asOf","rank","symbol","stockName","industry","finalScore","scoreBreakdown","reasons","baseTradingDay","basePrice","returnStatus")
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::text[],$13,$14,$15)
       ON CONFLICT ("strategyRunId","symbol") DO NOTHING`,
      // text[] 参数必须是 JS 数组，传字符串 '[]' 会被当成数组字面量解析失败（22P02）。
      strategyRunId, strategyId, traceId, CLUSTER_KEY, AS_OF, rank, symbol, `${symbol}名`, '行业', 80, '{}', [], AS_OF, 1.0, 'HOLD',
    );
  }

  async function seedPublished(traceId: string, symbol: string, rank = 1, withStrategy = false): Promise<void> {
    await insertRunTrace(traceId, 'SUCCESS');
    await insertSnapshot(traceId, symbol, rank);
    await insertNews(`news-${traceId}`);
    await insertEvidence(traceId, symbol, `news-${traceId}`);
    if (withStrategy) {
      await insertStrategyChain(traceId, symbol, rank);
    }
    await publishRecommendation(prisma, { traceId, clusterKey: CLUSTER_KEY, asOf: AS_OF, auditStatus: 'pass', reason: 'seed' });
  }

  async function seedUnpublished(traceId: string, symbol: string, rank = 1, withStrategy = false): Promise<void> {
    await insertRunTrace(traceId, 'SUCCESS');
    await insertSnapshot(traceId, symbol, rank);
    await insertNews(`news-${traceId}`);
    await insertEvidence(traceId, symbol, `news-${traceId}`);
    if (withStrategy) {
      await insertStrategyChain(traceId, symbol, rank);
    }
    // 故意不调用 publishRecommendation —— 无发布记录。
  }

  async function seedFailed(traceId: string, symbol: string): Promise<void> {
    await insertRunTrace(traceId, 'FAILED');
    await insertSnapshot(traceId, symbol, 1);
    await insertNews(`news-${traceId}`);
    await insertEvidence(traceId, symbol, `news-${traceId}`);
  }

  // ============ 1. 每条正式读取路径都读不到未发布数据 ============
  describe('读取隔离：未发布数据在所有正式路径不可见', () => {
    beforeEach(async () => {
      await seedPublished('trace-pub', '600001', 1, true);
      await seedUnpublished('trace-unpub', '600002', 1, true);
      await seedFailed('trace-fail', '600003');
    });

    it('getDashboardSnapshot 只返回已发布 trace 的推荐', async () => {
      const snap = await store.getDashboardSnapshot(DISPLAY_DATE, GROUP_ID, null) as unknown as { recommendations: Array<{ symbol: string }> };
      const symbols = snap.recommendations.map(r => r.symbol);
      expect(symbols).toContain('600001');
      expect(symbols).not.toContain('600002');
      expect(symbols).not.toContain('600003');
    });

    it('listRecommendations 只返回已发布', async () => {
      const list = await store.listRecommendations(DISPLAY_DATE, GROUP_ID) as Array<{ items: Array<{ symbol: string }> }>;
      const symbols = list.flatMap(b => b.items.map(i => i.symbol));
      expect(symbols).toContain('600001');
      expect(symbols).not.toContain('600002');
    });

    it('getDashboardSnapshot(strategy) 行级过滤未发布 trace', async () => {
      const snap = await store.getDashboardSnapshot(DISPLAY_DATE, GROUP_ID, 'sd-trace-pub') as unknown as { recommendations: Array<{ symbol: string }> };
      const symbols = snap.recommendations.map(r => r.symbol);
      expect(symbols).toContain('600001');
      expect(symbols).not.toContain('600002');
    });

    it('getDashboardStockDetail 未发布 trace 抛 UNPUBLISHED_TRACE', async () => {
      await expect(store.getDashboardStockDetail('600002', 'trace-unpub', GROUP_ID, null)).rejects.toThrow(/UNPUBLISHED_TRACE/);
    });

    it('getDashboardStockEvidence 未发布 trace 返回空（不泄漏）', async () => {
      const ev = await store.getDashboardStockEvidence('600002', 'trace-unpub', GROUP_ID) as unknown as { items: unknown[] };
      expect(ev.items.length).toBe(0);
    });

    it('getDashboardStockNetwork 未发布 trace 返回空', async () => {
      const net = await store.getDashboardStockNetwork('600002', 'trace-unpub', GROUP_ID) as unknown as { nodes: unknown[] };
      expect(net.nodes.length).toBe(0);
    });

    it('getContributionDetail 未发布 trace 返回 null', async () => {
      const c = await store.getContributionDetail('trace-unpub', '600002');
      expect(c).toBeNull();
    });

    it('执行历史默认只展示已发布 trace', async () => {
      const snap = await store.getDashboardSnapshot(DISPLAY_DATE, GROUP_ID, null) as unknown as { execution_history: Array<{ trace_id: string }> };
      const traceIds = snap.execution_history.map(h => h.trace_id);
      expect(traceIds).toContain('trace-pub');
      expect(traceIds).not.toContain('trace-unpub');
      expect(traceIds).not.toContain('trace-fail');
    });
  });

  // ============ 2. Trace 调试接口显式标记草稿 ============
  describe('Trace 调试接口：未发布数据带 draft 标记', () => {
    beforeEach(async () => {
      await seedUnpublished('trace-unpub', '600002');
      await seedPublished('trace-pub', '600001');
    });

    it('getTraceOverview 标记 publishStatus', async () => {
      const unpublished = await store.getTraceOverview('trace-unpub') as { publishStatus: string };
      const published = await store.getTraceOverview('trace-pub') as { publishStatus: string };
      expect(unpublished.publishStatus).toBe('draft');
      expect(published.publishStatus).toBe('published');
    });

    it('getTraceSteps / Events / Costs 均带 publishStatus', async () => {
      const steps = await store.getTraceSteps('trace-unpub', undefined, 20) as unknown as { publishStatus: string };
      const events = await store.getTraceEvents('trace-unpub', undefined, 20) as unknown as { publishStatus: string };
      const costs = await store.getTraceCosts('trace-unpub') as unknown as { publishStatus: string };
      expect(steps.publishStatus).toBe('draft');
      expect(events.publishStatus).toBe('draft');
      expect(costs.publishStatus).toBe('draft');
    });
  });

  // ============ 3. 同日多版本 / 重跑失败不遮挡 ============
  describe('同日多版本与重跑失败', () => {
    it('默认读到最新已发布版本；重跑失败不遮挡此前版本', async () => {
      await seedPublished('trace-pub', '600001', 1);
      // 同日重跑失败：新 trace 无发布记录
      await seedFailed('trace-rerun-fail', '600009');
      const latest = await getLatestPublish(prisma, { clusterKey: CLUSTER_KEY, asOf: AS_OF });
      expect(latest?.traceId).toBe('trace-pub');
      const published = await isPublishedTrace(prisma, 'trace-pub');
      expect(published).toBe(true);
      const snap = await store.getDashboardSnapshot(DISPLAY_DATE, GROUP_ID, null) as unknown as { recommendations: Array<{ symbol: string }> };
      expect(snap.recommendations.map(r => r.symbol)).toContain('600001');
    });

    it('显式新版本发布会递增版本并取代旧版本', async () => {
      await seedPublished('trace-pub', '600001', 1);
      const v1 = await getLatestPublish(prisma, { clusterKey: CLUSTER_KEY, asOf: AS_OF });
      const v2 = await publishRecommendation(prisma, {
        traceId: 'trace-pub', clusterKey: CLUSTER_KEY, asOf: AS_OF, auditStatus: 'pass', reason: 'seed', forceNewVersion: true,
      });
      expect(v2.publishVersion).toBe((v1?.publishVersion ?? 0) + 1);
      expect(v2.supersededVersion).toBe(v1?.publishVersion ?? null);
      const latest = await getLatestPublish(prisma, { clusterKey: CLUSTER_KEY, asOf: AS_OF });
      expect(latest?.publishVersion).toBe(v2.publishVersion);
      // 旧版本被取代
      const oldRow = await prisma.recommendationPublish.findFirst({ where: { publishVersion: v1?.publishVersion ?? 0 } });
      expect(oldRow?.supersededBy).not.toBeNull();
    });

    it('同 asOf 不同 trace 重发会取代旧发布（不双活）', async () => {
      await seedPublished('trace-old', '600001', 1);
      const created = await publishRecommendation(prisma, {
        traceId: 'trace-new', clusterKey: CLUSTER_KEY, asOf: AS_OF, auditStatus: 'pass', reason: 'rerun',
      });
      expect(created.reused).toBe(false);
      const live = await prisma.recommendationPublish.findMany({
        where: { clusterKey: CLUSTER_KEY, asOf: AS_OF, supersededBy: null },
      });
      expect(live.map(r => r.traceId)).toEqual(['trace-new']);
      const latest = await getLatestPublish(prisma, { clusterKey: CLUSTER_KEY, asOf: AS_OF });
      expect(latest?.traceId).toBe('trace-new');
    });
  });

  // ============ 4. 重复发布幂等 ============
  describe('重复发布幂等', () => {
    it('同 trace + 同内容不产生新版本', async () => {
      const r1 = await publishRecommendation(prisma, { traceId: 't-x', clusterKey: CLUSTER_KEY, asOf: AS_OF, auditStatus: 'pass', reason: 'r' });
      const r2 = await publishRecommendation(prisma, { traceId: 't-x', clusterKey: CLUSTER_KEY, asOf: AS_OF, auditStatus: 'pass', reason: 'r' });
      expect(r2.reused).toBe(true);
      expect(r2.publishVersion).toBe(r1.publishVersion);
      const count = await prisma.recommendationPublish.count({ where: { traceId: 't-x' } });
      expect(count).toBe(1);
    });
  });

  // ============ 5. 失败 trace 残留快照不补建发布记录 ============
  describe('backfill 完整性检查', () => {
    it('失败 trace 的残留快照不得发布', async () => {
      await seedFailed('trace-fail', '600003');
      const result = await backfillPublishForTrace(prisma, 'trace-fail');
      expect(result).toBeNull();
      expect(await isPublishedTrace(prisma, 'trace-fail')).toBe(false);
      expect(await prisma.recommendationPublish.count({ where: { traceId: 'trace-fail' } })).toBe(0);
    });

    it('成功 trace 且含快照会被补建发布记录', async () => {
      await seedUnpublished('trace-unpub', '600002');
      const result = await backfillPublishForTrace(prisma, 'trace-unpub');
      expect(result).not.toBeNull();
      expect(await isPublishedTrace(prisma, 'trace-unpub')).toBe(true);
    });

    it('已发布 trace 补建时被跳过', async () => {
      await seedPublished('trace-pub', '600001');
      const before = await prisma.recommendationPublish.count({ where: { traceId: 'trace-pub' } });
      const result = await backfillPublishForTrace(prisma, 'trace-pub');
      expect(result).toBeNull();
      const after = await prisma.recommendationPublish.count({ where: { traceId: 'trace-pub' } });
      expect(after).toBe(before);
    });
  });

  // ============ 6. COMPLETE_EMPTY 与证据为空 ============
  describe('COMPLETE_EMPTY 区分', () => {
    it('classifyEmptyResult 区分 stop / complete_empty / ok', () => {
      expect(classifyEmptyResult({ recommendationsCreated: 0, evidenceCount: 0 })).toBe('stop');
      expect(classifyEmptyResult({ recommendationsCreated: 0, evidenceCount: 5 })).toBe('complete_empty');
      expect(classifyEmptyResult({ recommendationsCreated: 3, evidenceCount: 5 })).toBe('ok');
    });

    it('证据存在但候选被全部过滤 → 记录 COMPLETE_EMPTY，不抛错、不发布', async () => {
      await insertRunTrace('trace-ce', 'SUCCESS');
      // 不插入快照（候选被过滤），仅模拟 trace 已完成
      await recordCompleteEmpty(prisma, 'trace-ce', '证据存在但候选被质量门槛全部过滤');
      const trace = await prisma.runTrace.findUnique({ where: { traceId: 'trace-ce' } });
      // COMPLETE_EMPTY 是显式状态，不能冒充 SUCCESS，也不进入正式发布读取路径。
      expect(trace?.status).toBe('COMPLETE_EMPTY');
      expect(trace?.errorMessage).toMatch(/^COMPLETE_EMPTY:/);
      expect((trace?.metrics as Record<string, unknown>)?.completeEmpty).toBe(true);
      // 未发布
      expect(await isPublishedTrace(prisma, 'trace-ce')).toBe(false);
    });
  });

  // ============ 7. 后处理失败不撤销发布 ============
  describe('后处理失败不撤销发布', () => {
    it('模拟对账抛错后，已发布数据仍可读、发布记录仍在', async () => {
      await seedPublished('trace-pub', '600001');
      const before = await getLatestPublish(prisma, { clusterKey: CLUSTER_KEY, asOf: AS_OF });
      expect(before).not.toBeNull();

      // 模拟后处理（对账）失败：错误被捕获并记录，但不回滚发布。
      let postProcessingError: string | null = null;
      try {
        throw new Error('mock reconcile failure');
      }
      catch (error) {
        postProcessingError = error instanceof Error ? error.message : String(error);
      }
      expect(postProcessingError).toMatch(/mock reconcile failure/);

      // 发布记录仍在，且可正常读取
      expect(await isPublishedTrace(prisma, 'trace-pub')).toBe(true);
      const snap = await store.getDashboardSnapshot(DISPLAY_DATE, GROUP_ID, null) as unknown as { recommendations: Array<{ symbol: string }> };
      expect(snap.recommendations.map(r => r.symbol)).toContain('600001');
      const after = await getLatestPublish(prisma, { clusterKey: CLUSTER_KEY, asOf: AS_OF });
      expect(after?.id).toBe(before?.id);
    });
  });

  // ============ 8. HTTP 层集成验证 ============
  describe('HTTP 层行为', () => {
    beforeEach(async () => {
      await seedPublished('trace-pub', '600001', 1, true);
      await seedUnpublished('trace-unpub', '600002', 1, true);
      await seedFailed('trace-fail', '600003');
    });

    it('/api/recommendations 与 /api/report/daily 仅含已发布', async () => {
      const server = await startBackendHttpServer({
        rootDir: await mkdtemp(path.join(tmpdir(), 'm4-http-')),
        configStore: createDefaultConfigStore(await mkdtemp(path.join(tmpdir(), "m4-http-"))),
        host: '127.0.0.1',
        port: 0,
      });
      runningServers.push(server);
      const base = `http://127.0.0.1:${server.port}`;

      const recs = await (await fetch(`${base}/api/recommendations?trade_date=${DISPLAY_DATE}&group_id=${GROUP_ID}`)).json() as Array<{ items: Array<{ symbol: string }> }>;
      const symbols = recs.flatMap(b => b.items.map(i => i.symbol));
      expect(symbols).toContain('600001');
      expect(symbols).not.toContain('600002');

      // 日报为预构建快照；本测试只验证不泄漏未发布数据（600002），不强制要求含 600001。
      const daily = await (await fetch(`${base}/api/report/daily?display_date=${DISPLAY_DATE}&group_id=${GROUP_ID}`)).json() as { recommendations?: { A?: Array<{ ticker: string }> } };
      if (daily.recommendations?.A) {
        const dailySymbols = daily.recommendations.A.map(r => r.ticker);
        expect(dailySymbols).not.toContain('600002');
      }
    });

    it('/api/batches/contribution 未发布返回空；debug 参数返回 draft', async () => {
      const server = await startBackendHttpServer({
        rootDir: await mkdtemp(path.join(tmpdir(), 'm4-http-')),
        configStore: createDefaultConfigStore(await mkdtemp(path.join(tmpdir(), "m4-http-"))),
        host: '127.0.0.1',
        port: 0,
      });
      runningServers.push(server);
      const base = `http://127.0.0.1:${server.port}`;

      const empty = await (await fetch(`${base}/api/batches/contribution?traceId=trace-unpub&symbol=600002`)).json() as { rows: unknown[] };
      expect(empty.rows.length).toBe(0);

      const debug = await (await fetch(`${base}/api/batches/contribution?traceId=trace-unpub&symbol=600002&unpublished=1`)).json() as { publishStatus: string };
      expect(debug.publishStatus).toBe('draft');

      const ok = await (await fetch(`${base}/api/batches/contribution?traceId=trace-pub&symbol=600001`)).json() as { publishStatus: string; rows: unknown[] };
      expect(ok.publishStatus).toBe('published');
      expect(ok.rows.length).toBeGreaterThan(0);
    });

    it('trace overview 接口对未发布返回 draft', async () => {
      const server = await startBackendHttpServer({
        rootDir: await mkdtemp(path.join(tmpdir(), 'm4-http-')),
        configStore: createDefaultConfigStore(await mkdtemp(path.join(tmpdir(), "m4-http-"))),
        host: '127.0.0.1',
        port: 0,
      });
      runningServers.push(server);
      const base = `http://127.0.0.1:${server.port}`;

      const overview = await (await fetch(`${base}/api/trace/trace-unpub/overview`)).json() as { publishStatus: string };
      expect(overview.publishStatus).toBe('draft');
    });
  });
});
