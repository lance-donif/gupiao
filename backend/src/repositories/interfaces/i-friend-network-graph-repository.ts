import type {
  IFriendNetworkPersistenceResult,
  IFriendNetworkPersistInput,
} from '../../services/friend-network-types.js';

export interface IFriendNetworkGraphRepository {
  persist: (input: IFriendNetworkPersistInput) => Promise<IFriendNetworkPersistenceResult>;
}
