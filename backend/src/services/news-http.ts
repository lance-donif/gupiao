/** A request deadline includes headers and the entire body, including stalled streams. */
export class NewsHttpError extends Error {
  public constructor(public readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export const readNewsText = async (
  url: string,
  options: {
    readonly timeoutMs: number;
    readonly fetchImpl?: typeof fetch;
    readonly init?: RequestInit;
    readonly signal?: AbortSignal;
  },
): Promise<string> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      controller.abort();
      reject(new Error('News request aborted'));
    };
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`News request timeout after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await (options.fetchImpl ?? fetch)(url, {
          ...options.init,
          signal: controller.signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new NewsHttpError(response.status);
        }
        return await response.text();
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
  }
};

export const isRetryableNewsError = (error: unknown): boolean => {
  if (error instanceof NewsHttpError) return error.status === 429 || error.status >= 500;
  return error instanceof Error && /timeout|timed out|socket|connection|network|fetch failed|ECONN|ETIMEDOUT/i.test(error.message);
};
