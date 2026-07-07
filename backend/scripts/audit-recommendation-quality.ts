import { pathToFileURL } from 'node:url';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadBackendEnv } from '../src/services/load-backend-env.js';

loadBackendEnv();

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://gupiao:password@localhost:5432/gupiaodb';
const SCORE_COMPONENT_PATTERN = /评分组件：证据\s+[\d.]+\/(\d+)，图谱\s+[\d.]+\/(\d+)，暴露\s+[\d.]+\/(\d+)，市场\s+[\d.]+\/(\d+)/u;

export interface IRecommendationQualityAuditRow {
  readonly traceId: string;
  readonly rank: number;
  readonly symbol: string;
  readonly stockName: string;
  readonly finalScore: number;
  readonly reasons: readonly string[];
  readonly scoreBreakdown: Record<string, unknown>;
  readonly pctChange?: number | null;
  readonly latestTradingDay?: string | null;
  readonly latestMarketTradingDay?: string | null;
}

export interface IRecommendationQualityAuditIssue {
  readonly type:
    | 'stale_market_signal'
    | 'weight_mismatch'
    | 'graph_dominated'
    | 'broad_exposure'
    | 'overheated'
    | 'low_volume_rebound'
    | 'keyword_saturated'
    | 'post_return';
  readonly severity: 'info' | 'warn' | 'error';
  readonly symbol: string;
  readonly message: string;
}

const parseArgs = (): Record<string, string> => {
  const parsed: Record<string, string> = {};
  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    parsed[token.slice(2)] = process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
      ? process.argv[++index]
      : 'true';
  }
  return parsed;
};

const toNumberOrNull = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const readRecord = (value: unknown): Record<string, unknown> => {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
};

const readMarketSignal = (row: IRecommendationQualityAuditRow): Record<string, unknown> => {
  return readRecord(row.scoreBreakdown.marketSignal);
};

const addIssue = (
  issues: IRecommendationQualityAuditIssue[],
  row: IRecommendationQualityAuditRow,
  type: IRecommendationQualityAuditIssue['type'],
  severity: IRecommendationQualityAuditIssue['severity'],
  message: string,
): void => {
  issues.push({ type, severity, symbol: row.symbol, message });
};

export const auditRecommendationQualityRows = (
  rows: readonly IRecommendationQualityAuditRow[],
): readonly IRecommendationQualityAuditIssue[] => {
  const issues: IRecommendationQualityAuditIssue[] = [];

  for (const row of rows) {
    const marketSignal = readMarketSignal(row);
    const evidenceScore = toNumberOrNull(row.scoreBreakdown.evidenceScore) ?? 0;
    const graphScore = toNumberOrNull(row.scoreBreakdown.graphScore) ?? 0;
    const exposurePrecisionScore = toNumberOrNull(row.scoreBreakdown.exposurePrecisionScore) ?? 0;
    const marketSignalScore = toNumberOrNull(row.scoreBreakdown.marketSignalScore) ?? toNumberOrNull(marketSignal.score) ?? 0;
    const staleTradingDays = toNumberOrNull(marketSignal.staleTradingDays) ?? 0;
    const momentum5dPct = toNumberOrNull(marketSignal.momentum5dPct);
    const momentum20dPct = toNumberOrNull(marketSignal.momentum20dPct);
    const volumeRatio20d = toNumberOrNull(marketSignal.volumeRatio20d);
    const breakout20d = marketSignal.breakout20d === true;
    const hasVolumeBreakoutConfirmation = (volumeRatio20d ?? 0) >= 1 && breakout20d;

    const scoreLine = row.reasons.find(reason => SCORE_COMPONENT_PATTERN.test(reason));
    const weights = scoreLine?.match(SCORE_COMPONENT_PATTERN)?.slice(1).map(Number);
    if (weights && weights.join('/') !== '45/20/15/20') {
      addIssue(issues, row, 'weight_mismatch', 'error', `评分权重为 ${weights.join('/')}，应为 45/20/15/20`);
    }
    if (staleTradingDays > 1 || (row.latestTradingDay && row.latestMarketTradingDay && row.latestTradingDay < row.latestMarketTradingDay)) {
      addIssue(issues, row, 'stale_market_signal', 'error', `行情快照过期：snapshot=${row.latestTradingDay ?? 'NA'} latest=${row.latestMarketTradingDay ?? 'NA'} stale=${staleTradingDays}`);
    }
    if (evidenceScore < 10 && graphScore >= 12) {
      addIssue(issues, row, 'graph_dominated', 'warn', `弱证据靠图谱补分：evidence=${evidenceScore}, graph=${graphScore}`);
    }
    if (exposurePrecisionScore < 4 && !(evidenceScore >= 18 && marketSignalScore >= 8)) {
      addIssue(issues, row, 'broad_exposure', 'warn', `暴露过宽：exposure=${exposurePrecisionScore}, evidence=${evidenceScore}, market=${marketSignalScore}`);
    }
    if (((momentum5dPct ?? 0) >= 0.15 || (momentum20dPct ?? 0) >= 0.25) && !hasVolumeBreakoutConfirmation) {
      addIssue(issues, row, 'overheated', 'warn', `过热追涨：m5=${momentum5dPct ?? 'NA'}, m20=${momentum20dPct ?? 'NA'}, volume=${volumeRatio20d ?? 'NA'}, breakout=${breakout20d}`);
    }
    if (momentum20dPct !== null && momentum20dPct <= -0.12 && (volumeRatio20d ?? 0) < 0.8) {
      addIssue(issues, row, 'low_volume_rebound', 'warn', `无量弱反弹：m20=${momentum20dPct}, volume=${volumeRatio20d ?? 'NA'}`);
    }
    if (row.reasons.some(reason => reason.includes('单关键词有效贡献按'))) {
      addIssue(issues, row, 'keyword_saturated', 'info', '存在单关键词贡献封顶，需关注大主题刷分');
    }
    if (row.pctChange !== null && row.pctChange !== undefined && row.pctChange < 0) {
      addIssue(issues, row, 'post_return', 'info', `推荐后下跌 ${row.pctChange.toFixed(2)}%`);
    }
  }

  return issues;
};

const resolveTraceId = async (
  prisma: PrismaClient,
  args: Record<string, string>,
): Promise<string> => {
  if (args['trace-id']) {
    return args['trace-id'];
  }
  if (!args.date) {
    throw new Error('Usage: bun run scripts/audit-recommendation-quality.ts --trace-id <id> OR --date YYYY-MM-DD');
  }
  const rows = await prisma.$queryRawUnsafe<Array<{ traceId: string }>>(
    [
      'SELECT r."traceId"',
      'FROM public."RecommendationSnapshot" r',
      'LEFT JOIN public."RunTrace" t ON t."traceId" = r."traceId"',
      'WHERE (r."asOf" + interval \'8 hours\')::date = $1::date',
      'GROUP BY r."traceId"',
      'ORDER BY max(r."asOf") DESC,',
      '         max(CASE WHEN t."traceId" IS NOT NULL AND t.status = \'SUCCESS\' THEN 1 ELSE 0 END) DESC,',
      '         max(COALESCE(t."completedAt", t."triggeredAt")) DESC NULLS LAST,',
      '         count(*) DESC',
      'LIMIT 1',
    ].join(' '),
    args.date,
  );
  const traceId = rows[0]?.traceId;
  if (!traceId) {
    throw new Error(`No RecommendationSnapshot found for date ${args.date}`);
  }
  return traceId;
};

const loadAuditRows = async (
  prisma: PrismaClient,
  traceId: string,
): Promise<IRecommendationQualityAuditRow[]> => {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    [
      'SELECT r."traceId", r.rank, r.symbol, r."stockName", r."finalScore"::float AS "finalScore",',
      '       r.reasons, r."scoreBreakdown",',
      '       ms."latestTradingDay"::date::text AS "latestTradingDay",',
      '       fresh."latestMarketTradingDay"::date::text AS "latestMarketTradingDay",',
      '       CASE WHEN base.close IS NULL OR latest.close IS NULL OR base.close = 0 THEN NULL',
      '            ELSE round(((latest.close - base.close) / base.close * 100)::numeric, 2)::float END AS "pctChange"',
      'FROM public."RecommendationSnapshot" r',
      'LEFT JOIN public."MarketSignalSnapshot" ms ON ms."traceId" = r."traceId" AND ms.symbol = r.symbol',
      'LEFT JOIN LATERAL (',
      '  SELECT max(c."tradingDay") AS "latestMarketTradingDay"',
      '  FROM public."Stock" s JOIN public."Candle" c ON c."stockId" = s.id',
      '  WHERE s.symbol = r.symbol AND s."clusterKey" = r."clusterKey" AND c."tradingDay" <= r."asOf"',
      ') fresh ON true',
      'LEFT JOIN LATERAL (',
      '  SELECT c.close FROM public."Stock" s JOIN public."Candle" c ON c."stockId" = s.id',
      '  WHERE s.symbol = r.symbol AND s."clusterKey" = r."clusterKey" AND c."tradingDay" <= r."asOf"',
      '  ORDER BY c."tradingDay" DESC LIMIT 1',
      ') base ON true',
      'LEFT JOIN LATERAL (',
      '  SELECT c.close FROM public."Stock" s JOIN public."Candle" c ON c."stockId" = s.id',
      '  WHERE s.symbol = r.symbol AND s."clusterKey" = r."clusterKey"',
      '  ORDER BY c."tradingDay" DESC LIMIT 1',
      ') latest ON true',
      'WHERE r."traceId" = $1',
      'ORDER BY r.rank ASC',
    ].join(' '),
    traceId,
  );

  return rows.map(row => ({
    traceId: String(row.traceId),
    rank: Number(row.rank),
    symbol: String(row.symbol),
    stockName: String(row.stockName),
    finalScore: Number(row.finalScore),
    reasons: Array.isArray(row.reasons) ? row.reasons.map(String) : [],
    scoreBreakdown: readRecord(row.scoreBreakdown),
    pctChange: toNumberOrNull(row.pctChange),
    latestTradingDay: row.latestTradingDay ? String(row.latestTradingDay) : null,
    latestMarketTradingDay: row.latestMarketTradingDay ? String(row.latestMarketTradingDay) : null,
  }));
};

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL }),
  });
  try {
    const traceId = await resolveTraceId(prisma, parseArgs());
    const rows = await loadAuditRows(prisma, traceId);
    const issues = auditRecommendationQualityRows(rows);
    console.log(JSON.stringify({
      traceId,
      recommendationCount: rows.length,
      issueCount: issues.length,
      issues,
    }, null, 2));
  }
  finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
