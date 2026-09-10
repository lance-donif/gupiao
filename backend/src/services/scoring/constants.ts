/**
 * 评分组件权重 / 上限常量。
 * 由 scoring-contribution-engine.ts 原样搬迁而来，值逐字符不变；
 * 其中四项权重改为从 `version.ts` 的 `DEFAULT_BUSINESS_CONFIG.scoring` 派生，
 * 使「业务配置指纹」与「实际参与计算的权重」只有一个真源。
 */

import { DEFAULT_BUSINESS_CONFIG } from '../../version.js';

const SCORING_WEIGHTS = DEFAULT_BUSINESS_CONFIG.scoring;

export const GRAPH_RELATION_CONFIDENCE_CAP = 2.0;
export const GRAPH_WEAK_SIGNAL_CAP = 1.0;
export const GRAPH_WEAK_NODE_BONUS = 0.5;
export const GRAPH_WEAK_EDGE_BONUS = 0.25;
export const BROAD_EXPOSURE_MIN_WEIGHT = 0.08;
export const EVIDENCE_SCORE_MAX = SCORING_WEIGHTS.evidenceMax;
export const GRAPH_SCORE_MAX = SCORING_WEIGHTS.graphMax;
export const EXPOSURE_PRECISION_SCORE_MAX = SCORING_WEIGHTS.exposureMax;
export const MARKET_SIGNAL_SCORE_MAX = SCORING_WEIGHTS.marketMax;
export const GRAPH_RELATION_SCORE_MAX = SCORING_WEIGHTS.graphRelationMax;
export const GRAPH_WEAK_SIGNAL_SCORE_MAX = SCORING_WEIGHTS.graphWeakMax;
export const EVIDENCE_KEYWORD_CONTRIB_CAP = 1.5;
export const EVIDENCE_DIVERSITY_MIN_CONTRIB = 0.2;
export const MOVEMENT_CONFIRMATION_SCORE_CAP = 2;
export const MOVEMENT_CONFIRMATION_UNIT_SCORE = 0.8;
export const MAX_MOVEMENT_EVIDENCE_PER_SYMBOL = 3;
export const DIRECT_STOCK_NAME_MATCH_MIN_LENGTH = 4;
