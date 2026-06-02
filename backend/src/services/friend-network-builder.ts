import type {
  IFriendNetworkGraphSnapshot,
  IFriendNetworkNodeSnapshot,
  IFriendNetworkRelationshipSnapshot,
} from './friend-network-types.js';

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
