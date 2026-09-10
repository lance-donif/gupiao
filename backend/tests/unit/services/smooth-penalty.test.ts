import { describe, expect, it } from 'vitest';
import { calculateSmoothPenalty } from '../../../src/services/event-scoring/smooth-penalty.js';

describe('smooth penalty', () => {
  it('factor is 1 when n < 5', () => {
    const result = calculateSmoothPenalty([
      { keyword: '白银', return5DayPct: -0.05, ageSessions: 1, responsibilityWeight: 1 },
    ])[0];
    expect(result!.factor).toBe(1);
  });

  it('uses a global prior so a persistently losing keyword is actually penalized', () => {
    const losing = Array.from({ length: 10 }, (_, i) => ({
      keyword: '锂',
      return5DayPct: -0.05,
      ageSessions: i,
      responsibilityWeight: 1,
    }));
    const healthy = Array.from({ length: 10 }, (_, i) => ({
      keyword: '白银',
      return5DayPct: 0.02,
      ageSessions: i,
      responsibilityWeight: 1,
    }));
    const results = calculateSmoothPenalty([...losing, ...healthy]);
    const lithium = results.find(r => r.keyword === '锂')!;
    const silver = results.find(r => r.keyword === '白银')!;

    // 全局亏损率 = 亏损权重 / 全部权重，必须跨关键词计算。
    expect(lithium.p0).toBeCloseTo(silver.p0, 12);
    expect(lithium.n).toBeGreaterThan(5);
    expect(lithium.p).toBeGreaterThan(lithium.p0);
    expect(lithium.factor).toBeLessThan(1);
    // 无亏损关键词不会被降权。
    expect(silver.factor).toBe(1);
  });

  it('weight decay halves at one half-life', () => {
    const results = calculateSmoothPenalty([
      { keyword: 'k', return5DayPct: -0.05, ageSessions: 0, responsibilityWeight: 1 },
      { keyword: 'k', return5DayPct: -0.05, ageSessions: 20, responsibilityWeight: 1 },
    ]);
    const [d0, d1] = results[0]!.observations;
    expect(d0!.timeWeight).toBeCloseTo(1, 12);
    expect(d1!.timeWeight).toBeCloseTo(0.5, 12);
  });
});
