import { describe, expect, it } from 'vitest';
import { parseInitialStocks } from '../../../scripts/initialize-data.js';

describe('parseInitialStocks', () => {
  it('normalizes supported fields, deduplicates and rejects invalid symbols', () => {
    expect(parseInitialStocks([
      { code: '000001', name: 'First' },
      { symbol: '600001', stock_name: 'Second' },
      { code: '000001', name: 'Updated' },
      { code: 'invalid', name: 'Invalid' },
      { code: '000002', name: '' },
    ])).toEqual([{ symbol: '000001', name: 'Updated' }, { symbol: '600001', name: 'Second' }]);
  });

  it('fails on empty or malformed upstream data', () => {
    expect(() => parseInitialStocks([])).toThrow('empty');
    expect(() => parseInitialStocks({ error: 'failed' })).toThrow('array');
  });
});
