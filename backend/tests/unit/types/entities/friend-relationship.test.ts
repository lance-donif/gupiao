import { describe, expect, it } from 'vitest';

import { FriendRelationship } from '../../../../src/types/entities/friend-relationship.js';

describe('FriendRelationship', () => {
  it('stores directed relation with status, weak signal and evidence', () => {
    const relation = new FriendRelationship({
      sourceKeyword: '新能源',
      targetKeyword: '白银',
      relationType: 'driver',
      direction: 'forward',
      confidence: 0.82,
      status: 'effective',
      weakSignal: true,
      evidence: ['新能源扩产带动白银需求'],
      updatedAt: new Date('2026-03-17T12:00:00.000Z'),
    });

    expect(relation.sourceKeyword).toBe('新能源');
    expect(relation.targetKeyword).toBe('白银');
    expect(relation.status).toBe('effective');
    expect(relation.weakSignal).toBe(true);
  });
});
