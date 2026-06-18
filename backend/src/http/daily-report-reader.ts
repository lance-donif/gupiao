import type { IDailyReportSnapshotQuery, IDailyReportSnapshotReader } from './types.js';
import { nowBeijingDateTime } from './beijing-time.js';
import { toNumberOrNull } from '../lib/number-utils.js';

interface IMinimalPgClient {
  query: <T>(sql: string, values?: readonly unknown[]) => Promise<{ rows: readonly T[] }>;
  end: () => Promise<void>;
}

interface ILatestTraceRow {
  readonly trace_id: string;
  readonly as_of_trade_date: string;
  readonly created_at: string;
  readonly recommendation_count: number;
}

interface IDailyRecommendationRow {
  readonly rank: number;
  readonly symbol: string;
  readonly stock_name: string;
  readonly industry: string;
  readonly final_score: string | number;
  readonly reasons: readonly string[];
  readonly score_breakdown: Record<string, unknown>;
  readonly latest_close: string | number | null;
  readonly latest_trading_day: string | null;
  readonly evidence_count: number;
  readonly total_contribution: string | number | null;
}

interface IEvidenceContributionRow {
  readonly symbol: string;
  readonly keyword: string;
  readonly newsId: string;
  readonly finalContribScore: number;
  readonly baseFrequencyScore: number;
  readonly timeDecayedScore: number;
  readonly reprintPenaltyScore: number;
  readonly matchMethod: string | null;
  readonly matchConfidence: number | null;
}

const scoreBreakdownNumber = (breakdown: Record<string, unknown>, key: string): number => {
  return toNumberOrNull(breakdown[key]) ?? 0;
};

const confidenceFromScore = (score: number): number => {
  return Math.max(0, Math.min(1, score / 100));
};

const computeStage = (index: number, total: number): 'A' | 'B' | 'C' => {
  const aCutoff = Math.max(1, Math.ceil(total * 0.3));
  const bCutoff = Math.max(aCutoff + 1, Math.ceil(total * 0.7));
  if (index < aCutoff) {
    return 'A';
  }
  if (index < bCutoff) {
    return 'B';
  }
  return 'C';
};

const pickMainReason = (reasons: readonly string[]): string => {
  return reasons.find(reason => reason.includes('关键词 [')) ?? reasons[0] ?? '命中真实 EvidenceContribution';
};

const buildTradePlan = (
  latestClose: number | null,
  marketSignal: Record<string, unknown>,
  stage: 'A' | 'B' | 'C',
): Record<string, unknown> | null => {
  if (latestClose === null || latestClose <= 0) {
    return null;
  }
  const momentum5d = toNumberOrNull(marketSignal.momentum5dPct);
  const breakout20d = marketSignal.breakout20d === true;
  const highMomentum = momentum5d !== null && momentum5d >= 0.12;
  const buyLow = highMomentum ? latestClose * 0.94 : latestClose * 0.97;
  const buyHigh = highMomentum ? latestClose * 0.985 : latestClose * 1.01;
  const stopLoss = latestClose * (stage === 'A' ? 0.91 : 0.9);
  const targetLow = latestClose * (breakout20d ? 1.08 : 1.06);
  const targetHigh = latestClose * (breakout20d ? 1.16 : 1.12);
  const buyWhen = highMomentum
    ? '只在放量后回踩不破参考买入区间时观察，避免追高'
    : '等待放量突破或回踩不破参考买入区间';

  return {
    buy_when: buyWhen,
    buy_price_ref: Number(latestClose.toFixed(2)),
    buy_price_range: [Number(buyLow.toFixed(2)), Number(buyHigh.toFixed(2))],
    stop_loss_price: Number(stopLoss.toFixed(2)),
    take_profit_range: [Number(targetLow.toFixed(2)), Number(targetHigh.toFixed(2))],
    sell_when: '跌破止损位、核心新闻因果信号被证伪，或市场确认转弱时退出',
  };
};

const toDailyStock = (
  row: IDailyRecommendationRow,
  index: number,
  total: number,
  evidences: readonly IEvidenceContributionRow[],
): Record<string, unknown> => {
  const score = toNumberOrNull(row.final_score) ?? 0;
  const breakdown = row.score_breakdown ?? {};
  const marketSignal = typeof breakdown.marketSignal === 'object' && breakdown.marketSignal !== null
    ? breakdown.marketSignal as Record<string, unknown>
    : {};
  const stage = computeStage(index, total);
  const latestTradingDay = String(marketSignal.latestTradingDay ?? row.latest_trading_day ?? '');
  const evidenceCount = Number(row.evidence_count ?? 0);
  const totalContribution = toNumberOrNull(row.total_contribution) ?? 0;
  const selectionSignalType = String(breakdown.selectionSignalType ?? breakdown.primarySignalType ?? row.industry);
  const reason = pickMainReason(row.reasons);
  const latestClose = toNumberOrNull(row.latest_close);

  const evidencePaths = evidences.slice(0, 5).map((ev, evIdx) => {
    const contrib = Number(ev.finalContribScore) || 0;
    const baseFreq = Number(ev.baseFrequencyScore) || 0;
    return {
      src: ev.keyword,
      rel: ev.matchMethod ?? '因果驱动',
      dst: row.stock_name,
      anchor_status: 'ANCHOR_OK',
      relation_confidence: ev.matchConfidence != null ? Number(ev.matchConfidence) : Math.min(1, Math.max(0, contrib * 5)),
      evidences: [
        {
          source: ev.newsId,
          snippet: `贡献分 ${contrib.toFixed(4)}，基础频率 ${baseFreq.toFixed(4)}`,
          index: evIdx,
        },
      ],
    };
  });

  return {
    ticker: row.symbol,
    name: row.stock_name,
    stage,
    total_score: Number(score.toFixed(4)),
    confidence: confidenceFromScore(score),
    confidence_reason: `来自 RecommendationSnapshot，EvidenceContribution=${evidenceCount}`,
    macro_mainline: selectionSignalType,
    macro_reason: `主信号：${selectionSignalType}；行业暴露：${row.industry}`,
    why_this_stock: {
      short: reason,
      detail: row.reasons.join('；'),
    },
    why_now: {
      detail: `市场确认 ${scoreBreakdownNumber(breakdown, 'marketSignalScore').toFixed(4)}/20；最新可见行情日 ${latestTradingDay || '未知'}`,
    },
    falsification_conditions: [
      '后续新闻因果信号被证伪',
      '暴露事实失效或不再匹配当前主题',
      '市场确认转弱或跌破风控条件',
    ],
    evidence_paths: evidencePaths,
    selection_reason_codes: ['DB_RECOMMENDATION_SNAPSHOT', 'HAS_EVIDENCE_CONTRIBUTION'],
    selection_reason_texts_zh: [
      `证据 ${scoreBreakdownNumber(breakdown, 'evidenceScore').toFixed(4)}/45`,
      `图谱 ${scoreBreakdownNumber(breakdown, 'graphScore').toFixed(4)}/20`,
      `暴露 ${scoreBreakdownNumber(breakdown, 'exposurePrecisionScore').toFixed(4)}/15`,
      `市场 ${scoreBreakdownNumber(breakdown, 'marketSignalScore').toFixed(4)}/20`,
    ],
    quality_filter_tags: ['DB_SNAPSHOT', 'EVIDENCE_REQUIRED'],
    quality_filter_texts_zh: evidenceCount > 0
      ? []
      : ['来自真实 RecommendationSnapshot'],
    trade_plan: buildTradePlan(latestClose, marketSignal, stage),
    friend_chain: null,
    latest_close: latestClose,
    amount: null,
    ret_5d: toNumberOrNull(marketSignal.momentum5dPct),
    candidate_source: 'database',
    candidate_source_confidence: 1,
    evidence_tier: evidenceCount > 0 ? 'E1' : 'E0',
    evidence_path_count: evidenceCount,
    stage_strategy: {
      watch_signals: row.reasons.slice(0, 8),
      trigger_to_B: '继续放量且核心因果信号未被证伪',
      entry_trigger: '只在价格回踩不破最新可见支撑后观察',
      stop_loss_rule: '跌破最近关键低点或市场确认转弱',
      take_profit_rule: '分批止盈，避免追高',
    },
    risk_summary: `最新行情仍使用 ${latestTradingDay || 'asOf 前最新交易日'} 收盘价；不读未来行情。`,
    tech_details: {
      scoreBreakdown: breakdown,
      latestTradingDay,
      evidenceCount,
      totalContribution,
    },
  };
};

const groupRows = (
  rows: readonly IDailyRecommendationRow[],
  evidenceMap: ReadonlyMap<string, readonly IEvidenceContributionRow[]>,
): {
  A: readonly Record<string, unknown>[];
  B: readonly Record<string, unknown>[];
  C: readonly Record<string, unknown>[];
} => {
  const mapped = rows.map((row, index) => toDailyStock(row, index, rows.length, evidenceMap.get(row.symbol) ?? []));
  return {
    A: mapped.filter(row => row.stage === 'A'),
    B: mapped.filter(row => row.stage === 'B'),
    C: mapped.filter(row => row.stage === 'C'),
  };
};

export class PgDailyReportSnapshotReader implements IDailyReportSnapshotReader {
  public constructor(private readonly client: IMinimalPgClient) {}

  public async getDailyReport(query: IDailyReportSnapshotQuery): Promise<Record<string, unknown> | null> {
    const traceRows = await this.client.query<ILatestTraceRow>(
      [
        'SELECT r."traceId" AS trace_id,',
        '       max((r."asOf" + interval \'8 hours\')::date)::text AS as_of_trade_date,',
        '       max(COALESCE(t."completedAt", t."triggeredAt"))::text AS created_at,',
        '       count(*)::int AS recommendation_count,',
        '       max(CASE WHEN t."traceId" IS NOT NULL AND t.status = \'SUCCESS\' THEN 1 ELSE 0 END) AS has_success_trace',
        'FROM public."RecommendationSnapshot" r',
        'LEFT JOIN public."RunTrace" t ON t."traceId" = r."traceId"',
        'WHERE (r."clusterKey" = $1 OR ($1 = \'main\' AND r."clusterKey" = \'global\'))',
        '  AND (r."asOf" + interval \'8 hours\')::date = $2::date',
        'GROUP BY r."traceId"',
        'ORDER BY max(r."asOf") DESC,',
        '         max(CASE WHEN t."traceId" IS NOT NULL AND t.status = \'SUCCESS\' THEN 1 ELSE 0 END) DESC,',
        '         max(COALESCE(t."completedAt", t."triggeredAt")) DESC NULLS LAST,',
        '         count(*) DESC',
        'LIMIT 1',
      ].join(' '),
      [query.groupId, query.displayDate],
    );
    const trace = traceRows.rows[0];
    if (!trace) {
      return null;
    }

    const recommendationRows = await this.client.query<IDailyRecommendationRow>(
      [
        'SELECT r.rank, r.symbol, r."stockName" AS stock_name, r.industry,',
        '       r."finalScore" AS final_score, r.reasons, r."scoreBreakdown" AS score_breakdown,',
        '       c.close AS latest_close, c."tradingDay"::date::text AS latest_trading_day,',
        '       COALESCE(e.evidence_count, 0)::int AS evidence_count,',
        '       e.total_contribution',
        'FROM public."RecommendationSnapshot" r',
        'LEFT JOIN LATERAL (',
        '  SELECT count(*)::int AS evidence_count, sum(e."finalContribScore") AS total_contribution',
        '  FROM public."EvidenceContribution" e',
        '  WHERE e."traceId" = r."traceId" AND e.symbol = r.symbol',
        ') e ON true',
        'LEFT JOIN LATERAL (',
        '  SELECT c.close, c."tradingDay"',
        '  FROM public."Stock" s',
        '  JOIN public."Candle" c ON c."stockId" = s.id',
        '  WHERE s.symbol = r.symbol AND s."clusterKey" = r."clusterKey" AND c."tradingDay" <= r."asOf"',
        '  ORDER BY c."tradingDay" DESC',
        '  LIMIT 1',
        ') c ON true',
        'WHERE r."traceId" = $1',
        'ORDER BY r.rank ASC',
      ].join(' '),
      [trace.trace_id],
    );

    const evidenceRows = await this.client.query<IEvidenceContributionRow>(
      [
        'SELECT e.symbol, e.keyword, e."newsId",',
        '       e."finalContribScore", e."baseFrequencyScore", e."timeDecayedScore", e."reprintPenaltyScore",',
        '       e."matchMethod", e."matchConfidence"',
        'FROM public."EvidenceContribution" e',
        'WHERE e."traceId" = $1',
        'ORDER BY e.symbol, e."finalContribScore" DESC',
      ].join(' '),
      [trace.trace_id],
    );
    const evidenceMap = new Map<string, IEvidenceContributionRow[]>();
    for (const ev of evidenceRows.rows) {
      const list = evidenceMap.get(ev.symbol) ?? [];
      list.push(ev);
      evidenceMap.set(ev.symbol, list);
    }

    const grouped = groupRows(recommendationRows.rows, evidenceMap);
    const total = grouped.A.length + grouped.B.length + grouped.C.length;
    return {
      available: total > 0,
      report_kind: total > 0 ? 'PERSISTED' : 'EMPTY',
      warnings: [],
      summary_text: `数据库推荐快照，${total} 条推荐，trace=${trace.trace_id}`,
      group_id: query.groupId,
      group_version_id: `${query.groupId}-db`,
      display_date: query.displayDate,
      as_of_trade_date: trace.as_of_trade_date,
      recommendation_kind: 'TRADING',
      stage_rules_version: 'db-snapshot-v1',
      batch_quality: {
        schema_checked_count: total,
        schema_mismatch_count: 0,
        schema_mismatch_rate: 0,
        degraded: false,
        promote_blocked_by_quality: false,
      },
      recommendations: grouped,
      meta: {
        batch_id: `db-${trace.trace_id}`,
        trace_id: trace.trace_id,
        run_fingerprint: `db:${query.groupId}:${trace.as_of_trade_date}:${trace.trace_id}`,
        created_at: trace.created_at || nowBeijingDateTime(),
        status: 'COMPLETED',
      },
    };
  }

  public close(): Promise<void> {
    return this.client.end();
  }
}

export const createDailyReportSnapshotReader = async (
  databaseUrl: string | undefined,
): Promise<IDailyReportSnapshotReader | undefined> => {
  if (!databaseUrl) {
    return undefined;
  }
  const pgModule = (await import('pg')) as unknown as {
    Pool: new (options: { connectionString: string }) => IMinimalPgClient;
  };
  return new PgDailyReportSnapshotReader(new pgModule.Pool({ connectionString: databaseUrl }));
};
