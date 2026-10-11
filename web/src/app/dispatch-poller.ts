import { api } from '@/lib/api';

export type DispatchTerminalStatus = 'COMPLETED' | 'DEGRADED' | 'FAILED';

export interface DispatchOutcome {
  trace_id: string;
  status: DispatchTerminalStatus;
  finished_at: string;
  error_code?: string | null;
  error_message?: string | null;
}

const TERMINAL_STATUSES = new Set<string>(['COMPLETED', 'DEGRADED', 'FAILED']);

/** 首次查询前的等待：给后端一点时间落库 trace 记录。 */
const INITIAL_DELAY_MS = 1200;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 10000;
/** 整体等待上限，与业务侧可接受的推演时长一致。 */
const MAX_TOTAL_WAIT_MS = 30 * 60 * 1000;

export interface PollHandle {
  /** 主动停止轮询（组件卸载 / 重复触发时调用），幂等。 */
  cancel: () => void;
}

export interface PollOptions {
  traceId: string;
  onSettled: (outcome: DispatchOutcome) => void;
  onError: (message: string) => void;
  onTimeout: () => void;
}

/**
 * 轮询推演批次直到终态。
 *
 * 相比原先内联在组件里的递归闭包，这里做了三件要紧的事：
 *  1. 查询失败会回调 onError 并停止 —— 原实现 `void poll()` 会静默吞掉异常，
 *     轮询链直接断掉且用户看不到任何提示。
 *  2. 超时会回调 onTimeout —— 原实现 30 分钟后静默放弃。
 *  3. 指数退避（2s→4s→8s→10s 封顶）—— 原实现固定 2s，30 分钟要打 900 次请求。
 */
export function pollDispatchUntilTerminal(options: PollOptions): PollHandle {
  const { traceId, onSettled, onError, onTimeout } = options;

  let cancelled = false;
  let timerId: number | undefined;
  let startedAt = Date.now();
  let delayMs = BASE_BACKOFF_MS;

  const clearTimer = () => {
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      timerId = undefined;
    }
  };

  const cancel = () => {
    cancelled = true;
    clearTimer();
  };

  const schedule = (fn: () => void, ms: number) => {
    if (cancelled) {
      return;
    }
    timerId = window.setTimeout(fn, ms);
  };

  const poll = async () => {
    if (cancelled) {
      return;
    }
    try {
      const batch = await api.getBatchByTraceId(traceId);
      if (cancelled) {
        return;
      }
      if (TERMINAL_STATUSES.has(batch.status)) {
        onSettled({
          trace_id: traceId,
          status: batch.status as DispatchTerminalStatus,
          finished_at: batch.finished_at ?? new Date().toISOString(),
          error_code: batch.error_code,
          error_message: batch.error_message,
        });
        return;
      }
    }
    catch (error) {
      if (cancelled) {
        return;
      }
      // 查询失败即停止重试：与其静默失败，不如明确告知用户。
      onError(String(error));
      return;
    }

    if (Date.now() - startedAt + delayMs > MAX_TOTAL_WAIT_MS) {
      onTimeout();
      return;
    }
    schedule(() => void poll(), delayMs);
    delayMs = Math.min(delayMs * 2, MAX_BACKOFF_MS);
  };

  startedAt = Date.now();
  schedule(() => void poll(), INITIAL_DELAY_MS);

  return { cancel };
}