import { describe, expect, it } from 'vitest';
import { blockBootstrap } from '../../../../src/services/experiment/bootstrap.js';

describe('bootstrap', () => {
  it('produces deterministic CI with fixed seed', () => {
    const returns = Array.from({ length: 40 }, (_, i) => (i % 5 === 0 ? -0.01 : 0.002));
    const a = blockBootstrap(returns, { iterations: 50, blockLength: 5, seed: 7 });
    const b = blockBootstrap(returns, { iterations: 50, blockLength: 5, seed: 7 });
    expect(a.samples).toEqual(b.samples);
    expect(a.lower).toBeLessThanOrEqual(a.mean);
  });
});
