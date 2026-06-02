import { describe, expect, it } from 'vitest';

import { TfidfVectorizer } from '../../../../src/algorithms/text/tfidf.js';

describe('TfidfVectorizer', () => {
  it('builds L2-normalized vectors for Chinese documents', () => {
    const vectorizer = new TfidfVectorizer();
    const result = vectorizer.fitTransform([
      ['股票', '市场', '上涨', '股票'],
      ['市场', '成交量', '放大'],
      ['人工智能', '股票', '策略'],
    ]);

    for (const vector of result.vectors) {
      const squaredMagnitude = vector.weights.reduce((sum, value) => sum + value * value, 0);
      expect(Math.sqrt(squaredMagnitude)).toBeCloseTo(1, 10);
    }
  });

  it('assigns lower weight to corpus-wide shared terms than to rarer terms in the same document', () => {
    const vectorizer = new TfidfVectorizer();
    const result = vectorizer.fitTransform([
      ['市场', '独特词'],
      ['市场', '独特词'],
      ['市场', '成交量'],
    ]);

    const firstVector = result.vectors[0];
    const marketWeight = firstVector.termWeights['市场'];
    const distinctiveWeight = firstVector.termWeights['独特词'];

    expect(distinctiveWeight).toBeGreaterThan(marketWeight);
  });
});
