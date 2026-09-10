import { describe, expect, it } from 'vitest';
import { generateRollingWindows } from '../../../../src/services/experiment/rolling-walk-forward.js';

describe('rolling walk-forward', () => {
  it('builds train/validation/test with gap', () => {
    const days = Array.from({ length: 200 }, (_, i) => { const d = new Date('2026-01-01T00:00:00.000Z'); d.setUTCDate(d.getUTCDate() + i); return d; });
    const windows = generateRollingWindows(days, { trainSessions: 30, validationSessions: 10, testSessions: 10, gapSessions: 3 });
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0]!.train).toHaveLength(30);
    expect(windows[0]!.validation).toHaveLength(10);
    expect(windows[0]!.test).toHaveLength(10);
  });
});
