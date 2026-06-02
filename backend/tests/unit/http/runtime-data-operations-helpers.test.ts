import { describe, expect, it } from 'vitest';

import {
  buildNodesFromDbSteps,
  resolveCurrentStage,
  toWebBatchStatus,
} from '../../../src/http/runtime-data-operations.js';

describe('runtime-data-operations helpers', () => {
  describe('toWebBatchStatus', () => {
    it('maps RunTrace SUCCESS to COMPLETED', () => {
      expect(toWebBatchStatus('SUCCESS')).toBe('COMPLETED');
    });
    it('maps FAILED to FAILED', () => {
      expect(toWebBatchStatus('FAILED')).toBe('FAILED');
    });
    it('maps PENDING to PENDING', () => {
      expect(toWebBatchStatus('PENDING')).toBe('PENDING');
    });
    it('maps RUNNING and any other status to RUNNING', () => {
      expect(toWebBatchStatus('RUNNING')).toBe('RUNNING');
      expect(toWebBatchStatus('UNKNOWN')).toBe('RUNNING');
    });
  });

  describe('buildNodesFromDbSteps', () => {
    it('returns 9 pipeline nodes when DB rows are empty', () => {
      const nodes = buildNodesFromDbSteps([]);
      expect(nodes).toHaveLength(9);
      expect(nodes.every(node => node.status === 'pending')).toBe(true);
      expect(nodes[0]!.node_id).toBe('news_fetch');
      expect(nodes[7]!.node_id).toBe('scoring_recommendation');
      expect(nodes[8]!.node_id).toBe('strategy_experiment');
    });

    it('marks matched DB rows with their completion status', () => {
      const nodes = buildNodesFromDbSteps([
        { stepName: 'news_fetch', status: 'SUCCESS', startedAt: '2026-05-25T08:00:00Z', endedAt: '2026-05-25T08:00:10Z', errorMessage: null },
        { stepName: 'normalize', status: 'RUNNING', startedAt: '2026-05-25T08:00:10Z', endedAt: null, errorMessage: null },
      ]);
      const news = nodes.find(node => node.node_id === 'news_fetch')!;
      const norm = nodes.find(node => node.node_id === 'normalize')!;
      const dedup = nodes.find(node => node.node_id === 'deduplicate')!;
      expect(news.status).toBe('completed');
      expect(news.has_result).toBe(true);
      expect(news.finished_at).toBe('2026-05-25T08:00:10Z');
      expect(norm.status).toBe('running');
      expect(norm.has_result).toBe(false);
      expect(dedup.status).toBe('pending');
    });

    it('marks failed step with errorMessage as current_label', () => {
      const nodes = buildNodesFromDbSteps([
        { stepName: 'news_fetch', status: 'FAILED', startedAt: '2026-05-25T08:00:00Z', endedAt: '2026-05-25T08:00:05Z', errorMessage: 'LLM timeout' },
      ]);
      const news = nodes.find(node => node.node_id === 'news_fetch')!;
      expect(news.status).toBe('failed');
      expect(news.current_label).toBe('LLM timeout');
    });
  });

  describe('resolveCurrentStage', () => {
    it('returns completed when run status is SUCCESS', () => {
      const nodes = buildNodesFromDbSteps([]);
      const stage = resolveCurrentStage('SUCCESS', nodes);
      expect(stage.currentStage).toBe('completed');
      expect(stage.currentStageIndex).toBe(nodes.length);
      expect(stage.remainingNodeCount).toBe(0);
    });

    it('returns first failed node when run status is FAILED', () => {
      const nodes = buildNodesFromDbSteps([
        { stepName: 'news_fetch', status: 'SUCCESS', startedAt: '2026-05-25T08:00:00Z', endedAt: '2026-05-25T08:00:10Z', errorMessage: null },
        { stepName: 'normalize', status: 'FAILED', startedAt: '2026-05-25T08:00:10Z', endedAt: '2026-05-25T08:00:15Z', errorMessage: 'parse failed' },
      ]);
      const stage = resolveCurrentStage('FAILED', nodes);
      expect(stage.currentStage).toBe('normalize');
      expect(stage.currentStageIndex).toBe(1); // sequence_no - 1
      expect(stage.remainingNodeCount).toBeGreaterThan(0);
    });

    it('returns currently running node', () => {
      const nodes = buildNodesFromDbSteps([
        { stepName: 'news_fetch', status: 'SUCCESS', startedAt: '2026-05-25T08:00:00Z', endedAt: '2026-05-25T08:00:10Z', errorMessage: null },
        { stepName: 'normalize', status: 'RUNNING', startedAt: '2026-05-25T08:00:10Z', endedAt: null, errorMessage: null },
      ]);
      const stage = resolveCurrentStage('RUNNING', nodes);
      expect(stage.currentStage).toBe('normalize');
      expect(stage.currentStageIndex).toBe(1);
    });

    it('returns last completed node when nothing is currently running', () => {
      const nodes = buildNodesFromDbSteps([
        { stepName: 'news_fetch', status: 'SUCCESS', startedAt: '2026-05-25T08:00:00Z', endedAt: '2026-05-25T08:00:10Z', errorMessage: null },
      ]);
      const stage = resolveCurrentStage('RUNNING', nodes);
      expect(stage.currentStage).toBe('news_fetch');
      expect(stage.currentStageIndex).toBe(1);
    });

    it('returns pending stage when nothing has started', () => {
      const nodes = buildNodesFromDbSteps([]);
      const stage = resolveCurrentStage('PENDING', nodes);
      expect(stage.currentStage).toBe('pending');
      expect(stage.currentStageIndex).toBe(0);
      expect(stage.remainingNodeCount).toBe(nodes.length);
    });
  });
});
