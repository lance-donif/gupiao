export type FriendRelationType = 'driver' | 'transmission' | 'derived' | 'synchronous' | 'reverse';
export type FriendRelationStatus = 'effective' | 'invalid' | 'unknown';
export type FriendRelationDirection = 'forward' | 'reverse' | 'bidirectional';

export interface IFriendRelationshipInput {
  readonly sourceKeyword: string;
  readonly targetKeyword: string;
  readonly relationType: FriendRelationType;
  readonly direction: FriendRelationDirection;
  readonly confidence: number;
  readonly status: FriendRelationStatus;
  readonly weakSignal: boolean;
  readonly evidence: readonly string[];
  readonly updatedAt: Date;
}

export class FriendRelationship {
  public readonly sourceKeyword: string;
  public readonly targetKeyword: string;
  public readonly relationType: FriendRelationType;
  public readonly direction: FriendRelationDirection;
  public readonly confidence: number;
  public readonly status: FriendRelationStatus;
  public readonly weakSignal: boolean;
  public readonly evidence: readonly string[];
  public readonly updatedAt: Date;

  public constructor(input: IFriendRelationshipInput) {
    this.sourceKeyword = input.sourceKeyword;
    this.targetKeyword = input.targetKeyword;
    this.relationType = input.relationType;
    this.direction = input.direction;
    this.confidence = input.confidence;
    this.status = input.status;
    this.weakSignal = input.weakSignal;
    this.evidence = [...input.evidence];
    this.updatedAt = new Date(input.updatedAt);
  }
}
