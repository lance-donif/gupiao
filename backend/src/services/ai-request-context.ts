import { AsyncLocalStorage } from 'node:async_hooks';
export interface AiRequestContext {
  readonly rootId: string;
  readonly taskId: string;
  readonly owner: string;
  readonly deadline: number;
  readonly maxAttempts: number;
  readonly signal: AbortSignal;
  readonly outputTokenBudget?: number;
}
export const aiRequestContext = new AsyncLocalStorage<AiRequestContext>();
