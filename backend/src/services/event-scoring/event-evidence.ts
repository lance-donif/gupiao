/**
 * M6 event evidence aggregation.
 *
 * Pure functions: no DB, no IO, no ordering side effects.
 */

export type EvidenceDirection = 'positive' | 'negative' | 'mixed' | 'neutral';

export interface EventEvidenceItem {
  readonly evidenceId: string;
  readonly event: string;
  readonly canonicalKeyword: string;
  readonly businessVariable: string;
  readonly direction: EvidenceDirection;
  /** Effective contribution in (0,1], usually confidence * match quality. */
  readonly effectiveContribution: number;
  /** True when this mapping sits on a positive effective exposure evidence path. */
  readonly hasPositiveExposureEvidence: boolean;
}

export interface EventEvidenceSummary {
  readonly keyword: string;
  readonly Eplus: number;
  readonly Eminus: number;
  readonly E: number;
  readonly topEvents: ReadonlyArray<{
    readonly eventKey: string;
    readonly direction: EvidenceDirection;
    readonly q: number;
    readonly evidenceIds: readonly string[];
  }>;
}

export const eventKey = (input: {
  readonly event: string;
  readonly canonicalKeyword: string;
  readonly businessVariable: string;
  readonly direction?: EvidenceDirection;
}): string => `${input.canonicalKeyword}|${input.businessVariable}|${input.direction ?? ''}|${input.event}`;

const contribution = (direction: EvidenceDirection): { plus: boolean; minus: boolean } => {
  if (direction === 'positive') return { plus: true, minus: false };
  if (direction === 'negative') return { plus: false, minus: true };
  if (direction === 'mixed') return { plus: true, minus: true };
  return { plus: false, minus: false };
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const norm = (items: readonly EventEvidenceItem[]): EventEvidenceItem[] =>
  items.map(item => ({
    ...item,
    effectiveContribution: clamp01(Number.isFinite(item.effectiveContribution) ? item.effectiveContribution : 0),
  }));

/** For one event/stock/keyword/polarity keep max q, tie-break by evidence ID lexical. */
export const pickBestPerEvent = (
  items: readonly EventEvidenceItem[],
): EventEvidenceItem[] => {
  const byKey = new Map<string, EventEvidenceItem>();
  for (const item of items) {
    const key = eventKey(item);
    const existing = byKey.get(key);
    if (!existing
      || item.effectiveContribution > existing.effectiveContribution
      || (item.effectiveContribution === existing.effectiveContribution && item.evidenceId < existing.evidenceId)) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()];
};

const aggregate = (q: readonly number[]): number =>
  1 - q.reduce((acc, value) => acc * (1 - clamp01(value)), 1);

export const aggregateEventEvidence = (
  items: readonly EventEvidenceItem[],
  topK = 3,
): EventEvidenceSummary[] => {
  const normalized = pickBestPerEvent(norm(items)).filter(item => item.hasPositiveExposureEvidence || item.direction === 'negative');
  const byKeyword = new Map<string, EventEvidenceItem[]>();
  for (const item of normalized) {
    const list = byKeyword.get(item.canonicalKeyword) ?? [];
    list.push(item);
    byKeyword.set(item.canonicalKeyword, list);
  }
  const results: EventEvidenceSummary[] = [];
  for (const [keyword, rows] of byKeyword) {
    const sortedPlus = rows.filter(r => contribution(r.direction).plus).sort((a, b) => b.effectiveContribution - a.effectiveContribution || (a.evidenceId < b.evidenceId ? -1 : 1)).slice(0, topK);
    const sortedMinus = rows.filter(r => contribution(r.direction).minus).sort((a, b) => b.effectiveContribution - a.effectiveContribution || (a.evidenceId < b.evidenceId ? -1 : 1)).slice(0, topK);
    const Eplus = aggregate(sortedPlus.map(r => r.effectiveContribution));
    const Eminus = aggregate(sortedMinus.map(r => r.effectiveContribution));
    results.push({
      keyword,
      Eplus,
      Eminus,
      E: Math.max(0, Eplus - Eminus),
      topEvents: [
        ...sortedPlus.map(r => ({ eventKey: eventKey(r), direction: r.direction, q: r.effectiveContribution, evidenceIds: [r.evidenceId] })),
        ...sortedMinus.map(r => ({ eventKey: eventKey(r), direction: r.direction, q: r.effectiveContribution, evidenceIds: [r.evidenceId] })),
      ],
    });
  }
  return results.sort((a, b) => b.E - a.E || (a.keyword < b.keyword ? -1 : 1));
};

