import { describe, expect, it } from 'vitest';
import { aggregateEventEvidence, pickBestPerEvent, type EventEvidenceItem } from '../../../src/services/event-scoring/event-evidence.js';

const item = (over: Partial<EventEvidenceItem> & { readonly evidenceId: string }): EventEvidenceItem => ({
  event: '库存下降',
  canonicalKeyword: '白银',
  businessVariable: '供给不足',
  direction: 'positive',
  effectiveContribution: 0.5,
  hasPositiveExposureEvidence: true,
  ...over,
});

describe('event evidence aggregation', () => {
  it('picks best per event and tie-breaks by evidence id', () => {
    const rows = [
      item({ evidenceId: 'b', effectiveContribution: 0.6 }),
      item({ evidenceId: 'a', effectiveContribution: 0.6 }),
    ];
    const best = pickBestPerEvent(rows);
    expect(best).toHaveLength(1);
    expect(best[0]?.evidenceId).toBe('a');
  });

  it('aggregates top-3 with 1 - prod(1-q)', () => {
    const rows = [
      item({ evidenceId: '1', effectiveContribution: 0.5 }),
      item({ evidenceId: '2', event: '供给创新', effectiveContribution: 0.4 }),
      item({ evidenceId: '3', event: '政策', effectiveContribution: 0.3 }),
      item({ evidenceId: '4', event: '弱事件', effectiveContribution: 0.2 }),
    ];
    const result = aggregateEventEvidence(rows, 3);
    const summary = result.find(r => r.keyword === '白银');
    expect(summary).toBeDefined();
    expect(summary!.Eplus).toBeCloseTo(1 - 0.5 * 0.6 * 0.7, 10);
    expect(summary!.topEvents).toHaveLength(3);
  });

  it('produces E = max(0, Eplus - Eminus)', () => {
    const rows = [
      item({ evidenceId: 'p', direction: 'positive', effectiveContribution: 0.6 }),
      item({ evidenceId: 'n', direction: 'negative', effectiveContribution: 0.3 }),
    ];
    const summary = aggregateEventEvidence(rows, 3)[0];
    expect(summary.Eminus).toBeCloseTo(0.3, 10);
    expect(summary.E).toBeCloseTo(Math.max(0, summary.Eplus - 0.3), 10);
  });
});
