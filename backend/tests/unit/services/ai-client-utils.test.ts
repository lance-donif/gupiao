import { describe, expect, it, vi } from 'vitest';
import { fetchWithRetry } from '../../../src/services/ai-client-utils.js';

describe('fetchWithRetry', () => {
  it('returns response immediately on HTTP 200 success', async () => {
    const mockResponse = new Response('ok', { status: 200 });
    const mockFetch = vi.fn().mockResolvedValue(mockResponse);
    global.fetch = mockFetch;

    const res = await fetchWithRetry('http://localhost/test', {}, { maxRetries: 2, retryDelayMs: 1 });
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable status codes (e.g. 500, 429) and eventually succeeds', async () => {
    const mockResponse429 = new Response('too many requests', { status: 429 });
    const mockResponse500 = new Response('internal error', { status: 500 });
    const mockResponse200 = new Response('success', { status: 200 });

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(mockResponse429)
      .mockResolvedValueOnce(mockResponse500)
      .mockResolvedValueOnce(mockResponse200);
    global.fetch = mockFetch;

    const res = await fetchWithRetry('http://localhost/test', {}, { maxRetries: 3, retryDelayMs: 1 });
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('throws immediately on non-retryable status codes (e.g. 400, 401)', async () => {
    const mockResponse400 = new Response('bad request', { status: 400 });
    const mockFetch = vi.fn().mockResolvedValue(mockResponse400);
    global.fetch = mockFetch;

    const res = await fetchWithRetry('http://localhost/test', {}, { maxRetries: 3, retryDelayMs: 1 });
    expect(res.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on network errors and eventually succeeds', async () => {
    const mockResponse200 = new Response('success', { status: 200 });
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(mockResponse200);
    global.fetch = mockFetch;

    const res = await fetchWithRetry('http://localhost/test', {}, { maxRetries: 2, retryDelayMs: 1 });
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on timeouts and throws when max retries are exceeded', async () => {
    const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
      // Trigger a timeout by checking AbortSignal or aborting
      if (init?.signal?.aborted) {
        throw new DOMException('The user aborted a request.', 'AbortError');
      }
      throw new DOMException('The user aborted a request.', 'AbortError');
    });
    global.fetch = mockFetch;

    await expect(
      fetchWithRetry('http://localhost/test', {}, { maxRetries: 2, retryDelayMs: 1, requestTimeoutMs: 10 })
    ).rejects.toThrow('The user aborted a request.');
    expect(mockFetch).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });
});
