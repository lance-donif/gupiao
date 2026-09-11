import type { IncomingMessage, ServerResponse } from 'node:http';

const readRequestBody = async (request: IncomingMessage): Promise<string> => {
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

/** YYYY-MM-DD 日期参数校验。空值与非法格式均视为不合法（调用方按需决定是否兜底）。 */
export const isValidDateParam = (value: string | null | undefined): value is string => {
  if (!value) {
    return false;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
};

/**
 * 校验日期参数：合法则返回值；非法则向响应写入 400 + 标准错误信封并返回 null。
 * 调用方需检查返回值是否为 null，已写入响应后请直接 return。
 */
export const requireDateParam = (
  response: ServerResponse,
  value: string | null | undefined,
  fieldName: string,
): string | null => {
  if (isValidDateParam(value)) {
    return value;
  }
  sendError(response, 400, 'INVALID_DATE', `${fieldName} 必须为 YYYY-MM-DD 格式`, { fieldName, received: value ?? null });
  return null;
};

/** 统一错误信封：{ code, message, detail? }。 */
export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly detail?: unknown;
}

export const sendError = (
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  detail?: unknown,
): void => {
  const body: ApiErrorBody = detail === undefined ? { code, message } : { code, message, detail };
  writeJson(response, statusCode, body);
};
