import type {
  FriendRelationDirection,
  FriendRelationStatus,
  FriendRelationType,
} from '../types/entities/friend-relationship.js';
import type { KeywordCategory } from '../types/entities/keyword.js';
import type { SignalTemperature } from '../types/entities/signal-node.js';

export interface IFriendNetworkNewsItem {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly url: string;
  readonly publishedAt: string;
  readonly capturedAt: string;
  readonly source: string;
}

export interface IFriendNetworkEngineInput {
  readonly cluster: string;
  readonly sourceNewsFilePath: string;
  readonly asOf: Date;
  readonly newsItems: readonly IFriendNetworkNewsItem[];
}

export interface IFriendNetworkNodeSnapshot {
  readonly keyword: string;
  readonly frequency: number;
  readonly temperature: SignalTemperature;
  readonly weakSignal: boolean;
  readonly category: KeywordCategory;
}

export interface IFriendNetworkRelationshipSnapshot {
  readonly sourceKeyword: string;
  readonly targetKeyword: string;
  readonly relationType: FriendRelationType;
  readonly direction: FriendRelationDirection;
  readonly confidence: number;
  readonly status: FriendRelationStatus;
  readonly weakSignal: boolean;
  readonly evidence: readonly string[];
  readonly updatedAt: string;
}

export interface IFriendNetworkGraphSnapshot {
  readonly nodes: readonly IFriendNetworkNodeSnapshot[];
  readonly relationships: readonly IFriendNetworkRelationshipSnapshot[];
}

export interface IFriendNetworkTreeNode {
  readonly keyword: string;
  readonly weight: number;
  readonly status: FriendRelationStatus;
  readonly temperature: SignalTemperature;
  readonly weakSignal: boolean;
  readonly reasons: readonly string[];
  readonly childrenKeywords: readonly string[];
  readonly children: readonly IFriendNetworkTreeNode[];
}

export interface IFriendNetworkTreeSnapshot {
  readonly depthLimit: number;
  readonly rootKeywords: readonly string[];
  readonly roots: readonly IFriendNetworkTreeNode[];
}

export interface IAiRelationshipCandidate {
  readonly sourceKeyword: string;
  readonly targetKeyword: string;
  readonly evidence: readonly string[];
}

export interface IAiRelationshipDecision {
  readonly sourceKeyword: string;
  readonly targetKeyword: string;
  readonly relationType: FriendRelationType;
  readonly direction: FriendRelationDirection;
  readonly confidence: number;
  readonly weakSignal: boolean;
  readonly evidence: readonly string[];
  readonly reasoning: string;
}

export interface IFriendNetworkPersistedNode {
  readonly keyword: string;
  readonly category: KeywordCategory;
  readonly frequency: number;
  readonly temperature: SignalTemperature;
  readonly weakSignal: boolean;
  readonly updatedAt: string;
  readonly newsIds: readonly string[];
}

export interface IFriendNetworkPersistedRelationship {
  readonly sourceKeyword: string;
  readonly targetKeyword: string;
  readonly relationType: FriendRelationType;
  readonly direction: FriendRelationDirection;
  readonly confidence: number;
  readonly status: FriendRelationStatus;
  readonly weakSignal: boolean;
  readonly evidence: readonly string[];
  readonly reasoning: string;
  readonly updatedAt: string;
  readonly newsIds: readonly string[];
}

export interface IFriendNetworkPersistInput {
  readonly cluster: string;
  readonly asOf: Date;
  readonly nodes: readonly IFriendNetworkPersistedNode[];
  readonly relationships: readonly IFriendNetworkPersistedRelationship[];
}

export interface IFriendNetworkPersistenceResult {
  readonly cluster: string;
  readonly graphName: string;
  readonly nodeCount: number;
  readonly relationshipCount: number;
  readonly persistedAt: string;
}

export interface IFriendNetworkEngineResult {
  readonly graph: IFriendNetworkGraphSnapshot;
  readonly tree: IFriendNetworkTreeSnapshot;
  readonly aiDecisions: readonly IAiRelationshipDecision[];
  readonly persistence: IFriendNetworkPersistenceResult | null;
}
