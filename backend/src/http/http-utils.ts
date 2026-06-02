import type { IncomingMessage, ServerResponse } from 'node:http';

export const readRequestBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

export const readJsonBody = async <T>(request: IncomingMessage): Promise<T> => {
  const raw = await readRequestBody(request);
  if (!raw.trim()) {
    return {} as T;
  }
  return JSON.parse(raw) as T;
};

export const writeJson = (response: ServerResponse, statusCode: number, payload: unknown): void => {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
};

export const writeSseHeaders = (response: ServerResponse): void => {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-cache, no-transform');
  response.setHeader('connection', 'keep-alive');
  response.setHeader('x-accel-buffering', 'no');
};

export const writeSseData = (
  response: ServerResponse,
  payload: { id?: string | number; event?: string; data: string },
): void => {
  if (payload.event) {
    response.write(`event: ${payload.event}\n`);
  }
  if (payload.id !== undefined) {
    response.write(`id: ${payload.id}\n`);
  }
  for (const line of payload.data.split('\n')) {
    response.write(`data: ${line}\n`);
  }
  response.write('\n');
};

export const parsePositiveInteger = (value: string | null, fallback: number): number => {
  const parsed = Number(value ?? '');
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
};
