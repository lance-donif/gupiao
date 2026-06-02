import { describe, expect, it } from 'vitest';

import { projectFriendNetworkTree } from '../../../src/services/friend-network-tree-projection.js';

describe('friend network tree projection', () => {
  it('keeps full root keyword coverage while only expanding a debug subset of roots', () => {
    const tree = projectFriendNetworkTree({
      nodes: [
        { keyword: '新能源', frequency: 2, temperature: 'hot', weakSignal: false, category: 'industry' },
        { keyword: '白银', frequency: 3, temperature: 'warming', weakSignal: true, category: 'theme' },
      ],
      relationships: [
        {
          sourceKeyword: '新能源',
          targetKeyword: '白银',
          relationType: 'driver',
          direction: 'forward',
          confidence: 0.8,
          status: 'effective',
          weakSignal: true,
          evidence: ['新能源扩产带动白银需求'],
          updatedAt: '2026-03-17T12:00:00.000Z',
        },
      ],
      depthLimit: 20,
    });

    expect(tree.rootKeywords.length).toBe(2);
    expect(tree.roots.length).toBe(1);
    expect(tree.depthLimit).toBe(20);
    expect(tree.roots[0]?.childrenKeywords).toContain('白银');
  });

  it('caps expanded tree nodes for dense graphs', () => {
    const keywords = Array.from({ length: 12 }, (_, index) => `关键词${index + 1}`);
    const relationships = keywords.flatMap((sourceKeyword, sourceIndex) =>
      keywords.slice(sourceIndex + 1).map(targetKeyword => ({
        sourceKeyword,
        targetKeyword,
        relationType: 'driver' as const,
        direction: 'forward' as const,
        confidence: 0.8,
        status: 'effective' as const,
        weakSignal: true,
        evidence: [`${sourceKeyword}-${targetKeyword}`],
        updatedAt: '2026-03-17T12:00:00.000Z',
      })),
    );

    const tree = projectFriendNetworkTree({
      nodes: keywords.map(keyword => ({
        keyword,
        frequency: 1,
        temperature: 'warming' as const,
        weakSignal: true,
        category: 'theme' as const,
      })),
      relationships,
      depthLimit: 20,
    });

    const countNodes = (node: { readonly children: readonly typeof node[] }): number => {
      return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
    };
    const expandedNodeCount = tree.roots.reduce((sum, root) => sum + countNodes(root), 0);

    expect(tree.rootKeywords).toHaveLength(12);
    expect(expandedNodeCount).toBeLessThanOrEqual(250);
  });
});
