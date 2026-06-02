import type { IAiRelationshipCandidate, IAiRelationshipDecision } from './friend-network-types.js';

export interface IFriendNetworkAiAdapter {
  judge: (candidates: readonly IAiRelationshipCandidate[]) => Promise<readonly IAiRelationshipDecision[]>;
}

class StubFriendNetworkAiAdapter implements IFriendNetworkAiAdapter {
  public judge(candidates: readonly IAiRelationshipCandidate[]): Promise<readonly IAiRelationshipDecision[]> {
    return Promise.resolve(candidates.map(candidate => ({
      sourceKeyword: candidate.sourceKeyword,
      targetKeyword: candidate.targetKeyword,
      relationType: 'driver',
      direction: 'forward',
      confidence: 0.75,
      weakSignal: false,
      evidence: candidate.evidence,
      reasoning: `${candidate.sourceKeyword} 与 ${candidate.targetKeyword} 在同一新闻语境中共同出现，先作为待验证驱动关系处理。`,
    })));
  }
}

export const createStubFriendNetworkAiAdapter = (): IFriendNetworkAiAdapter => {
  return new StubFriendNetworkAiAdapter();
};
