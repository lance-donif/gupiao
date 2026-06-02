import { describe, expect, it } from 'vitest';

import { TextRank } from '../../../../src/algorithms/text/textrank.js';

describe('TextRank', () => {
  it('converges within 100 iterations for Chinese tokens and returns ranked keywords', () => {
    const textRank = new TextRank();
    const result = textRank.rank([
      '人工智能',
      '赋能',
      '股票',
      '策略',
      '人工智能',
      '优化',
      '股票',
      '分析',
      '策略',
    ]);

    expect(result.converged).toBe(true);
    expect(result.iterations).toBeLessThanOrEqual(100);
    expect(result.keywords[0]?.term).toBeDefined();
    expect(result.keywords[0]?.score).toBeGreaterThan(0);
  });

  it('boosts terms that co-occur with more neighbors in the window graph', () => {
    const textRank = new TextRank({ windowSize: 2 });
    const result = textRank.rank(['市场', '情绪', '市场', '资金', '市场', '预期']);

    const market = result.keywords.find((item) => item.term === '市场');
    const sentiment = result.keywords.find((item) => item.term === '情绪');

    expect(market?.score ?? 0).toBeGreaterThan(sentiment?.score ?? 0);
  });
});
