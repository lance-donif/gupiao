import { describe, expect, it } from 'vitest';

import { extractSignalEntities } from '../../../src/services/friend-network-entity-extractor.js';
import type { IKeywordDictionarySnapshot } from '../../../src/services/keyword-dictionary.js';

const fixtureDict: IKeywordDictionarySnapshot = {
  stopwords: new Set(['记者', '今天']),
  highSignalTerms: ['新能源', '白银', '先进制造业'],
  canonicalGroups: [],
  buzzPositive: [],
  buzzNegative: [],
  blockingTerms: [],
  entryCount: 5,
  loadedAt: new Date('2026-09-11T00:00:00.000Z'),
};

describe('friend network entity extractor', () => {
  it('extracts dynamic signal entities instead of relying on fixed dictionary fragments', () => {
    const entities = extractSignalEntities([
      {
        title: '新能源扩产带动白银需求提升',
        summary: '伴生矿供给约束增强，先进制造业订单增长。',
      },
    ], fixtureDict);

    expect(entities).toEqual(expect.any(Array));
    expect(entities).toContain('新能源');
    expect(entities).toContain('白银');
    expect(entities).toContain('先进制造业');
  });
});
