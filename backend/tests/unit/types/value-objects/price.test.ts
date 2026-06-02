import { describe, expect, it } from 'vitest';

import { Price } from '../../../../src/types/value-objects/price.js';

describe('Price', () => {
  it('rounds to two decimal places', () => {
    expect(Price.from(12.345).valueOf()).toBe(12.35);
    expect(Price.from(12.344).valueOf()).toBe(12.34);
  });

  it('rejects negative and non-finite values', () => {
    expect(() => Price.from(-0.01)).toThrowError('Invalid price: -0.01');
    expect(() => Price.from(Number.NaN)).toThrowError('Invalid price: NaN');
  });

  it('is immutable after construction', () => {
    const price = Price.from(10);

    expect(Object.isFrozen(price)).toBe(true);
    expect(Reflect.set(price as object, 'value', 99)).toBe(false);
    expect(price.valueOf()).toBe(10);
  });

  it('compares equality by normalized value', () => {
    expect(Price.from(10).equals(Price.from(10.001))).toBe(true);
    expect(Price.from(10).equals(Price.from(10.02))).toBe(false);
  });
});
