export type AiFailureKind = 'rate' | 'quota' | 'auth' | 'permission' | 'missing_model' | 'network' | 'length' | 'structure' | 'refusal' | 'parameter' | 'first_timeout' | 'idle_timeout' | 'total_timeout';
export class AiCallFailure extends Error {
  public constructor(public readonly kind: AiFailureKind, public readonly status?: number, public readonly retryAt?: number) {
    super(`AI ${kind}${status ? ` HTTP ${status}` : ''}`);
  }
}
export class AiPausedError extends Error { public readonly status = 'PAUSED'; }
export class AiNeedsAttentionError extends Error { public readonly status = 'NEEDS_ATTENTION'; }
export class AiSplitRequiredError extends Error {}
export function retryAfter(headers: Headers, now = Date.now()): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const time = /^\d+(?:\.\d+)?$/.test(raw) ? now + Number(raw) * 1000 : Date.parse(raw);
  return Number.isFinite(time) ? Math.max(now, time) : undefined;
}
export function classifyAiHttp(status: number, raw: string, headers = new Headers(), now = Date.now()): AiCallFailure {
  // Inspect bounded diagnostics for classification, but never retain the raw body in an error.
  const text = raw.slice(0, 16000).toLowerCase();
  // Gateways may return HTTP 200/SSE but carry the actual upstream status in the error envelope.
  try {
    const payload = JSON.parse(raw.slice(0, 16000));
    const error = payload?.error ?? payload;
    const embedded = Number(error?.status ?? error?.status_code ?? error?.code);
    if (Number.isInteger(embedded) && embedded >= 400 && embedded <= 599) status = embedded;
  } catch { /* A plain-text gateway error still uses its HTTP status. */ }
  const retryAt = retryAfter(headers, now);
  if (status === 401 || /invalid_api_key|invalid api key|invalid token|令牌无效/.test(text)) return new AiCallFailure('auth', status);
  if (/insufficient_quota|insufficient.*balance|余额不足|quota_exhausted|daily.*limit|日.*额度/.test(text) || status === 402) return new AiCallFailure('quota', status, retryAt);
  if (/context_length|maximum context|context window/.test(text) || status === 413) return new AiCallFailure('length', status);
  if (/content_filter|content_policy|safety.*block/.test(text)) return new AiCallFailure('refusal', status);
  if (status === 429 || /rate_limit_exceeded|tokens per min|requests per min/.test(text)) return new AiCallFailure('rate', status, retryAt);
  if (/too many tokens|token.*limit.*exceed/.test(text)) return new AiCallFailure('length', status);
  if (status === 404 || /model_not_found|model.*not.*exist/.test(text)) return new AiCallFailure('missing_model', status);
  if (status === 403) return new AiCallFailure('permission', status, retryAt);
  if (status === 400 || status === 422) return new AiCallFailure('parameter', status);
  return new AiCallFailure('network', status, retryAt);
}
