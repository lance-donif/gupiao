import { describe, expect, it } from 'vitest';
import {
  STAGE_DEPENDENCIES,
  STAGE_IDS,
  LEGACY_STEP_TO_STAGE,
  resolveStageOrder,
  dependenciesOf,
  dependentsOf,
  dependenciesSatisfied,
  type StageId,
} from '../../../src/services/pipeline/stage-registry.js';
import {
  STAGE_STATUSES,
  STAGE_STATUS_TRANSITIONS,
  TERMINAL_STAGE_STATUSES,
  isValidStageTransition,
  isStageStatus,
  assertStageTransition,
} from '../../../src/services/pipeline/stage-status.js';
import { resolveScoringRecipe, resolveStageExecutor } from '../../../src/version.js';

describe('pipeline stage registry', () => {
  it('exposes 14 unique stage ids', () => {
    expect(STAGE_IDS).toHaveLength(14);
    expect(new Set(STAGE_IDS).size).toBe(14);
    for (const id of STAGE_IDS) {
      expect(STAGE_DEPENDENCIES[id]).toBeDefined();
    }
  });

  it('resolves a deterministic order where every dependency precedes its stage', () => {
    const order = resolveStageOrder();
    expect(order).toHaveLength(14);
    expect(new Set(order).size).toBe(14);

    const position = new Map<StageId, number>(order.map((id, index) => [id, index] as const));
    for (const id of order) {
      const selfIndex = position.get(id) as number;
      for (const dependency of STAGE_DEPENDENCIES[id]) {
        expect(position.get(dependency) as number).toBeLessThan(selfIndex);
      }
    }
    expect(resolveStageOrder()).toEqual(order);
  });

  it('keeps the resolved order isomorphic to the logical STAGE_IDS sequence', () => {
    // 阶段的逻辑顺序本身就是合法拓扑序，Kahn 贪心必须原样返回，
    // 这样阶段执行器与现有脚本的串行顺序保持同构。
    expect(resolveStageOrder()).toEqual(STAGE_IDS);
  });

  it('maps every legacy step name to a valid StageId', () => {
    const valid = new Set<string>(STAGE_IDS);
    const entries = Object.entries(LEGACY_STEP_TO_STAGE);
    expect(entries.length).toBeGreaterThan(0);
    for (const [legacy, stage] of entries) {
      expect(legacy.length).toBeGreaterThan(0);
      expect(valid.has(stage)).toBe(true);
    }
  });

  it('exposes dependency helpers consistent with the dependency map', () => {
    expect(dependenciesOf('evidence_score')).toEqual(STAGE_DEPENDENCIES.evidence_score);
    expect(dependentsOf('news_fetch')).toContain('news_prepare');
    expect(dependentsOf('evidence_score')).toEqual(
      expect.arrayContaining(['recommendation_select', 'strategy_evaluation']),
    );

    for (const id of STAGE_IDS) {
      for (const dependency of STAGE_DEPENDENCIES[id]) {
        expect(dependentsOf(dependency)).toContain(id);
      }
    }
  });

  it('checks dependency satisfaction', () => {
    expect(dependenciesSatisfied('news_fetch', new Set())).toBe(true);
    expect(dependenciesSatisfied('news_prepare', new Set())).toBe(false);
    expect(dependenciesSatisfied('news_prepare', new Set(['news_fetch']))).toBe(true);

    const evidenceDeps = STAGE_DEPENDENCIES.evidence_score;
    expect(dependenciesSatisfied('evidence_score', new Set(evidenceDeps))).toBe(true);
    expect(dependenciesSatisfied('evidence_score', new Set(evidenceDeps.slice(1)))).toBe(false);
  });
});

describe('pipeline stage status machine', () => {
  it('marks SUCCESS and FAILED as terminal with no outgoing edges', () => {
    expect(TERMINAL_STAGE_STATUSES).toEqual(['SUCCESS', 'FAILED']);
    expect(STAGE_STATUS_TRANSITIONS.SUCCESS).toEqual([]);
    expect(STAGE_STATUS_TRANSITIONS.FAILED).toEqual([]);
    expect(isValidStageTransition('SUCCESS', 'RUNNING')).toBe(false);
    expect(isValidStageTransition('FAILED', 'PENDING')).toBe(false);
  });

  it('rejects invalid transitions and accepts valid ones', () => {
    expect(isValidStageTransition('PENDING', 'SUCCESS')).toBe(false);
    expect(isValidStageTransition('RUNNING', 'SUCCESS')).toBe(true);
    expect(isValidStageTransition('WAITING', 'RUNNING')).toBe(true);
    expect(isValidStageTransition('PAUSED', 'PENDING')).toBe(true);
    expect(isValidStageTransition('NEEDS_ATTENTION', 'PENDING')).toBe(true);

    expect(() => assertStageTransition('PENDING', 'SUCCESS')).toThrow(/PENDING/);
    expect(() => assertStageTransition('PENDING', 'SUCCESS')).toThrow(/SUCCESS/);
    expect(() => assertStageTransition('RUNNING', 'SUCCESS')).not.toThrow();
  });

  it('keeps isValidStageTransition and assertStageTransition consistent', () => {
    for (const from of STAGE_STATUSES) {
      for (const to of STAGE_STATUSES) {
        const valid = isValidStageTransition(from, to);
        if (valid) {
          expect(() => assertStageTransition(from, to)).not.toThrow();
        }
        else {
          expect(() => assertStageTransition(from, to)).toThrow();
        }
      }
    }
  });

  it('recognizes stage status strings', () => {
    expect(isStageStatus('SUCCESS')).toBe(true);
    expect(isStageStatus('NOPE')).toBe(false);
  });
});

describe('version resolvers', () => {
  it('defaults scoring recipe to event-v2 (forced production switch)', () => {
    expect(resolveScoringRecipe({})).toBe('event-v2');
    expect(resolveScoringRecipe({ SCORING_RECIPE: 'baseline-v1' })).toBe('baseline-v1');
    expect(resolveScoringRecipe({ SCORING_RECIPE: 'event-v2' })).toBe('event-v2');
    expect(() => resolveScoringRecipe({ SCORING_RECIPE: 'bogus' })).toThrow();
  });

  it('defaults stage executor to registry', () => {
    expect(resolveStageExecutor({})).toBe('registry');
    expect(resolveStageExecutor({ PIPELINE_STAGE_EXECUTOR: 'legacy' })).toBe('legacy');
    expect(resolveStageExecutor({ PIPELINE_STAGE_EXECUTOR: 'registry' })).toBe('registry');
    expect(() => resolveStageExecutor({ PIPELINE_STAGE_EXECUTOR: 'bogus' })).toThrow();
  });
});
