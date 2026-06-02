import type {
  IFriendNetworkGraphSnapshot,
  IFriendNetworkRelationshipSnapshot,
  IFriendNetworkTreeNode,
  IFriendNetworkTreeSnapshot,
} from './friend-network-types.js';

const MAX_CHILDREN_PER_NODE = 6;
const MAX_EXPANDED_ROOTS = 1;
const MAX_EXPANDED_TREE_NODES = 250;

export const projectFriendNetworkTree = (
  input: IFriendNetworkGraphSnapshot & { readonly depthLimit: number },
): IFriendNetworkTreeSnapshot => {
  const adjacency = new Map<string, IFriendNetworkRelationshipSnapshot[]>();
  const nodeByKeyword = new Map(input.nodes.map(node => [node.keyword, node]));

  for (const relationship of input.relationships) {
    const sourceList = adjacency.get(relationship.sourceKeyword) ?? [];
    sourceList.push(relationship);
    adjacency.set(relationship.sourceKeyword, sourceList);

    const targetList = adjacency.get(relationship.targetKeyword) ?? [];
    targetList.push(relationship);
    adjacency.set(relationship.targetKeyword, targetList);
  }

  for (const relationships of adjacency.values()) {
    relationships.sort((left, right) =>
      right.confidence - left.confidence
      || Number(right.weakSignal) - Number(left.weakSignal)
      || left.targetKeyword.localeCompare(right.targetKeyword),
    );
  }

  let expandedTreeNodeCount = 0;

  const buildNode = (keyword: string, depth: number, visited: ReadonlySet<string>): IFriendNetworkTreeNode => {
    expandedTreeNodeCount += 1;
    const node = nodeByKeyword.get(keyword);
    const nextVisited = new Set(visited);
    nextVisited.add(keyword);

    const childKeywords = depth >= input.depthLimit || expandedTreeNodeCount >= MAX_EXPANDED_TREE_NODES
      ? []
      : (adjacency.get(keyword) ?? [])
          .map(relationship => relationship.sourceKeyword === keyword ? relationship.targetKeyword : relationship.sourceKeyword)
          .filter(candidate => !nextVisited.has(candidate))
          .slice(0, MAX_CHILDREN_PER_NODE);

    const children: IFriendNetworkTreeNode[] = [];
    if (depth < input.depthLimit) {
      for (const candidate of childKeywords) {
        if (expandedTreeNodeCount >= MAX_EXPANDED_TREE_NODES) {
          break;
        }
        children.push(buildNode(candidate, depth + 1, nextVisited));
      }
    }

    return {
      keyword,
      weight: node?.frequency ?? 0,
      status: 'effective',
      temperature: node?.temperature ?? 'cold',
      weakSignal: node?.weakSignal ?? false,
      reasons: (adjacency.get(keyword) ?? []).flatMap(relationship => relationship.evidence).slice(0, 3),
      childrenKeywords: childKeywords,
      children,
    };
  };

  return {
    depthLimit: input.depthLimit,
    rootKeywords: input.nodes.map(node => node.keyword),
    roots: input.nodes.slice(0, MAX_EXPANDED_ROOTS).map(node => buildNode(node.keyword, 1, new Set<string>())),
  };
};
