import type {
  ICausalSignalGraphInput,
  IFriendNetworkGraphSnapshot,
  IFriendNetworkNodeSnapshot,
  IFriendNetworkRelationshipSnapshot,
} from './friend-network-types.js';
import type { FriendRelationType, FriendRelationDirection } from '../types/entities/friend-relationship.js';
import type { KeywordCategory } from '../types/entities/keyword.js';
import type { SignalTemperature } from '../types/entities/signal-node.js';

export interface IFriendNetworkBuilderInputItem {
  readonly id: string;
  readonly entities: readonly string[];
  readonly reason: string;
}

const MAX_ENTITIES_PER_ITEM = 4;

type NodeCategory = IFriendNetworkNodeSnapshot['category'];

const isAllowedPair = (sourceCategory: NodeCategory, targetCategory: NodeCategory): boolean => {
  if (sourceCategory === 'theme' && targetCategory === 'theme') { return false; }
  return true;
};

const classifyCategory = (keyword: string): IFriendNetworkNodeSnapshot['category'] => {
  if (keyword.includes('白银') || keyword.includes('黄金')) { return 'theme'; }
  if (keyword.includes('新能源') || keyword.includes('制造')) { return 'industry'; }
  return 'other';
};

export const buildFriendNetworkGraph = (
  items: readonly IFriendNetworkBuilderInputItem[],
): IFriendNetworkGraphSnapshot => {
  const nodeFrequency = new Map<string, number>();
  const edgeMap = new Map<string, IFriendNetworkRelationshipSnapshot>();

  for (const item of items) {
    const uniqueEntities = [...new Set(item.entities)].slice(0, MAX_ENTITIES_PER_ITEM);
    for (const entity of uniqueEntities) {
      nodeFrequency.set(entity, (nodeFrequency.get(entity) ?? 0) + 1);
    }

    for (let index = 0; index < uniqueEntities.length; index += 1) {
      for (let nextIndex = index + 1; nextIndex < uniqueEntities.length; nextIndex += 1) {
        const sourceKeyword = uniqueEntities[index];
        const targetKeyword = uniqueEntities[nextIndex];
        if (!sourceKeyword || !targetKeyword) { continue; }

        const sourceCategory = classifyCategory(sourceKeyword);
        const targetCategory = classifyCategory(targetKeyword);
        if (!isAllowedPair(sourceCategory, targetCategory)) { continue; }

        const key = `${sourceKeyword}::${targetKeyword}`;
        const previous = edgeMap.get(key);
        edgeMap.set(key, {
          sourceKeyword,
          targetKeyword,
          relationType: sourceCategory === 'industry' || targetCategory === 'industry' ? 'driver' : 'derived',
          direction: 'forward',
          confidence: previous ? Math.min(previous.confidence + 0.05, 0.95) : 0.72,
          status: 'effective',
          weakSignal: true,
          evidence: [...new Set([...(previous?.evidence ?? []), item.reason])],
          updatedAt: new Date('2026-03-17T12:00:00.000Z').toISOString(),
        });
      }
    }
  }

  const nodes: IFriendNetworkNodeSnapshot[] = [...nodeFrequency.entries()].map(([keyword, frequency]) => ({
    keyword,
    frequency,
    temperature: frequency >= 2 ? 'hot' : 'cold',
    weakSignal: false,
    category: classifyCategory(keyword),
  }));

  return {
    nodes,
    relationships: [...edgeMap.values()],
  };
};

// ---- 因果边构建（基于 CausalSignalCandidate） ----

const CAUSAL_CONFIDENCE_WEAK_SIGNAL_THRESHOLD = 0.55;
const COOCCURRENCE_FALLBACK_CONFIDENCE_FACTOR = 0.60;

const directionToRelationType = (direction: ICausalSignalGraphInput['direction']): FriendRelationType => {
  switch (direction) {
    case 'positive':
      return 'driver';
    case 'negative':
      return 'reverse';
    case 'mixed':
      return 'synchronous';
    case 'neutral':
      return 'derived';
  }
};

const directionToRelationDirection = (direction: ICausalSignalGraphInput['direction']): FriendRelationDirection => {
  switch (direction) {
    case 'mixed':
      return 'bidirectional';
    default:
      return 'forward';
  }
};

const classifyKeywordCategory = (keyword: string): KeywordCategory => {
  if (/需求|供给|库存|产能|产量|价格|销量|订单|出口|采购|消费|资金|政策|补贴|融资|capex/iu.test(keyword)) {
    return 'macro';
  }
  return 'theme';
};

const classifyNodeTemperature = (frequency: number): SignalTemperature => {
  return frequency >= 2 ? 'hot' : 'warming';
};

/**
 * 从 CausalSignalCandidate 构建因果驱动边和节点。
 *
 * 每条 signal 映射为一条边：businessVariable(驱动原因) -> assetOrThemeKeyword(资产/主题)，
 * 方向/关系类型/置信度直接来自结构化因果抽取结果，不再使用共现累加。
 */
export const buildCausalGraphEdges = (
  signals: readonly ICausalSignalGraphInput[],
): IFriendNetworkGraphSnapshot => {
  const nodeFrequency = new Map<string, number>();
  const nodeCategory = new Map<string, KeywordCategory>();
  const edgeMap = new Map<string, IFriendNetworkRelationshipSnapshot>();

  for (const signal of signals) {
    const driver = signal.businessVariable;
    const asset = signal.assetOrThemeKeyword;

    if (!driver || !asset) {
      continue;
    }

    // 节点：驱动原因
    const freqDriver = (nodeFrequency.get(driver) ?? 0) + 1;
    nodeFrequency.set(driver, freqDriver);
    if (!nodeCategory.has(driver)) {
      nodeCategory.set(driver, 'macro');
    }

    // 节点：资产/主题
    const freqAsset = (nodeFrequency.get(asset) ?? 0) + 1;
    nodeFrequency.set(asset, freqAsset);
    if (!nodeCategory.has(asset)) {
      nodeCategory.set(asset, classifyKeywordCategory(asset));
    }

    // 边：driver -> asset
    const edgeKey = `${driver}::${asset}`;
    const previous = edgeMap.get(edgeKey);
    const relationType = directionToRelationType(signal.direction);
    const now = new Date().toISOString();

    // 多 signal 命中同边时取最高置信度，合并 evidence
    const prevConfidence = previous?.confidence ?? 0;
    const mergedConfidence = Math.max(prevConfidence, signal.confidence);
    const mergedEvidence = [...new Set([
      ...(previous?.evidence ?? []),
      `[${signal.direction}] ${signal.evidenceText} (newsId:${signal.newsId})`,
    ])];

    const sourceFreq = nodeFrequency.get(driver) ?? 1;
    const isWeakSignal = signal.confidence < CAUSAL_CONFIDENCE_WEAK_SIGNAL_THRESHOLD && sourceFreq <= 1;

    edgeMap.set(edgeKey, {
      sourceKeyword: driver,
      targetKeyword: asset,
      relationType,
      direction: directionToRelationDirection(signal.direction),
      confidence: Number(mergedConfidence.toFixed(4)),
      status: 'effective',
      weakSignal: isWeakSignal,
      evidence: mergedEvidence,
      updatedAt: now,
    });
  }

  const nodes: IFriendNetworkNodeSnapshot[] = [...nodeFrequency.entries()].map(([keyword, frequency]) => ({
    keyword,
    frequency,
    temperature: classifyNodeTemperature(frequency),
    weakSignal: frequency === 1,
    category: nodeCategory.get(keyword) ?? 'other',
  }));

  return {
    nodes,
    relationships: [...edgeMap.values()],
  };
};

/**
 * 将共现边（来自 buildFriendNetworkGraph）作为辅助边降级后与因果边合并。
 * - 因果边保留其原始 confidence 和属性
 * - 共现边降权标记为 weakSignal=true，仅当无因果边覆盖同一关键词时追加
 * - 边去重以 `sourceKeyword::targetKeyword` 为 key，因果边优先
 */
export const mergeCausalAndCoOccurrenceGraphs = (
  causalGraph: IFriendNetworkGraphSnapshot,
  coOccurrenceGraph: IFriendNetworkGraphSnapshot,
): IFriendNetworkGraphSnapshot => {
  const causalEdgeKeys = new Set<string>(
    causalGraph.relationships.map(e => `${e.sourceKeyword}::${e.targetKeyword}`),
  );

  // 降级共现边：标记 weakSignal，降权
  const downgradedEdges = coOccurrenceGraph.relationships
    .filter(edge => !causalEdgeKeys.has(`${edge.sourceKeyword}::${edge.targetKeyword}`))
    .map(edge => ({
      ...edge,
      confidence: Number((edge.confidence * COOCCURRENCE_FALLBACK_CONFIDENCE_FACTOR).toFixed(4)),
      weakSignal: true,
    }));

  // 合并节点（因果优先，补共现独有的）
  const causalNodeKeywords = new Set(causalGraph.nodes.map(n => n.keyword));
  const mergedNodes = [
    ...causalGraph.nodes,
    ...coOccurrenceGraph.nodes.filter(n => !causalNodeKeywords.has(n.keyword)),
  ];

  return {
    nodes: mergedNodes,
    relationships: [...causalGraph.relationships, ...downgradedEdges],
  };
};
