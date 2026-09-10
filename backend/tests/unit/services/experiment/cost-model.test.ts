import { describe, expect, it } from 'vitest';
import { applyRoundTripCost, simulateRotatingCapital } from '../../../../src/services/experiment/cost-model.js';

describe('cost model', () => {
  it('subtracts two-sided cost', () => {
    const r = applyRoundTripCost(0.01, { basisPointsPerSide: 10 });
    expect(r.costBps).toBe(20);
    expect(r.net).toBeCloseTo(0.01 - 0.002, 12);
  });

  it('simulates rotating capital without freeing restricted cash (basic equity path)', () => {
    const result = simulateRotatingCapital([1, 1], [0.05, -0.02], { basisPointsPerSide: 10 });
    expect(result.finalEquity).toBeCloseTo((1 + (0.05 - 0.002)) * (1 + (-0.02 - 0.002)), 10);
  });
});
