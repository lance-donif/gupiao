/** Consume SSE completely before allowing structured model output to be used. */
export async function readOpenAiStream(response: Response, timeoutMs = 300000, options: {
  idleMs?: number;
  onTokens?: (tokens: number) => void;
  onUsage?: (usage: { prompt_tokens?: number; completion_tokens?: number }) => void;
  onProgress?: () => void;
  errorFactory?: (error: unknown) => Error;
} = {}): Promise<string> {
  if (!response.body) throw new Error('AI stream missing body');
  const reader = response.body.getReader();
  let timedOut = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const progress = (): void => {
    clearTimeout(idleTimer);
    if(options.idleMs) idleTimer=setTimeout(()=>{timedOut=true;void reader.cancel();},options.idleMs);
  };
  progress();
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel(); }, timeoutMs);
  const decoder = new TextDecoder();
  let pending = '';
  let content = '';
  let finished = false;
  let done = false;
  const consume = (event: string): void => {
    const data = event.split('\n').filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data === '[DONE]') { done = true; return; }
    const chunk = JSON.parse(data) as {
      error?: unknown;
      usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
      choices?: Array<{ index: number; delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }; finish_reason?: string | null }>;
    };
    if (chunk.error) throw options.errorFactory?.(chunk.error) ?? new Error('AI stream returned an error');
    if (typeof chunk.usage?.total_tokens === 'number') options.onTokens?.(chunk.usage.total_tokens);
    if (chunk.usage) options.onUsage?.(chunk.usage);
    const choice = chunk.choices?.find(item => item.index === 0);
    if(choice?.delta?.content || choice?.delta?.reasoning_content || choice?.delta?.reasoning) { progress(); options.onProgress?.(); }
    if (choice?.delta?.content) content += choice.delta.content;
    if (choice?.finish_reason) {
      if (choice.finish_reason !== 'stop') throw new Error(`AI stream finish reason: ${choice.finish_reason}`);
      finished = true;
    }
  };
  try {
    while (!done) {
      const part = await reader.read();
      pending += decoder.decode(part.value, { stream: !part.done });
      pending = pending.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        consume(pending.slice(0, end));
        pending = pending.slice(end + 2);
      }
      if (part.done) break;
    }
    if (timedOut) throw new Error('AI stream timed out');
    if (!done || !finished || !content) throw new Error('AI stream incomplete or empty');
    return content;
  } finally {
    clearTimeout(timeout);
    clearTimeout(idleTimer);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
