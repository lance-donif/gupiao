import { describe, expect, it } from 'vitest';

import { buildEvidencePreview } from '../../../src/features/dashboard/dashboard-view-model';
import type { DashboardEvidenceChainItem } from '../../../src/lib/api-types';

const item = (id: string): DashboardEvidenceChainItem => ({
  chain_id: id,
  news: { news_id: id, title: id, source: '', published_at: '', url: '', excerpt: '', anchor_quote: '' },
  signal: { source_keyword: null, asset_or_theme_keyword: null, match_method: null, match_confidence: null, signal_reason: '' },
  exposure: {
    matched_exposure_keyword: null,
    exposure_fact_id: null,
    exposure_type: null,
    exposure_label: '',
    exposure_reason: '',
    external_fact: {
      source: null,
      source_id: null,
      source_name: null,
      source_provider: null,
      source_url: null,
      observed_at: null,
      confidence: null,
      evidence_text: '',
      verification_status: 'missing_external_fact',
      verification_label: '',
    },
  },
  stock_link: { symbol: '', stock_name: '', link_reason: '', industry: null, concept_tags: [] },
  score: { base_frequency_score: 0, time_decayed_score: 0, reprint_penalty_score: 0, final_contrib_score: 0 },
});

describe('buildEvidencePreview', () => {
  it('keeps the first chain expanded and summarizes according to item count', () => {
    expect(buildEvidencePreview([]).mode).toBe('empty');
    expect(buildEvidencePreview([item('1')])).toMatchObject({ mode: 'one', hiddenCount: 0 });
    expect(buildEvidencePreview([item('1'), item('2')]).summaries.map(row => row.chain_id)).toEqual(['2']);
    expect(buildEvidencePreview([item('1'), item('2'), item('3'), item('4')])).toMatchObject({
      mode: 'many',
      hiddenCount: 1,
    });
  });
});
