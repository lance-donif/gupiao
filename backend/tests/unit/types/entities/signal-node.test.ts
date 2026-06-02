import { describe, expect, it } from 'vitest';

import { SignalNode } from '../../../../src/types/entities/signal-node.js';

describe('SignalNode', () => {
  it('captures keyword state for heat and weak signal tracking', () => {
    const node = new SignalNode({
      keyword: '白银',
      category: 'theme',
      temperature: 'warming',
      weakSignal: true,
      frequency: 3,
      updatedAt: new Date('2026-03-17T12:00:00.000Z'),
    });

    expect(node.keyword).toBe('白银');
    expect(node.temperature).toBe('warming');
    expect(node.weakSignal).toBe(true);
  });
});
