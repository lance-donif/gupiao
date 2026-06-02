import { describe, expect, it } from 'vitest';

import { Symbol } from '../../../../src/types/value-objects/symbol.js';

describe('Symbol', () => {
  it('accepts exactly six digits', () => {
    expect(Symbol.from('600000').toString()).toBe('600000');
  });

  it('rejects invalid formats', () => {
    expect(() => Symbol.from('60000')).toThrowError('Invalid symbol: 60000');
    expect(() => Symbol.from('ABC123')).toThrowError('Invalid symbol: ABC123');
  });

  it('is immutable after construction', () => {
    const symbol = Symbol.from('000001');

    expect(Object.isFrozen(symbol)).toBe(true);
    expect(Reflect.set(symbol as object, 'value', '600000')).toBe(false);
    expect(symbol.toString()).toBe('000001');
  });

  it('compares equality by underlying value', () => {
    expect(Symbol.from('600000').equals(Symbol.from('600000'))).toBe(true);
    expect(Symbol.from('600000').equals(Symbol.from('000001'))).toBe(false);
  });
});
