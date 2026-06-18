import { describe, expect, it } from 'vitest';
import { clamp } from '../../../src/lib/number-utils.js';
import {
  normalizeDecimalNumber,
  normalizeDirectionWeight,
  normalizeKeyword,
  longestCommonSubstringLength,
  calculateTimeDecay,
  calculateExposureBreadthWeight,
} from '../../../src/services/scoring-utils.js';

describe('scoring-utils unit tests', () => {
  describe('clamp', () => {
    it('should clamp values to specified range', () => {
      expect(clamp(5, 0, 10)).toBe(5);
      expect(clamp(-5, 0, 10)).toBe(0);
      expect(clamp(15, 0, 10)).toBe(10);
    });
  });

  describe('normalizeDecimalNumber', () => {
    it('should parse valid numbers and fallback on invalid ones', () => {
      expect(normalizeDecimalNumber('12.34', 0)).toBe(12.34);
      expect(normalizeDecimalNumber(45.6, 0)).toBe(45.6);
      expect(normalizeDecimalNumber(null, 5)).toBe(0);
      expect(normalizeDecimalNumber(undefined, 5)).toBe(5);
      expect(normalizeDecimalNumber('abc', 10)).toBe(10);
    });
  });

  describe('normalizeDirectionWeight', () => {
    it('should map directions to correct weights', () => {
      expect(normalizeDirectionWeight('positive')).toBe(1);
      expect(normalizeDirectionWeight('mixed')).toBe(0.35);
      expect(normalizeDirectionWeight('negative')).toBe(-1);
      expect(normalizeDirectionWeight('neutral')).toBe(0);
      expect(normalizeDirectionWeight('unknown')).toBe(0);
    });
  });

  describe('normalizeKeyword', () => {
    it('should strip spaces, punctuation, Roman numerals and convert to lowercase', () => {
      expect(normalizeKeyword('白银价格 (A股)')).toBe('白银价格a股');
      expect(normalizeKeyword('黄金 Ⅱ')).toBe('黄金');
      expect(normalizeKeyword('  新能源，光伏;  ')).toBe('新能源光伏');
    });
  });

  describe('longestCommonSubstringLength', () => {
    it('should return 0 for empty strings', () => {
      expect(longestCommonSubstringLength('', 'abc')).toBe(0);
      expect(longestCommonSubstringLength('abc', '')).toBe(0);
    });

    it('should prune calculation if length ratio is skewed', () => {
      // ratio: 3/10 = 0.3 < 0.6 -> returns 0
      expect(longestCommonSubstringLength('abc', 'abcdefghij')).toBe(0);
    });

    it('should compute correct LCS for valid inputs', () => {
      expect(longestCommonSubstringLength('abcdef', 'bcde')).toBe(4);
      expect(longestCommonSubstringLength('新能源光伏', '光伏产业')).toBe(2);
      expect(longestCommonSubstringLength('高端制造伴生矿', '高端制造需求大')).toBe(4);
    });
  });

  describe('calculateTimeDecay', () => {
    it('should compute decay factor correctly', () => {
      const now = new Date('2026-06-15T12:00:00.000Z');
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const halfLifeDays = 2;
      const lambda = Math.log(2) / halfLifeDays;

      const { decayFactor, t } = calculateTimeDecay(yesterday, now, lambda, 7);
      expect(t).toBeCloseTo(1, 4);
      expect(decayFactor).toBeCloseTo(Math.exp(-lambda * 1), 4);
    });

    it('should return 0 decay if window exceeded', () => {
      const now = new Date('2026-06-15T12:00:00.000Z');
      const longAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
      const halfLifeDays = 2;
      const lambda = Math.log(2) / halfLifeDays;

      const { decayFactor } = calculateTimeDecay(longAgo, now, lambda, 7);
      expect(decayFactor).toBe(0);
    });
  });

  describe('calculateExposureBreadthWeight', () => {
    it('should return correct breadth weight', () => {
      expect(calculateExposureBreadthWeight(0)).toBe(1);
      expect(calculateExposureBreadthWeight(-1)).toBe(1);
      expect(calculateExposureBreadthWeight(4)).toBeCloseTo(1 / Math.sqrt(4), 4);
      expect(calculateExposureBreadthWeight(10000)).toBe(0.08); // caps at min weight 0.08
    });
  });
});
