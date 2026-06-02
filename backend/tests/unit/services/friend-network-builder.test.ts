import { describe, expect, it } from 'vitest';

import { buildFriendNetworkGraph } from '../../../src/services/friend-network-builder.js';

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
