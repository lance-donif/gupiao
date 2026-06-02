import type { DashboardEvidenceChainItem } from '@/lib/api-types';

export type EvidenceDisplayMode = 'empty' | 'one' | 'two' | 'many';

export interface EvidencePreviewViewModel {
  expanded: DashboardEvidenceChainItem[];
  summaries: DashboardEvidenceChainItem[];
  hiddenCount: number;
  mode: EvidenceDisplayMode;
}

export function buildEvidencePreview(items: DashboardEvidenceChainItem[]): EvidencePreviewViewModel {
  if (items.length === 0) {
    return { expanded: [], summaries: [], hiddenCount: 0, mode: 'empty' };
  }
  if (items.length === 1) {
    return { expanded: items.slice(0, 1), summaries: [], hiddenCount: 0, mode: 'one' };
  }
  if (items.length === 2) {
    return { expanded: items.slice(0, 1), summaries: items.slice(1, 2), hiddenCount: 0, mode: 'two' };
  }
  return { expanded: items.slice(0, 1), summaries: items.slice(1, 3), hiddenCount: Math.max(0, items.length - 3), mode: 'many' };
}
