import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getBatchByTraceId = vi.fn();

vi.mock('@/lib/api', () => ({
  api: { getBatchByTraceId },
}));

const { pollDispatchUntilTerminal } = await import('@/app/dispatch-poller');

const traceId = 'trace-1';

function terminal(status: string) {
  return Promise.resolve({
    id: 'b1',
    status,
    finished_at: '2026-06-01T10:00:00.000Z',
    error_code: null,
    error_message: null,
  });
}

describe('pollDispatchUntilTerminal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getBatchByTraceId.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('轮询到终态后回调 onSettled 并停止', async () => {
    getBatchByTraceId.mockImplementation(() => terminal('COMPLETED'));
    const onSettled = vi.fn();
    const onError = vi.fn();

    pollDispatchUntilTerminal({ traceId, onSettled, onError, onTimeout: vi.fn() });

    // 首次查询前有 1200ms 延迟
    await vi.advanceTimersByTimeAsync(1200);
    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({ trace_id: traceId, status: 'COMPLETED' }),
    );
    expect(onError).not.toHaveBeenCalled();

    // 到达终态后不再继续轮询
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getBatchByTraceId).toHaveBeenCalledTimes(1);
  });

  it('查询失败时回调 onError 并停止重试（不再静默失败）', async () => {
    getBatchByTraceId.mockRejectedValue(new Error('network down'));
    const onSettled = vi.fn();
    const onError = vi.fn();

    pollDispatchUntilTerminal({ traceId, onSettled, onError, onTimeout: vi.fn() });

    await vi.advanceTimersByTimeAsync(1200);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getBatchByTraceId).toHaveBeenCalledTimes(1);
  });

  it('cancel 后不再发起任何查询', async () => {
    getBatchByTraceId.mockImplementation(() => terminal('RUNNING'));
    const onSettled = vi.fn();

    const handle = pollDispatchUntilTerminal({
      traceId,
      onSettled,
      onError: vi.fn(),
      onTimeout: vi.fn(),
    });
    handle.cancel();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(getBatchByTraceId).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('采用指数退避而非固定 2s 轮询', async () => {
    getBatchByTraceId.mockImplementation(() => terminal('RUNNING'));

    const handle = pollDispatchUntilTerminal({
      traceId,
      onSettled: vi.fn(),
      onError: vi.fn(),
      onTimeout: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(1200);
    expect(getBatchByTraceId).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(getBatchByTraceId).toHaveBeenCalledTimes(2);

    // 退避到 4s：再等 2s 不应触发第 3 次
    await vi.advanceTimersByTimeAsync(2000);
    expect(getBatchByTraceId).toHaveBeenCalledTimes(2);

    // 累计满 4s 才触发第 3 次
    await vi.advanceTimersByTimeAsync(2000);
    expect(getBatchByTraceId).toHaveBeenCalledTimes(3);

    handle.cancel();
  });
});