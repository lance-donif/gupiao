import { describe, expect, it } from 'vitest';

import { MinHash } from '../../../../src/algorithms/text/minhash.js';

describe('MinHash', () => {
  it('estimates Jaccard similarity within ±5% for overlapping token sets', () => {
    const minHash = new MinHash();
    const leftTokens = ['股票', '市场', '上涨', '新能源', '盈利', '预期'];
    const rightTokens = ['股票', '市场', '上涨', '新能源', '估值', '修复'];

    const actualJaccard = 4 / 8;
    const estimatedJaccard = minHash.estimateSimilarity(leftTokens, rightTokens);

    expect(Math.abs(estimatedJaccard - actualJaccard)).toBeLessThanOrEqual(0.05);
  });

  it('returns 1 for identical signatures and 0 for disjoint empty-vs-nonempty edge cases', () => {
    const minHash = new MinHash();

    expect(minHash.estimateSimilarity(['科技', '龙头'], ['科技', '龙头'])).toBe(1);
    expect(minHash.estimateSimilarity([], ['科技', '龙头'])).toBe(0);
  });
});
