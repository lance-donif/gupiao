export interface IFetchWithRetryOptions {
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly requestTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const isRetryableAiStatus = (status: number): boolean => {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export const fetchWithRetry = async (
  url: string,
  init: RequestInit,
  options: IFetchWithRetryOptions = {}
): Promise<Response> => {
  const maxRetries = options.maxRetries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 800;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
  const fetchFn = options.fetchImpl ?? fetch;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetchFn(url, {
        ...init,
        signal: controller.signal,
      });

      if (response.ok) {
        return response;
      }

      if (isRetryableAiStatus(response.status)) {
        throw new Error(`Retryable HTTP status: ${response.status}`);
      }

      // Non-retryable status (e.g., 400, 401, 403, 404)
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      const isTimeout = lastError.name === 'AbortError' || lastError.message.includes('timeout') || lastError.message.includes('timed out');
      const errorMessage = lastError.message.toLowerCase();
      const isNetworkError = errorMessage.includes('fetch failed') || errorMessage.includes('econnrefused') || errorMessage.includes('socket') || errorMessage.includes('network') || errorMessage.includes('abort');
      const isRetryableStatus = lastError.message.startsWith('Retryable HTTP status:');

      if (attempt === maxRetries || (!isTimeout && !isNetworkError && !isRetryableStatus)) {
        throw lastError;
      }

      const backoffDelay = retryDelayMs * 2 ** attempt;
      console.warn(`[AI Fetch Retry] Attempt ${attempt + 1}/${maxRetries + 1} failed. Retrying in ${backoffDelay}ms... Error: ${lastError.message}`);
      await sleep(backoffDelay);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error('Fetch with retry failed');
};
