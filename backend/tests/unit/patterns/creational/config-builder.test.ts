import { describe, expect, it } from 'vitest';

import { ConfigBuilder } from '../../../../src/index.js';

describe('ConfigBuilder', () => {
  it('supports fluent chained construction with explicit overrides', () => {
    const config = new ConfigBuilder()
      .setSourceType('api')
      .setRetryCount(5)
      .setTimeoutMs(2_500)
      .setDryRun(true)
      .addMetadata('market', 'cn')
      .addMetadata('priority', 'high')
      .build();

    expect(config).toEqual({
      sourceType: 'api',
      retryCount: 5,
      timeoutMs: 2_500,
      dryRun: true,
      metadata: {
        market: 'cn',
        priority: 'high',
      },
    });
  });

  it('returns immutable config snapshots and does not mutate previously built results', () => {
    const builder = new ConfigBuilder().setSourceType('memory').setRetryCount(1);

    const first = builder.build();
    const second = builder.setTimeoutMs(500).build();

    expect(first).toEqual({
      sourceType: 'memory',
      retryCount: 1,
      timeoutMs: 1_000,
      dryRun: false,
      metadata: {},
    });
    expect(second).toEqual({
      sourceType: 'memory',
      retryCount: 1,
      timeoutMs: 500,
      dryRun: false,
      metadata: {},
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.metadata)).toBe(true);
  });

  it('validates builder inputs', () => {
    const builder = new ConfigBuilder();

    expect(() => builder.setSourceType('')).toThrowError('sourceType must not be empty');
    expect(() => builder.setRetryCount(-1)).toThrowError(
      'retryCount must be a non-negative integer',
    );
    expect(() => builder.setTimeoutMs(0)).toThrowError(
      'timeoutMs must be a positive integer',
    );
  });
});
