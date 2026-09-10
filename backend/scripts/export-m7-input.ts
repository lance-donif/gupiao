/**
 * 导出 M7 评估输入：把已成熟的 5 日收益按交易日聚合成组合日收益序列，
 * 供 `run-m7-report.ts --input` 使用。
 *
 * 用法：
 *   DATABASE_URL=... bun scripts/export-m7-input.ts --cluster global --out data/reports/m7-input.json
 *   DATABASE_URL=... bun scripts/export-m7-input.ts --cluster global --baseline-cluster baseline --out ... 
 *
 * 只读取已发布（未被取代的 RecommendationPublish）推荐对应的 YieldRecord，
 * 且只使用 horizon=5、status='mature' 的记录，禁止用短周期收益填充。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

interface DailyYieldRow {
  readonly tradeDate: string;
  readonly avgYield: string | null;
  readonly sampleCount: string;
}

const parseArgs = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i += 1) {
    const token = process.argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = process.argv[i + 1];
    out[key] = next && !next.startsWith('--') ? process.argv[++i] : 'true';
  }
  return out;
};

const loadDailyYields = async (client: pg.Client, clusterKey: string): Promise<DailyYieldRow[]> => {
  const result = await client.query(
    [
      'SELECT (r."asOf" + interval \'8 hours\')::date::text AS "tradeDate",',
      '       avg(y.value)::text AS "avgYield",',
      '       count(*)::text AS "sampleCount"',
      'FROM public."RecommendationSnapshot" r',
      'JOIN public."RecommendationPublish" p ON p."traceId" = r."traceId" AND p."supersededBy" IS NULL',
      'JOIN public."YieldRecord" y ON y."snapshotId" = r.id AND y.horizon = 5 AND y.status = \'mature\' AND y.value IS NOT NULL',
      'WHERE r."clusterKey" = $1',
      'GROUP BY 1',
      'ORDER BY 1 ASC',
    ].join(' '),
    [clusterKey],
  );
  return result.rows as DailyYieldRow[];
};

const main = async (): Promise<void> => {
  const args = parseArgs();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const clusterKey = args.cluster ?? 'global';
  const baselineCluster = args['baseline-cluster'];
  const outPath = path.resolve(args.out ?? 'data/reports/m7-input.json');

  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    const rows = await loadDailyYields(client, clusterKey);
    const baselineRows = baselineCluster ? await loadDailyYields(client, baselineCluster) : [];
    const payload = {
      exportedAt: new Date().toISOString(),
      clusterKey,
      baselineCluster: baselineCluster ?? null,
      tradingDays: rows.map(row => `${row.tradeDate}T00:00:00.000Z`),
      returns: rows.map(row => Number(row.avgYield ?? 0)),
      sampleCounts: rows.map(row => Number(row.sampleCount)),
      baselineReturns: baselineRows.map(row => Number(row.avgYield ?? 0)),
      note: 'returns are equal-weight daily averages of mature 5-day yields; apply cost/slippage downstream',
    };
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(payload, null, 2));
    console.log(JSON.stringify({ out: outPath, tradingDays: payload.tradingDays.length, clusterKey }, null, 2));
  } finally {
    await client.end();
  }
};

await main();
