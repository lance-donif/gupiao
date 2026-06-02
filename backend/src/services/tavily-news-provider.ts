import type { INewsSourceRequest, IProviderNewsArticlePayload, IProviderNewsResponse, IProviderRequestMetadata, ISourceProvider, ISourceProviderHealthStatus } from '../sources/contracts.js';
import crypto from 'node:crypto';
import { SourceFailureCategory } from '../sources/contracts.js';

export interface IAkToolsNewsProviderOptions {
  readonly baseUrl: string;
  readonly maxResults: number;
  readonly endpointTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

interface IAkToolsNewsEndpointSpec {
  readonly endpoint: 'stock_info_global_em' | 'stock_info_global_cls' | 'stock_info_global_ths' | 'news_economic_baidu';
  readonly source: 'akshare_global_em' | 'akshare_global_cls' | 'akshare_global_ths' | 'akshare_baidu';
}

type IAkToolsRecord = Readonly<Record<string, unknown>>;

const ENDPOINT_SPECS: readonly IAkToolsNewsEndpointSpec[] = [
  { endpoint: 'stock_info_global_em', source: 'akshare_global_em' },
  { endpoint: 'stock_info_global_ths', source: 'akshare_global_ths' },
  { endpoint: 'news_economic_baidu', source: 'akshare_baidu' },
];

const DEFAULT_ENDPOINT_TIMEOUT_MS = 8000;

const getEndpointTimeoutMs = (options: IAkToolsNewsProviderOptions): number => {
  const timeoutMs = options.endpointTimeoutMs ?? DEFAULT_ENDPOINT_TIMEOUT_MS;
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULT_ENDPOINT_TIMEOUT_MS;
};

const fetchWithTimeout = async (
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const request = fetchImpl(url, {
    ...init,
    signal: controller.signal,
  });
  const timeout = new Promise<Response>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([request, timeout]);
  }
  finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
};

const normalizeBaseUrl = (baseUrl: string): string => {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
};

const toNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const parseAktoolsDate = (raw: string): Date | null => {
  const normalized = raw.trim();
  const isoWithOffset = /^\d{4}-\d{2}-\d{2}T/u.test(normalized) && /(?:Z|[+-]\d{2}:\d{2})$/u.test(normalized);
  if (isoWithOffset) {
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/u);
  if (!match) {
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  return new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour) - 8,
    Number(minute),
    Number(second),
  ));
};

const toIsoString = (raw: string | null, fallback: Date): string => {
  if (!raw) {
    return fallback.toISOString();
  }

  const parsed = parseAktoolsDate(raw);
  if (!parsed) {
    return fallback.toISOString();
  }

  if (Number.isNaN(parsed.getTime())) {
    return fallback.toISOString();
  }

  return parsed.toISOString();
};

const getBeijingDateKey = (value: Date): string => {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
};

const isToday = (publishedAt: string, referenceDate: Date): boolean => {
  const published = new Date(publishedAt);
  if (Number.isNaN(published.getTime())) {
    return false;
  }

  return getBeijingDateKey(referenceDate) === getBeijingDateKey(published);
};

const buildQueryUrl = (baseUrl: string, endpoint: string): string => {
  return `${normalizeBaseUrl(baseUrl)}/api/public/${endpoint}`;
};

const createRecordId = (
  spec: IAkToolsNewsEndpointSpec,
  query: string,
  input: {
    readonly title: string;
    readonly summary: string;
    readonly url: string;
    readonly publishedAt: string;
  },
): string => {
  const normalizedQuery = encodeURIComponent(query.trim() || 'all');
  const digest = crypto
    .createHash('sha1')
    .update([
      spec.source,
      normalizedQuery,
      input.publishedAt,
      input.url,
      input.title,
      input.summary,
    ].join('\n'))
    .digest('hex')
    .slice(0, 20);
  return `${spec.source}:${normalizedQuery}:${digest}`;
};

const matchesQuery = (record: IAkToolsRecord, query: string): boolean => {
  const normalizedQuery = query.trim();

  if (normalizedQuery.length === 0) {
    return true;
  }

  const haystacks = [
    toNonEmptyString(record['标题']),
    toNonEmptyString(record['摘要']),
    toNonEmptyString(record['内容']),
    toNonEmptyString(record['事件']),
    toNonEmptyString(record['地区']),
  ].filter((value): value is string => value !== null);

  return haystacks.some(value => value.includes(normalizedQuery));
};

const mapRecord = (
  spec: IAkToolsNewsEndpointSpec,
  record: IAkToolsRecord,
  query: string,
  metadata: IProviderRequestMetadata,
  _index: number,
): IProviderNewsArticlePayload | null => {
  if (spec.endpoint === 'stock_info_global_em') {
    const title = toNonEmptyString(record['标题']);
    const summary = toNonEmptyString(record['摘要']) ?? title;
    const url = toNonEmptyString(record['链接']) ?? '';

    if (!title || !summary) {
      return null;
    }

    const publishedAt = toIsoString(toNonEmptyString(record['发布时间']), metadata.requestedAt);
    return {
      id: createRecordId(spec, query, { title, summary, url, publishedAt }),
      title,
      summary,
      url,
      publishedAt,
      capturedAt: metadata.requestedAt.toISOString(),
      providerMetadata: {
        provider: 'aktools',
        source: spec.source,
        endpoint: spec.endpoint,
        originalPublishedAt: toNonEmptyString(record['发布时间']),
      },
    };
  }

  if (spec.endpoint === 'stock_info_global_cls' || spec.endpoint === 'stock_info_global_ths') {
    const title = toNonEmptyString(record['标题']);
    const summary = toNonEmptyString(record['内容']) ?? title;
    const url = spec.endpoint === 'stock_info_global_ths' ? (toNonEmptyString(record['链接']) ?? '') : '';

    if (!title || !summary) {
      return null;
    }

    const publishedAtRaw = spec.endpoint === 'stock_info_global_cls'
      ? `${toNonEmptyString(record['发布日期']) ?? ''} ${toNonEmptyString(record['发布时间']) ?? ''}`.trim()
      : toNonEmptyString(record['发布时间']);
    const publishedAt = toIsoString(publishedAtRaw, metadata.requestedAt);

    return {
      id: createRecordId(spec, query, { title, summary, url, publishedAt }),
      title,
      summary,
      url,
      publishedAt,
      capturedAt: metadata.requestedAt.toISOString(),
      providerMetadata: {
        provider: 'aktools',
        source: spec.source,
        endpoint: spec.endpoint,
        originalPublishedAt: publishedAtRaw,
      },
    };
  }

  if (spec.endpoint === 'news_economic_baidu') {
    const event = toNonEmptyString(record['事件']);
    const region = toNonEmptyString(record['地区']);
    const importance = toNonEmptyString(record['重要性']);
    const title = region && event ? `${region}: ${event}` : event;
    const summary = [event, importance ? `重要性：${importance}` : null]
      .filter((item): item is string => item !== null)
      .join(' ');
    const publishedAtRaw = `${toNonEmptyString(record['日期']) ?? ''} ${toNonEmptyString(record['时间']) ?? ''}`.trim();
    const publishedAt = toIsoString(publishedAtRaw, metadata.requestedAt);

    if (!title || !summary) {
      return null;
    }

    return {
      id: createRecordId(spec, query, { title, summary, url: '', publishedAt }),
      title,
      summary,
      url: '',
      publishedAt,
      capturedAt: metadata.requestedAt.toISOString(),
      providerMetadata: {
        provider: 'aktools',
        source: spec.source,
        endpoint: spec.endpoint,
        originalPublishedAt: publishedAtRaw,
        region,
        importance,
      },
    };
  }

  // Should not reach here as all endpoints are handled above
  return null;
};

export class AkToolsHttpNewsProvider implements ISourceProvider<INewsSourceRequest, IProviderNewsResponse> {
  public readonly name = 'aktools-news-provider';

  private readonly fetchImpl: typeof fetch;

  private lastHealthStatus: ISourceProviderHealthStatus = {
    available: true,
    checkedAt: new Date(0),
    detail: 'not-checked',
  };

  public constructor(private readonly options: IAkToolsNewsProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public execute(_request: INewsSourceRequest, _metadata: IProviderRequestMetadata): IProviderNewsResponse {
    throw new Error('AkToolsHttpNewsProvider.execute is async-only; use executeAsync() from integration harness.');
  }

  public async executeAsync(
    request: INewsSourceRequest,
    metadata: IProviderRequestMetadata,
  ): Promise<IProviderNewsResponse> {
    const checkedAt = new Date();
    const referenceDate = request.asOf ?? checkedAt;
    const aggregatedItems: IProviderNewsArticlePayload[] = [];
    const touchedEndpoints: string[] = [];
    const skippedEndpoints: string[] = [];
    const endpointTimeoutMs = getEndpointTimeoutMs(this.options);

    for (const spec of ENDPOINT_SPECS) {
      const url = buildQueryUrl(this.options.baseUrl, spec.endpoint);
      let response: Response;

      try {
        response = await fetchWithTimeout(this.fetchImpl, url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
        }, endpointTimeoutMs);
      }
      catch (error) {
        const message = `AKTools request failed for ${spec.endpoint}: ${error instanceof Error ? error.message : 'unknown error'}`;
        skippedEndpoints.push(message);
        continue;
      }

      if (!response.ok) {
        const message = `AKTools request failed for ${spec.endpoint} with HTTP ${response.status}`;
        skippedEndpoints.push(message);
        continue;
      }

      const payload = await response.json();
      if (!Array.isArray(payload)) {
        const message = `AKTools returned non-array payload for ${spec.endpoint}`;
        skippedEndpoints.push(message);
        continue;
      }

      touchedEndpoints.push(spec.endpoint);
      const filteredRecords = payload
        .filter((item): item is IAkToolsRecord => item !== null && typeof item === 'object')
        .filter(item => matchesQuery(item, request.query));
      const mappedItems = filteredRecords
        .map((item, index) => mapRecord(spec, item, request.query, metadata, index))
        .filter((item): item is IProviderNewsArticlePayload => item !== null);

      aggregatedItems.push(...mappedItems);
    }

    const effectiveLimit = Math.max(1, Math.floor(request.limit ?? this.options.maxResults));
    const limitedItems = aggregatedItems
      .filter(item => isToday(item.publishedAt, referenceDate))
      .slice(0, effectiveLimit);

    if (limitedItems.length === 0) {
      const skippedDetail = skippedEndpoints.length > 0 ? `; skipped=${skippedEndpoints.join(' | ')}` : '';
      const allEndpointsUnavailable = touchedEndpoints.length === 0 && skippedEndpoints.length > 0;
      this.lastHealthStatus = {
        available: !allEndpointsUnavailable,
        checkedAt,
        detail: `${allEndpointsUnavailable ? 'unavailable' : 'empty-result'}:${touchedEndpoints.join(',')}${skippedDetail}`,
      };

      return {
        status: 'failure',
        failure: {
          category: allEndpointsUnavailable ? SourceFailureCategory.Unavailable : SourceFailureCategory.EmptyResult,
          message: `AKTools returned no mappable news results for query: ${request.query}${skippedDetail}`,
        },
        metadata: {
          requestId: `aktools-empty-${checkedAt.toISOString()}`,
          providerIdentity: this.name,
          queryRef: request.query,
        },
      };
    }

    this.lastHealthStatus = {
      available: true,
      checkedAt,
      detail: `ok:${limitedItems.length}:${touchedEndpoints.join(',')}${skippedEndpoints.length > 0 ? `; skipped=${skippedEndpoints.join(' | ')}` : ''}`,
    };

    return {
      status: 'success',
      payload: {
        kind: 'news',
        items: limitedItems,
      },
      metadata: {
        requestId: `aktools-${checkedAt.toISOString()}`,
        providerIdentity: this.name,
        queryRef: request.query,
      },
    };
  }

  public isAvailable(): boolean {
    return this.options.baseUrl.trim().length > 0;
  }

  public getHealthStatus(): ISourceProviderHealthStatus {
    return this.lastHealthStatus;
  }
}
