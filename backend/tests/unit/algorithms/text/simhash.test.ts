import { describe, expect, it } from 'vitest';

import {
  SimHash,
  type SimHashFingerprint,
} from '../../../../src/algorithms/text/simhash.js';

describe('SimHash', () => {
  it('produces deterministic fingerprints for identical Chinese text', () => {
    const simHash = new SimHash();
    const text = '人工智能推动股票分析效率提升';

    const firstFingerprint = simHash.computeFingerprint(text);
    const secondFingerprint = simHash.computeFingerprint(text);

    expect(secondFingerprint).toEqual<SimHashFingerprint>(firstFingerprint);
    expect(firstFingerprint.bitLength).toBe(64);
    expect(firstFingerprint.binary).toHaveLength(64);
  });

  it('assigns a smaller Hamming distance to semantically closer texts', () => {
    const simHash = new SimHash();

    const baseline = simHash.computeFingerprint('新能源股票上涨，市场情绪积极');
    const nearDuplicate = simHash.computeFingerprint('新能源股票上涨 市场情绪积极');
    const unrelated = simHash.computeFingerprint('体育赛事门票销售创下新高');

    const nearDistance = simHash.computeDistance(baseline, nearDuplicate);
    const farDistance = simHash.computeDistance(baseline, unrelated);

    expect(nearDistance).toBeLessThan(farDistance);
  });
});
