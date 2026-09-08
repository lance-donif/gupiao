import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiChatClient, AiCandidatesExhaustedError, AiInputError, AiRequestTooLargeError } from '../../../src/services/ai-chat-client.js';
import { aiConfigFingerprint, loadAiProviderConfig, validateAiConfig, type IAiProviderConfig } from '../../../src/services/ai-provider-config.js';

const config = (): IAiProviderConfig => ({ providers: [1, 2, 3].map(i => ({
  id: `p${i}`, baseUrl: `https://p${i}.example/v1/`, apiKey: `secret-${i}`,
  models: [1, 2].map(j => ({ id: `m${j}` })),
})) });
const completion = (content = '{"ok":true}', finish_reason = 'stop') => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason }] }));
const request = {
  label: 'Test AI', messages: [{ role: 'user' as const, content: 'input' }], temperature: 0.2, timeoutMs: 1000,
  validate: (value: unknown) => { if ((value as { ok?: unknown })?.ok !== true) throw new Error('schema'); return value; },
};
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

describe('ordered Chat Completions client', () => {
  it('uses provider then model order, stops at success, and starts again from the first candidate', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${url}:${JSON.parse(String(init?.body)).model}`);
      return calls.length === 6 || calls.length === 7 ? completion() : new Response('', { status: 503 });
    });
    const client = new AiChatClient(config(), fetchMock as typeof fetch);
    expect((await client.request(request)).source).toEqual({ providerId: 'p3', model: 'm2', modelVersion: '["p3","m2"]' });
    expect((await client.request(request)).source.providerId).toBe('p1');
    expect(calls).toEqual([
      'https://p1.example/v1/chat/completions:m1', 'https://p1.example/v1/chat/completions:m2',
      'https://p2.example/v1/chat/completions:m1', 'https://p2.example/v1/chat/completions:m2',
      'https://p3.example/v1/chat/completions:m1', 'https://p3.example/v1/chat/completions:m2',
      'https://p1.example/v1/chat/completions:m1',
    ]);
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer secret-2' });
  });

  it.each([400, 401, 403, 404, 408, 429, 500, 502, 503, 504])('switches immediately on HTTP %s', async status => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('private upstream body', { status })).mockResolvedValueOnce(completion());
    const result = await new AiChatClient(config(), fetchMock).request(request);
    expect(result.source.model).toBe('m2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    () => completion(''), () => completion('not-json'), () => completion('{}'), () => completion('null'),
    () => completion('{"ok":true}', 'length'), () => completion('{"ok":true}', 'content_filter'),
    () => new Response('invalid envelope'), () => new Response('{"choices":[]}'),
    () => new Response('{"error":{"message":"private"}}'),
  ])('switches on invalid/incomplete responses', async response => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(completion());
    expect((await new AiChatClient(config(), fetchMock).request(request)).source.model).toBe('m2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports all failed candidates once without leaking fetch errors or credentials', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('secret-1 https://private.example input'));
    const error = await new AiChatClient(config(), fetchMock).request(request).catch(error => error);
    expect(error).toBeInstanceOf(AiCandidatesExhaustedError);
    expect(error.attempts).toHaveLength(6);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(error.message).not.toMatch(/secret|private\.example|input/);
  });

  it.each(['headers', 'body'])('times out stalled %s and advances without waiting indefinitely', async stage => {
    vi.useFakeTimers();
    const never = () => new Promise<Response>(() => undefined);
    const fetchMock = vi.fn().mockImplementationOnce(stage === 'headers' ? never : async () => ({ ok: true, json: never }))
      .mockResolvedValueOnce(completion());
    const pending = new AiChatClient(config(), fetchMock).request(request);
    await vi.advanceTimersByTimeAsync(1001);
    expect((await pending).source.model).toBe('m2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
  });

  it('propagates cancellation and does not try the next model', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => undefined));
    const pending = new AiChatClient(config(), fetchMock).request({ ...request, signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow('cancelled by caller');
    controller.abort(new Error('cancelled by caller'));
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('applies the selected model timeout instead of the function default', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise(() => undefined)).mockResolvedValueOnce(completion());
    const client = new AiChatClient({ providers: [{ ...config().providers[0]!, models: [{ id: 'short', timeoutMs: 5 }, { id: 'next' }] }] }, fetchMock);
    const pending = client.request(request);
    await vi.advanceTimersByTimeAsync(6);
    expect((await pending).source.model).toBe('next');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preflights the full chain and enforces the hard 240000 character limit', async () => {
    const fetchMock = vi.fn();
    const client = new AiChatClient({ providers: [{ ...config().providers[0]!, models: [{ id: 'a' }, { id: 'b'.repeat(240000) }] }] }, fetchMock);
    await expect(client.request(request)).rejects.toBeInstanceOf(AiRequestTooLargeError);
    await expect(new AiChatClient(config(), fetchMock).request({ ...request, maxRequestChars: 999999, messages: [{ role: 'user', content: '字'.repeat(240001) }] })).rejects.toBeInstanceOf(AiRequestTooLargeError);
    await expect(client.request({ ...request, maxRequestChars: NaN })).rejects.toBeInstanceOf(AiInputError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a body exactly at the configured limit and rejects one extra character', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => completion());
    const client = new AiChatClient(config(), fetchMock);
    await client.request(request);
    const length = String(fetchMock.mock.calls[0]?.[1]?.body).length;
    await expect(client.request({ ...request, maxRequestChars: length })).resolves.toBeDefined();
    await expect(client.request({ ...request, maxRequestChars: length - 1 })).rejects.toBeInstanceOf(AiRequestTooLargeError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('isolates model parameters and omits incompatible default temperature/JSON format when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 400 })).mockResolvedValueOnce(completion());
    const client = new AiChatClient({ providers: [{ ...config().providers[0]!, models: [
      { id: 'reasoner', parameters: { reasoning_effort: 'high', response_format: null, max_completion_tokens: 2000 } },
      { id: 'ordinary' },
    ] }] }, fetchMock);
    await client.request(request);
    const first = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body);
    const second = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body);
    expect(first).not.toHaveProperty('temperature');
    expect(first).not.toHaveProperty('response_format');
    expect(first.reasoning_effort).toBe('high');
    expect(second).not.toHaveProperty('reasoning_effort');
    expect(second).not.toHaveProperty('max_completion_tokens');
    expect(second.temperature).toBe(0.2);
    expect(second.response_format).toEqual({ type: 'json_object' });
  });

  it('supports complete streams and falls through on truncated streams', async () => {
    const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    const chunk = event({ choices: [{ index: 0, delta: { content: '{"ok":true}' } }] });
    const complete = chunk + event({ choices: [{ index: 0, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(chunk)).mockResolvedValueOnce(new Response(complete));
    const client = new AiChatClient({ providers: [{ ...config().providers[0]!, models: [
      { id: 's1', parameters: { stream: true } }, { id: 's2', parameters: { stream: true } },
    ] }] }, fetchMock);
    expect((await client.request(request)).source.model).toBe('s2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps concurrent request sources independent', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return body.messages[0].content === 'second' && body.model === 'm1' ? new Response('', { status: 401 }) : completion();
    });
    const client = new AiChatClient(config(), fetchMock as typeof fetch);
    const results = await Promise.all([client.request(request), client.request({ ...request, messages: [{ role: 'user', content: 'second' }] })]);
    expect(results.map(result => result.source.model)).toEqual(['m1', 'm2']);
  });
});

describe('single AI configuration file', () => {
  it.each([{}, { providers: [] }, { providers: [{}] }, { providers: [{ ...config().providers[0], models: [] }] },
    { providers: [config().providers[0], config().providers[0]] },
    { providers: [{ ...config().providers[0], models: [{ id: 'a', parameters: { model: 'override' } }] }] },
    { providers: [{ ...config().providers[0], models: [{ id: 'a', timeoutMs: -1 }] }] },
    { providers: [{ ...config().providers[0], baseUrl: 'https://user:secret@example.test/v1' }] },
  ])('rejects invalid configuration without attempting requests', value => {
    expect(() => validateAiConfig(value)).toThrow();
  });

  it('loads only the file, caches a process snapshot, and does not use old environment keys', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gupiao-ai-config-')); dirs.push(dir);
    const file = path.join(dir, 'ai.json');
    writeFileSync(file, JSON.stringify(config()));
    const env = { AI_CONFIG_FILE: file, LLM_SMART_API_KEY: 'ignored', OPENAI_MODEL: 'ignored' };
    expect(loadAiProviderConfig(env)).toEqual(config());
    writeFileSync(file, 'invalid JSON with private key');
    expect(loadAiProviderConfig(env)).toEqual(config());
    expect(() => loadAiProviderConfig({ AI_CONFIG_FILE: path.join(dir, 'missing.json'), LLM_SMART_API_KEY: 'ignored' })).toThrow('Cannot read AI_CONFIG_FILE');
    const invalidFile = path.join(dir, 'invalid.json'); writeFileSync(invalidFile, 'invalid private key');
    expect(() => loadAiProviderConfig({ AI_CONFIG_FILE: invalidFile })).toThrow('must contain valid JSON');
  });

  it('changes cache identity on routes/parameters but not credential rotation', () => {
    const first = config();
    const rotated = { providers: first.providers.map(provider => ({ ...provider, apiKey: 'rotated' })) };
    expect(aiConfigFingerprint(rotated)).toBe(aiConfigFingerprint(first));
    expect(aiConfigFingerprint({ providers: [...first.providers].reverse() })).toBe(aiConfigFingerprint(first));
    expect(aiConfigFingerprint({ providers: first.providers.map(provider => ({ ...provider, models: [...provider.models].reverse() })) })).toBe(aiConfigFingerprint(first));
    expect(aiConfigFingerprint({ providers: [{ ...first.providers[0]!, models: [{ id: 'm1', parameters: { temperature: 0.7 } }] }] })).not.toBe(aiConfigFingerprint(first));
  });
});
