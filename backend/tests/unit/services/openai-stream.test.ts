import { describe, expect, it } from 'vitest';
import { readOpenAiStream } from '../../../src/lib/openai-stream.js';

const event = (content: string, finish: string | null = null): string =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\r\n\r\n`;

describe('OpenAI SSE completion', () => {
  it('handles UTF-8 and CRLF split across network chunks', async () => {
    const bytes = new TextEncoder().encode(event('中文') + event('', 'stop') + 'data: [DONE]\r\n\r\n');
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    expect(await readOpenAiStream(new Response(body))).toBe('中文');
  });
  it('rejects disconnected streams', async () => {
    await expect(readOpenAiStream(new Response(event('{}')))).rejects.toThrow('incomplete');
  });
  it('rejects truncated model output', async () => {
    await expect(readOpenAiStream(new Response(event('{}', 'length')))).rejects.toThrow('length');
  });
  it('rejects gateway errors inside streams', async () => {
    await expect(readOpenAiStream(new Response('data: {"error":{"message":"timeout"}}\n\n'))).rejects.toThrow('error');
  });
});
