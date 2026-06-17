import { describe, expect, it } from 'vitest';

import {
  buildDashboardUiSummary,
  buildPrimaryEvidenceMapping,
  getEvidenceDisplayMode,
  sortEvidenceChains,
} from '../../../src/http/dashboard-ui-summary.js';
import type { IDashboardEvidenceChainItem, IDashboardStockDetailPayload } from '../../../src/http/types.js';

function chain(input: {
  chainId: string;
  newsId: string;
  contrib: number;
  confidence: number | null;
  publishedAt: string;
  sourceKeyword?: string | null;
  theme?: string | null;
  exposure?: string;
}): IDashboardEvidenceChainItem {
  return {
    chain_id: input.chainId,
    news: {
      news_id: input.newsId,
      title: `新闻 ${input.newsId}`,
      source: 'source',
      published_at: input.publishedAt,
      url: '',
      excerpt: 'excerpt',
      anchor_quote: 'anchor',
    },
    signal: {
      source_keyword: input.sourceKeyword ?? '半导体',
      asset_or_theme_keyword: input.theme ?? '半导体设备',
      match_method: 'keyword',
      match_confidence: input.confidence,
      signal_reason: '新闻原文出现半导体设备扩产信号',
    },
    exposure: {
      matched_exposure_keyword: input.exposure ?? '半导体设备',
      exposure_fact_id: 'fact-1',
      exposure_type: 'industry',
      exposure_label: input.exposure ?? '半导体设备',
      exposure_reason: '命中行业暴露事实',
      external_fact: {
        source: 'akshare_industry_board_em',
        source_id: '半导体设备',
        source_name: '半导体设备',
        source_provider: 'aktools',
        source_url: 'http://aktools.local/api/public/stock_board_industry_cons_em?symbol=x',
        observed_at: '2026-05-26T00:00:00.000Z',
        confidence: 0.82,
        evidence_text: 'AKShare 东方财富行业板块成份包含样本股票',
        verification_status: 'verified_external',
        verification_label: '外部事实已核验',
      },
    },
    stock_link: {
      symbol: '600001',
      stock_name: '样本股票',
      link_reason: '通过暴露事实命中股票',
      industry: '专用设备',
      concept_tags: ['专用设备'],
    },
    score: {
      base_frequency_score: 1,
      time_decayed_score: 0.9,
      reprint_penalty_score: 1,
      final_contrib_score: input.contrib,
    },
  };
}

function stock(overrides: Partial<IDashboardStockDetailPayload> = {}): IDashboardStockDetailPayload {
  return {
    symbol: '600001',
    stock_name: '样本股票',
    industry: '专用设备',
    rank: 1,
    stage: 'A',
    total_score: 81.6,
    confidence: 0.82,
    trace_id: 'trace-1',
    strategy_id: null,
    macro_mainline: '半导体',
    latest_close: 10,
    latest_trading_day: '2026-05-27',
    live_quote: { price: 10, day_low: null, day_high: null, change_pct: null, market_time: null, source: 'candle_fallback', status: 'FALLBACK' },
    score_breakdown: {
      evidence: 44.8,
      graph: 12,
      exposure: 10.8,
      market: 14,
      total_contribution: 5,
      evidence_count: 3,
      raw: {},
    },
    why_this_stock: {
      short: '半导体设备扩产直接提升订单预期',
      detail: '半导体设备扩产直接提升订单预期，样本股票具备暴露事实。',
    },
    why_now: {
      headline: '当前接近触发买入条件',
      bullets: [],
      tone: 'ready',
    },
    trade_plan: {
      buy_when: '回踩不破支撑后分批介入',
      buy_price_ref: 10,
      buy_price_range: [9.7, 10.1],
      stop_loss_price: 9.1,
      take_profit_range: [10.6, 11.2],
      sell_when: '跌破止损位退出',
    },
    market_confirmation: {
      momentum5d_pct: 0.03,
      momentum20d_pct: 0.08,
      volume_ratio20d: 1.2,
      breakout20d: true,
      volatility_compression: false,
      recent_week_gain_exceeded: false,
      reasons: [],
    },
    falsification_conditions: [],
    concept_tags: [],
    ui_summary: null as never,
    ...overrides,
  };
}

describe('dashboard ui summary', () => {
  it('assigns all action states from score, evidence, market, and recent gain rules', () => {
    expect(buildDashboardUiSummary({
      stock: stock(),
      evidenceItems: [],
      system: { data_updated_at: null, schema_mismatch_count: 0, pipeline_status: '已完成' },
    }).decision.action_state).toBe('strong_buy');

    expect(buildDashboardUiSummary({
      stock: stock({ total_score: 72, score_breakdown: { ...stock().score_breakdown, evidence: 30, market: 8 } }),
      evidenceItems: [],
      system: { data_updated_at: null, schema_mismatch_count: 0, pipeline_status: '已完成' },
    }).decision.action_state).toBe('watch_pullback');

    expect(buildDashboardUiSummary({
      stock: stock({ total_score: 62, score_breakdown: { ...stock().score_breakdown, evidence: 20, market: 6 } }),
      evidenceItems: [],
      system: { data_updated_at: null, schema_mismatch_count: 0, pipeline_status: '已完成' },
    }).decision.action_state).toBe('observe');

    expect(buildDashboardUiSummary({
      stock: stock({ total_score: 58 }),
      evidenceItems: [],
      system: { data_updated_at: null, schema_mismatch_count: 0, pipeline_status: '已完成' },
    }).decision.action_state).toBe('avoid');
  });

  it('sorts primary evidence by contrib, confidence, published time, news id, and chain id', () => {
    const sorted = sortEvidenceChains([
      chain({ chainId: 'chain-3', newsId: 'news-3', contrib: 2, confidence: 0.7, publishedAt: '2026-05-26T00:00:00.000Z' }),
      chain({ chainId: 'chain-2', newsId: 'news-2', contrib: 2, confidence: 0.9, publishedAt: '2026-05-25T00:00:00.000Z' }),
      chain({ chainId: 'chain-1', newsId: 'news-1', contrib: 3, confidence: 0.5, publishedAt: '2026-05-24T00:00:00.000Z' }),
    ]);
    expect(sorted.map(item => item.chain_id)).toEqual(['chain-1', 'chain-2', 'chain-3']);
  });

  it('builds mapping text that explains theme to exposure to stock', () => {
    const mapping = buildPrimaryEvidenceMapping(
      chain({ chainId: 'chain-1', newsId: 'news-1', contrib: 3, confidence: 0.9, publishedAt: '2026-05-26T00:00:00.000Z' }),
      '样本股票',
      '专用设备',
    );

    expect(mapping.mapping_short).toBe('半导体 → 半导体设备 → 样本股票');
    expect(mapping.mapping_explanation).toBe('半导体 触发 半导体设备，命中 半导体设备，因此关联 样本股票（专用设备）。外部事实：外部事实已核验；AKShare 东方财富行业板块成份包含样本股票');
  });

  it('exposes evidence display boundary modes', () => {
    expect(getEvidenceDisplayMode(0)).toBe('empty');
    expect(getEvidenceDisplayMode(1)).toBe('one');
    expect(getEvidenceDisplayMode(2)).toBe('two');
    expect(getEvidenceDisplayMode(3)).toBe('many');
  });

  it('builds summary labels and score formula for the UI contract', () => {
    const summary = buildDashboardUiSummary({
      stock: stock(),
      evidenceItems: [chain({ chainId: 'chain-1', newsId: 'news-1', contrib: 3, confidence: 0.9, publishedAt: '2026-05-26T00:00:00.000Z' })],
      system: { data_updated_at: '2026-05-27T09:00:00.000Z', schema_mismatch_count: 0, pipeline_status: '已完成' },
    });

    expect(summary.decision.action_label).toBe('强推荐');
    expect(summary.decision.score_formula).toBe('证据 44.8 + 图谱 12.0 + 风险 10.8 + 市场 14.0 = 81.6');
    expect(summary.buy_trigger.position_label).toBe('中等仓位（建议 3-5%）');
    expect(summary.primary_evidence.chain_id).toBe('chain-1');
    expect(summary.system_health.schema_health_label).toBe('数据结构正常');
  });
});
