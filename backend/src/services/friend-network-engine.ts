import type { IFriendNetworkGraphRepository } from '../repositories/interfaces/i-friend-network-graph-repository.js';
import type { IFriendNetworkAiAdapter } from './friend-network-ai-adapter.js';
import type {
  IAiRelationshipCandidate,
  IFriendNetworkEngineInput,
  IFriendNetworkEngineResult,
  IFriendNetworkGraphSnapshot,
  IFriendNetworkNodeSnapshot,
  IFriendNetworkPersistInput,
  IFriendNetworkRelationshipSnapshot,
} from './friend-network-types.js';
import { createStubFriendNetworkAiAdapter } from './friend-network-ai-adapter.js';
import { buildFriendNetworkGraph, buildCausalGraphEdges, mergeCausalAndCoOccurrenceGraphs } from './friend-network-builder.js';
import { extractSignalEntities } from './friend-network-entity-extractor.js';
import { projectFriendNetworkTree } from './friend-network-tree-projection.js';

export interface IFriendNetworkEngineDependencies {
  readonly aiAdapter?: IFriendNetworkAiAdapter;
  readonly graphRepository?: IFriendNetworkGraphRepository;
}

class FriendNetworkEngine {
  public constructor(private readonly dependencies: IFriendNetworkEngineDependencies = {}) {}

  public async run(input: IFriendNetworkEngineInput): Promise<IFriendNetworkEngineResult> {
    const hasCausalSignals = input.causalSignals && input.causalSignals.length > 0;

    if (hasCausalSignals) {
      // ---- 因果路径：CausalSignalCandidate 主导图构建 ----
      const causalGraph = buildCausalGraphEdges(input.causalSignals!);

      // 共现作为辅助边降级合并
      let mergedGraph = causalGraph;
      if (input.newsItems.length > 0) {
        const builderInput = input.newsItems.map(item => ({
          id: item.id,
          entities: extractSignalEntities([
            {
              title: item.title,
              summary: item.summary,
            },
          ]),
          reason: item.title,
        }));
        const coOccurrenceGraph = buildFriendNetworkGraph(builderInput);
        mergedGraph = mergeCausalAndCoOccurrenceGraphs(causalGraph, coOccurrenceGraph);
      }

      const finalizedGraph: IFriendNetworkGraphSnapshot = {
        nodes: mergedGraph.nodes,
        relationships: mergedGraph.relationships,
      };

      const newsIds = input.newsItems.map(item => item.id);
      const persistenceInput: IFriendNetworkPersistInput = {
        cluster: input.cluster,
        asOf: input.asOf,
        nodes: finalizedGraph.nodes.map(node => ({
          keyword: node.keyword,
          category: node.category,
          frequency: node.frequency,
          temperature: node.temperature,
          weakSignal: node.weakSignal,
          updatedAt: input.asOf.toISOString(),
          newsIds,
        })),
        relationships: finalizedGraph.relationships.map(relationship => ({
          sourceKeyword: relationship.sourceKeyword,
          targetKeyword: relationship.targetKeyword,
          relationType: relationship.relationType,
          direction: relationship.direction,
          confidence: relationship.confidence,
          status: relationship.status,
          weakSignal: relationship.weakSignal,
          evidence: relationship.evidence,
          reasoning: relationship.evidence?.[0] ?? `${relationship.sourceKeyword} -> ${relationship.targetKeyword}`,
          updatedAt: input.asOf.toISOString(),
          newsIds,
        })),
      };

      const persistence = this.dependencies.graphRepository
        ? await this.dependencies.graphRepository.persist(persistenceInput)
        : null;

      return {
        graph: finalizedGraph,
        tree: projectFriendNetworkTree({
          ...finalizedGraph,
          depthLimit: 20,
        }),
        aiDecisions: [],  // 因果边自带方向/置信度，无需 AI 判定
        persistence,
      };
    }

    // ---- 共现路径：无 causal signal 时回退现有逻辑（保证旧 trace/回测兼容） ----
    const builderInput = input.newsItems.map(item => ({
      id: item.id,
      entities: extractSignalEntities([
        {
          title: item.title,
          summary: item.summary,
        },
      ]),
      reason: item.title,
    }));

    const graph = buildFriendNetworkGraph(builderInput);
    const candidates: IAiRelationshipCandidate[] = graph.relationships.map(relationship => ({
      sourceKeyword: relationship.sourceKeyword,
      targetKeyword: relationship.targetKeyword,
      evidence: relationship.evidence,
    }));
    const aiAdapter = this.dependencies.aiAdapter ?? createStubFriendNetworkAiAdapter();
    const aiDecisions = await aiAdapter.judge(candidates);

    const relationshipMap = new Map<string, IFriendNetworkRelationshipSnapshot>(
      graph.relationships.map(relationship => [
        `${relationship.sourceKeyword}::${relationship.targetKeyword}`,
        relationship,
      ]),
    );
    for (const decision of aiDecisions) {
      const key = `${decision.sourceKeyword}::${decision.targetKeyword}`;
      const current = relationshipMap.get(key);
      if (!current) { continue; }
      relationshipMap.set(key, {
        ...current,
        relationType: decision.relationType,
        direction: decision.direction,
        confidence: decision.confidence,
        weakSignal: decision.weakSignal,
        evidence: decision.evidence,
      });
    }

    const finalizedNodes: IFriendNetworkNodeSnapshot[] = graph.nodes.map(node => ({
      ...node,
      weakSignal: node.frequency === 1 && graph.relationships.some(relationship => relationship.sourceKeyword === node.keyword || relationship.targetKeyword === node.keyword),
      temperature: node.frequency >= 2
        ? 'hot'
        : node.frequency === 1 && graph.relationships.some(relationship => relationship.sourceKeyword === node.keyword || relationship.targetKeyword === node.keyword)
          ? 'warming'
          : 'cold',
    }));
    const finalizedGraph: IFriendNetworkGraphSnapshot = {
      nodes: finalizedNodes,
      relationships: [...relationshipMap.values()],
    };

    const newsIds = input.newsItems.map(item => item.id);
    const persistenceInput: IFriendNetworkPersistInput = {
      cluster: input.cluster,
      asOf: input.asOf,
      nodes: finalizedGraph.nodes.map(node => ({
        keyword: node.keyword,
        category: node.category,
        frequency: node.frequency,
        temperature: node.temperature,
        weakSignal: node.weakSignal,
        updatedAt: input.asOf.toISOString(),
        newsIds,
      })),
      relationships: finalizedGraph.relationships.map((relationship) => {
        const aiDecision = aiDecisions.find(
          decision => decision.sourceKeyword === relationship.sourceKeyword && decision.targetKeyword === relationship.targetKeyword,
        );

        return {
          sourceKeyword: relationship.sourceKeyword,
          targetKeyword: relationship.targetKeyword,
          relationType: relationship.relationType,
          direction: relationship.direction,
          confidence: relationship.confidence,
          status: relationship.status,
          weakSignal: relationship.weakSignal,
          evidence: relationship.evidence,
          reasoning: aiDecision?.reasoning ?? `${relationship.sourceKeyword} -> ${relationship.targetKeyword}`,
          updatedAt: input.asOf.toISOString(),
          newsIds,
        };
      }),
    };

    const persistence = this.dependencies.graphRepository
      ? await this.dependencies.graphRepository.persist(persistenceInput)
      : null;

    return {
      graph: finalizedGraph,
      tree: projectFriendNetworkTree({
        ...finalizedGraph,
        depthLimit: 20,
      }),
      aiDecisions,
      persistence,
    };
  }
}

export const createFriendNetworkEngine = (
  dependencies: IFriendNetworkEngineDependencies = {},
): FriendNetworkEngine => {
  return new FriendNetworkEngine(dependencies);
};
