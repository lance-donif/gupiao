import { describe, expect, it } from 'vitest';

import { Timestamp } from '../../../../src/types/value-objects/timestamp.js';

describe('Timestamp', () => {
  it('creates from Date, string, and number inputs', () => {
    const expected = Date.parse('2025-03-14T09:30:00.000Z');

    expect(Timestamp.from(new Date(expected)).valueOf()).toBe(expected);
    expect(Timestamp.from('2025-03-14T09:30:00.000Z').valueOf()).toBe(expected);
    expect(Timestamp.from(expected).valueOf()).toBe(expected);
  });

  it('rejects invalid inputs', () => {
    expect(() => Timestamp.from('not-a-date')).toThrowError('Invalid timestamp: not-a-date');
  });

  it('is immutable after construction', () => {
    const timestamp = Timestamp.from('2025-03-14T09:30:00.000Z');

    expect(Object.isFrozen(timestamp)).toBe(true);
    expect(Reflect.set(timestamp as object, 'value', 0)).toBe(false);
    expect(timestamp.toISOString()).toBe('2025-03-14T09:30:00.000Z');
  });

  it('compares equality by instant', () => {
    expect(
      Timestamp.from('2025-03-14T09:30:00.000Z').equals(
        Timestamp.from(Date.parse('2025-03-14T09:30:00.000Z')),
      ),
    ).toBe(true);
    expect(
      Timestamp.from('2025-03-14T09:30:00.000Z').equals(
        Timestamp.from('2025-03-14T09:31:00.000Z'),
      ),
    ).toBe(false);
  });
});
