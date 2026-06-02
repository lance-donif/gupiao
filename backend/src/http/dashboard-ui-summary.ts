import type {
  IDashboardEvidenceChainItem,
  IDashboardStockDetailPayload,
  IDashboardUiSummary,
} from './types.js';

export interface IDashboardUiSummaryInput {
  readonly stock: {
    readonly stock_name: string;
    readonly industry: string;
    readonly stage: 'A' | 'B' | 'C';
    readonly total_score: number;
    readonly score_breakdown: IDashboardStockDetailPayload['score_breakdown'];
    readonly why_this_stock: IDashboardStockDetailPayload['why_this_stock'];
    readonly why_now: IDashboardStockDetailPayload['why_now'];
    readonly trade_plan: IDashboardStockDetailPayload['trade_plan'];
    readonly market_confirmation: IDashboardStockDetailPayload['market_confirmation'];
  };
  readonly evidenceItems: readonly IDashboardEvidenceChainItem[];
  readonly system: {
    readonly data_updated_at: string | null;
    readonly schema_mismatch_count: number;
    readonly pipeline_status: string | null;
  };
}

const actionLabels: Record<IDashboardUiSummary['decision']['action_state'], IDashboardUiSummary['decision']['action_label']> = {
  strong_buy: '强推荐',
  watch_pullback: '等待回踩',
  observe: '继续观察',
  avoid: '暂不买入',
};

export function sortEvidenceChains(items: readonly IDashboardEvidenceChainItem[]): IDashboardEvidenceChainItem[] {
  return [...items].sort((left, right) => {
    const contribDelta = right.score.final_contrib_score - left.score.final_contrib_score;
    if (contribDelta !== 0) {
      return contribDelta;
    }
    const leftConfidence = left.signal.match_confidence ?? Number.NEGATIVE_INFINITY;
    const rightConfidence = right.signal.match_confidence ?? Number.NEGATIVE_INFINITY;
    const confidenceDelta = rightConfidence - leftConfidence;
    if (confidenceDelta !== 0) {
      return confidenceDelta;
    }
    const timeDelta = Date.parse(right.news.published_at || '') - Date.parse(left.news.published_at || '');
    if (Number.isFinite(timeDelta) && timeDelta !== 0) {
      return timeDelta;
    }
    const newsDelta = left.news.news_id.localeCompare(right.news.news_id);
    if (newsDelta !== 0) {
      return newsDelta;
    }
    return left.chain_id.localeCompare(right.chain_id);
  });
}

export function buildPrimaryEvidenceMapping(
  item: IDashboardEvidenceChainItem | null,
  stockName: string,
  industry: string,
): IDashboardUiSummary['primary_evidence'] {
  if (!item) {
    return {
      chain_id: null,
      mapping_short: '暂无证据链',
      mapping_explanation: '当前缺少新闻、信号、暴露事实到股票的可核验映射。',
    };
  }

  const sourceKeyword = item.signal.source_keyword || item.signal.asset_or_theme_keyword || '未知关键词';
  const themeKeyword = item.signal.asset_or_theme_keyword || sourceKeyword;
  const exposureLabel = buildExposureDisplayLabel(item);
  const safeStockName = item.stock_link.stock_name || stockName;
  const safeIndustry = item.stock_link.industry || industry || '未知行业';
  const verification = item.exposure.external_fact.verification_label;
  const factText = item.exposure.external_fact.evidence_text;

  return {
    chain_id: item.chain_id,
    mapping_short: `${sourceKeyword} → ${exposureLabel} → ${safeStockName}`,
    mapping_explanation: `${sourceKeyword} 触发 ${themeKeyword}，命中 ${exposureLabel}，因此关联 ${safeStockName}（${safeIndustry}）。外部事实：${verification}；${factText}`,
  };
}

export function getEvidenceDisplayMode(total: number): 'empty' | 'one' | 'two' | 'many' {
  if (total <= 0) {
    return 'empty';
  }
  if (total === 1) {
    return 'one';
  }
  if (total === 2) {
    return 'two';
  }
  return 'many';
}

export function buildDashboardUiSummary(input: IDashboardUiSummaryInput): IDashboardUiSummary {
  const sortedEvidence = sortEvidenceChains(input.evidenceItems);
  const primaryEvidence = sortedEvidence[0] ?? null;
  const evidenceScore = input.stock.score_breakdown.evidence;
  const graphScore = input.stock.score_breakdown.graph;
  const exposureScore = input.stock.score_breakdown.exposure;
  const marketScore = input.stock.score_breakdown.market;
  const totalScore = input.stock.total_score;
  const recentWeekGainExceeded = input.stock.market_confirmation.recent_week_gain_exceeded;
  const actionState: IDashboardUiSummary['decision']['action_state'] = totalScore >= 78 && evidenceScore >= 35 && marketScore >= 12 && !recentWeekGainExceeded
    ? 'strong_buy'
    : totalScore >= 70 && evidenceScore >= 25 && !recentWeekGainExceeded
      ? 'watch_pullback'
      : totalScore >= 60
        ? 'observe'
        : 'avoid';
  const scoreFormula = `证据 ${evidenceScore.toFixed(1)} + 图谱 ${graphScore.toFixed(1)} + 风险 ${exposureScore.toFixed(1)} + 市场 ${marketScore.toFixed(1)} = ${totalScore.toFixed(1)}`;
  const mapping = buildPrimaryEvidenceMapping(primaryEvidence, input.stock.stock_name, input.stock.industry);
  const headline = buildDecisionHeadline(input.stock, primaryEvidence);
  const triggerLabel = input.stock.trade_plan?.buy_when || input.stock.why_now.headline || '等待触发条件';

  return {
    decision: {
      headline,
      action_state: actionState,
      action_label: actionLabels[actionState],
      score_formula: scoreFormula,
    },
    buy_trigger: {
      trigger_label: triggerLabel,
      buy_price_ref_label: input.stock.trade_plan?.buy_price_ref == null ? '暂无参考价' : `${input.stock.trade_plan.buy_price_ref.toFixed(2)} 元`,
      stop_loss_label: input.stock.trade_plan?.stop_loss_price == null ? '暂无止损位' : `${input.stock.trade_plan.stop_loss_price.toFixed(2)} 元`,
      position_label: buildPositionLabel(actionState, input.stock.stage),
    },
    why_stock: {
      conclusion: headline,
      key_evidence: primaryEvidence?.signal.signal_reason || input.stock.why_this_stock.short || '暂无主证据',
      mapping_reason: mapping.mapping_explanation,
      risk_note: input.stock.market_confirmation.recent_week_gain_exceeded
        ? '近 5 个可见交易日涨幅过高，避免追高。'
        : '若新闻因果、暴露事实或市场确认被证伪，应停止买入。',
    },
    why_now: buildWhyNowSummary(input.stock),
    primary_evidence: mapping,
    system_health: {
      data_updated_at: input.system.data_updated_at,
      schema_health_label: input.system.schema_mismatch_count === 0 ? '数据结构正常' : '存在结构异常',
      pipeline_health_label: input.system.pipeline_status || '暂无执行记录',
    },
  };
}

function buildDecisionHeadline(
  stock: IDashboardUiSummaryInput['stock'],
  primaryEvidence: IDashboardEvidenceChainItem | null,
): string {
  const candidates = [
    primaryEvidence?.signal.signal_reason,
    stock.why_this_stock.short,
    stock.why_this_stock.detail,
    `${stock.stock_name} 命中推荐条件`,
  ];
  const picked = candidates.find((item): item is string => Boolean(item && !item.includes('评分组件')));
  return trimChineseSentence(picked ?? `${stock.stock_name} 命中推荐条件`, 28);
}

function buildExposureDisplayLabel(item: IDashboardEvidenceChainItem): string {
  const rawLabel = item.exposure.exposure_label || item.exposure.matched_exposure_keyword || '未知暴露';
  if (item.exposure.exposure_label) {
    return rawLabel;
  }
  const typeLabel = item.exposure.exposure_type === 'industry_exposure'
    ? '行业暴露'
    : item.exposure.exposure_type === 'concept_exposure'
      ? '概念暴露'
      : item.exposure.exposure_type
        ? item.exposure.exposure_type
        : '暴露事实';
  return `${typeLabel}:${rawLabel}`;
}

function buildPositionLabel(
  actionState: IDashboardUiSummary['decision']['action_state'],
  stage: 'A' | 'B' | 'C',
): string {
  if (actionState === 'strong_buy' && stage === 'A') {
    return '中等仓位（建议 3-5%）';
  }
  if (actionState === 'watch_pullback') {
    return '轻仓观察（1-3%）';
  }
  if (actionState === 'observe') {
    return '观察仓位（不超过 1%）';
  }
  return '不建议建仓';
}

function buildWhyNowSummary(stock: IDashboardUiSummaryInput['stock']): IDashboardUiSummary['why_now'] {
  const momentum5d = stock.market_confirmation.momentum5d_pct;
  const volumeRatio = stock.market_confirmation.volume_ratio20d;
  const marketTone: IDashboardUiSummary['why_now'][number]['tone'] = stock.market_confirmation.recent_week_gain_exceeded
    ? 'warning'
    : stock.market_confirmation.breakout20d || (momentum5d ?? 0) > 0
      ? 'positive'
      : 'neutral';
  return [
    {
      label: '触发状态',
      detail: stock.why_now.headline,
      tone: stock.why_now.tone === 'ready' ? 'positive' : 'neutral',
    },
    {
      label: '量价确认',
      detail: `5日涨幅 ${momentum5d == null ? '待观察' : `${(momentum5d * 100).toFixed(1)}%`}，20日量比 ${volumeRatio == null ? '待观察' : volumeRatio.toFixed(2)}`,
      tone: marketTone,
    },
    {
      label: '风险开关',
      detail: stock.market_confirmation.recent_week_gain_exceeded ? '近 5 日涨幅超过限制，当前不追高。' : '未触发近期涨幅过高风控。',
      tone: stock.market_confirmation.recent_week_gain_exceeded ? 'warning' : 'positive',
    },
  ];
}

function trimChineseSentence(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const sliced = normalized.slice(0, maxLength);
  const punctuationIndex = Math.max(sliced.lastIndexOf('。'), sliced.lastIndexOf('；'), sliced.lastIndexOf('，'));
  if (punctuationIndex >= 8) {
    return sliced.slice(0, punctuationIndex + 1);
  }
  return `${sliced.slice(0, maxLength - 1)}…`;
}
