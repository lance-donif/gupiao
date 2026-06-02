import { describe, expect, it } from 'vitest';

import { TradeDate } from '../../../../src/types/value-objects/trade-date.js';

describe('TradeDate', () => {
  it('accepts valid trading days', () => {
    expect(TradeDate.from('2025-03-14').toString()).toBe('2025-03-14');
  });

  it('rejects weekends and configured market holidays', () => {
    expect(() => TradeDate.from('2025-03-15')).toThrowError('Not a trading day: 2025-03-15');
    expect(() => TradeDate.from('2025-10-01')).toThrowError('Not a trading day: 2025-10-01');
  });

  it('is immutable after construction', () => {
    const tradeDate = TradeDate.from('2025-03-14');

    expect(Object.isFrozen(tradeDate)).toBe(true);
    expect(Reflect.set(tradeDate as object, 'value', 0)).toBe(false);
    expect(tradeDate.toString()).toBe('2025-03-14');
  });

  it('compares equality by canonical trading day', () => {
    expect(TradeDate.from('2025-03-14').equals(TradeDate.from('2025-03-14T12:30:00+08:00'))).toBe(true);
    expect(TradeDate.from('2025-03-14').equals(TradeDate.from('2025-03-13'))).toBe(false);
  });
});
