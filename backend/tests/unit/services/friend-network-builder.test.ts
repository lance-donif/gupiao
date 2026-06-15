import { describe, expect, it } from 'vitest';

import {
  buildCausalGraphEdges,
  buildFriendNetworkGraph,
  mergeCausalAndCoOccurrenceGraphs,
} from '../../../src/services/friend-network-builder.js';
import type { ICausalSignalGraphInput } from '../../../src/services/friend-network-types.js';

const makeSignal = (overrides: Partial<ICausalSignalGraphInput> & { businessVariable: string; assetOrThemeKeyword: string }): ICausalSignalGraphInput => ({
  newsId: overrides.newsId ?? 'news-1',
  businessVariable: overrides.businessVariable,
  assetOrThemeKeyword: overrides.assetOrThemeKeyword,
  direction: overrides.direction ?? 'positive',
  confidence: overrides.confidence ?? 0.8,
  evidenceText: overrides.evidenceText ?? '白银需求量大幅增加',
});

describe('friend network builder', () => {
  it('creates one-to-many and many-to-one candidate relationships from news entities', () => {
    const graph = buildFriendNetworkGraph([
      { id: '1', entities: ['新能源', '白银', '伴生矿'], reason: '新能源扩产' },
      { id: '2', entities: ['高端制造', '白银'], reason: '制造业订单回暖' },
    ]);

    expect(graph.nodes).toContainEqual(expect.objectContaining({ keyword: '白银' }));
    expect(graph.relationships.length).toBeGreaterThan(0);
  });
});

describe('buildCausalGraphEdges', () => {
  it('builds a driver -> asset edge per signal with transparent confidence and evidence', () => {
    const graph = buildCausalGraphEdges([
      makeSignal({
        newsId: 'news-1',
        businessVariable: '需求增加',
        assetOrThemeKeyword: '白银',
        direction: 'positive',
        confidence: 0.82,
        evidenceText: '光伏制造业对白银需求大增',
      }),
    ]);

    expect(graph.nodes.map(n => n.keyword).sort()).toEqual(['白银', '需求增加']);
    expect(graph.relationships).toHaveLength(1);
    const edge = graph.relationships[0];
    expect(edge.sourceKeyword).toBe('需求增加');
    expect(edge.targetKeyword).toBe('白银');
    expect(edge.relationType).toBe('driver');
    expect(edge.direction).toBe('forward');
    expect(edge.confidence).toBe(0.82);
    expect(edge.evidence.some(e => e.includes('news-1'))).toBe(true);
    expect(edge.evidence.some(e => e.includes('光伏制造业对白银需求大增'))).toBe(true);
  });

  it('maps direction to relationType/direction correctly', () => {
    const cases: ReadonlyArray<{ direction: ICausalSignalGraphInput['direction']; relationType: string; direction2: string }> = [
      { direction: 'positive', relationType: 'driver', direction2: 'forward' },
      { direction: 'negative', relationType: 'reverse', direction2: 'forward' },
      { direction: 'mixed', relationType: 'synchronous', direction2: 'bidirectional' },
      { direction: 'neutral', relationType: 'derived', direction2: 'forward' },
    ];

    for (const item of cases) {
      const graph = buildCausalGraphEdges([
        makeSignal({
          businessVariable: '驱动',
          assetOrThemeKeyword: '白银',
          direction: item.direction,
        }),
      ]);
      const edge = graph.relationships[0];
      expect(edge.relationType).toBe(item.relationType);
      expect(edge.direction).toBe(item.direction2);
    }
  });

  it('merges duplicate edges by taking max confidence and union of evidence', () => {
    const graph = buildCausalGraphEdges([
      makeSignal({
        newsId: 'news-1',
        businessVariable: '需求增加',
        assetOrThemeKeyword: '白银',
        confidence: 0.7,
        evidenceText: '白银需求增加A',
      }),
      makeSignal({
        newsId: 'news-2',
        businessVariable: '需求增加',
        assetOrThemeKeyword: '白银',
        confidence: 0.9,
        evidenceText: '白银需求增加B',
      }),
    ]);

    expect(graph.relationships).toHaveLength(1);
    const edge = graph.relationships[0];
    expect(edge.confidence).toBe(0.9);  // max
    expect(edge.evidence.some(e => e.includes('news-1'))).toBe(true);
    expect(edge.evidence.some(e => e.includes('news-2'))).toBe(true);
  });

  it('classifies driver node as macro and asset node as theme', () => {
    const graph = buildCausalGraphEdges([
      makeSignal({ businessVariable: '需求增加', assetOrThemeKeyword: '白银' }),
    ]);

    const driverNode = graph.nodes.find(n => n.keyword === '需求增加');
    const assetNode = graph.nodes.find(n => n.keyword === '白银');
    expect(driverNode?.category).toBe('macro');
    expect(assetNode?.category).toBe('theme');
  });

  it('marks low-confidence single-occurrence edge as weak signal', () => {
    const graph = buildCausalGraphEdges([
      makeSignal({
        businessVariable: '需求增加',
        assetOrThemeKeyword: '白银',
        confidence: 0.4,  // < 0.55 threshold
      }),
    ]);

    expect(graph.relationships[0].weakSignal).toBe(true);
  });

  it('returns empty graph for empty signals', () => {
    const graph = buildCausalGraphEdges([]);
    expect(graph.nodes).toEqual([]);
    expect(graph.relationships).toEqual([]);
  });
});

describe('mergeCausalAndCoOccurrenceGraphs', () => {
  it('keeps causal edges with original confidence and downgrades co-occurrence fallback edges', () => {
    const causalGraph = buildCausalGraphEdges([
      makeSignal({
        businessVariable: '需求增加',
        assetOrThemeKeyword: '白银',
        confidence: 0.85,
      }),
    ]);
    const coOccurrenceGraph = buildFriendNetworkGraph([
      { id: '1', entities: ['白银', '光伏'], reason: '白银光伏关系' },
      { id: '2', entities: ['需求增加', '白银'], reason: '共现关系' },
    ]);

    const merged = mergeCausalAndCoOccurrenceGraphs(causalGraph, coOccurrenceGraph);

    // 因果边保留原始 confidence
    const causalEdge = merged.relationships.find(
      e => e.sourceKeyword === '需求增加' && e.targetKeyword === '白银',
    );
    expect(causalEdge?.confidence).toBe(0.85);
    expect(causalEdge?.weakSignal).toBe(false);

    // 共现 fallback 边被降权 + 标记 weakSignal
    const fallbackEdge = merged.relationships.find(
      e => e.sourceKeyword === '白银' && e.targetKeyword === '光伏',
    );
    expect(fallbackEdge).toBeDefined();
    expect(fallbackEdge?.weakSignal).toBe(true);
    expect(fallbackEdge?.confidence).toBeLessThan(0.72);  // 原始共现 confidence 0.72 * 0.6
  });

  it('does not duplicate edges when causal and co-occurrence cover the same pair', () => {
    const causalGraph = buildCausalGraphEdges([
      makeSignal({ businessVariable: '需求增加', assetOrThemeKeyword: '白银', confidence: 0.9 }),
    ]);
    const coOccurrenceGraph = buildFriendNetworkGraph([
      { id: '1', entities: ['需求增加', '白银'], reason: '共现' },
    ]);

    const merged = mergeCausalAndCoOccurrenceGraphs(causalGraph, coOccurrenceGraph);

    const sameDirectionPair = merged.relationships.filter(
      e => e.sourceKeyword === '需求增加' && e.targetKeyword === '白银',
    );
    expect(sameDirectionPair).toHaveLength(1);
    expect(sameDirectionPair[0].confidence).toBe(0.9);  // 因果边优先，不被降权
  });

  it('merges nodes from both graphs without duplication', () => {
    const causalGraph = buildCausalGraphEdges([
      makeSignal({ businessVariable: '需求增加', assetOrThemeKeyword: '白银' }),
    ]);
    const coOccurrenceGraph = buildFriendNetworkGraph([
      { id: '1', entities: ['光伏', '储能'], reason: '光伏储能共现' },
    ]);

    const merged = mergeCausalAndCoOccurrenceGraphs(causalGraph, coOccurrenceGraph);

    const keywords = new Set(merged.nodes.map(n => n.keyword));
    expect(keywords).toEqual(new Set(['储能', '光伏', '需求增加', '白银']));
  });
});
