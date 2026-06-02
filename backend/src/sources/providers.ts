import type { INewsSource, INewsSourceArticle, INewsSourceRequest, INewsSourceResult, IProviderNewsArticlePayload, IProviderNewsResponse, IProviderSourceResponseMetadata, IProviderStockQuotePayload, IProviderStockResponse, ISourceItemMetadata, ISourceProvider, ISourceProviderHealthStatus, IStockSource, IStockSourceQuote, IStockSourceRequest, IStockSourceResult } from './contracts.js';
import {
  createProviderRequestMetadata,

  toSourceFailure,
} from './contracts.js';

const parseIsoDate = (raw: string, fieldName: string): Date => {
  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${fieldName}: ${raw}`);
  }

  return parsed;
};

const mergeMetadata = (
  providerName: string,
  responseMetadata: IProviderSourceResponseMetadata,
  itemMetadata: Readonly<Record<string, unknown>> | undefined,
  baseMetadata: Readonly<Record<string, unknown>>,
): ISourceItemMetadata => {
  return {
    provider: providerName,
    requestId: responseMetadata.requestId,
    providerIdentity: responseMetadata.providerIdentity,
    ...baseMetadata,
    ...itemMetadata,
  };
};

const mapNewsArticle = (
  providerName: string,
  responseMetadata: IProviderSourceResponseMetadata,
  request: INewsSourceRequest,
  payload: IProviderNewsArticlePayload,
): INewsSourceArticle => {
  return {
    title: payload.title,
    summary: payload.summary,
    url: payload.url,
    publishedAt: parseIsoDate(payload.publishedAt, 'publishedAt'),
    capturedAt: parseIsoDate(payload.capturedAt, 'capturedAt'),
    metadata: mergeMetadata(providerName, responseMetadata, payload.providerMetadata, {
      query: request.query,
      recordId: payload.id,
      queryRef: responseMetadata.queryRef,
    }),
  };
};

const mapStockQuote = (
  providerName: string,
  responseMetadata: IProviderSourceResponseMetadata,
  request: IStockSourceRequest,
  payload: IProviderStockQuotePayload,
): IStockSourceQuote => {
  return {
    symbol: payload.symbol,
    price: payload.price,
    currency: payload.currency,
    marketTime: parseIsoDate(payload.marketTime, 'marketTime'),
    capturedAt: parseIsoDate(payload.capturedAt, 'capturedAt'),
    metadata: mergeMetadata(providerName, responseMetadata, payload.providerMetadata, {
      symbol: request.symbol,
      symbolRef: responseMetadata.symbolRef,
    }),
  };
};

abstract class SourceAdapterBase<
  TKind extends 'news' | 'stock',
  TRequest extends INewsSourceRequest | IStockSourceRequest,
  TProviderResponse extends IProviderNewsResponse | IProviderStockResponse,
  TResult extends INewsSourceResult | IStockSourceResult,
> {
  protected constructor(
    public readonly kind: TKind,
    protected readonly provider: ISourceProvider<TRequest, TProviderResponse>,
  ) {}

  public get name(): string {
    return this.provider.name;
  }

  public isAvailable(): boolean {
    return this.provider.isAvailable();
  }

  public getHealthStatus(): ISourceProviderHealthStatus {
    return this.provider.getHealthStatus();
  }

  protected createRequestMetadata(): ReturnType<typeof createProviderRequestMetadata> {
    return createProviderRequestMetadata();
  }

  protected abstract mapResponse(request: TRequest, response: TProviderResponse): TResult;
}

export class TavilyNewsSource
  extends SourceAdapterBase<'news', INewsSourceRequest, IProviderNewsResponse, INewsSourceResult>
  implements INewsSource {
  public constructor(provider: ISourceProvider<INewsSourceRequest, IProviderNewsResponse>) {
    super('news', provider);
  }

  public fetch(request: INewsSourceRequest): INewsSourceResult {
    const response = this.provider.execute(request, this.createRequestMetadata());
    return this.mapResponse(request, response);
  }

  protected override mapResponse(request: INewsSourceRequest, response: IProviderNewsResponse): INewsSourceResult {
    if (response.status === 'failure') {
      return {
        status: 'failure',
        kind: this.kind,
        request,
        failure: toSourceFailure(response.failure, response.metadata),
        metadata: response.metadata,
      };
    }

    return {
      status: 'success',
      kind: this.kind,
      request,
      items: response.payload.items.map(item => mapNewsArticle(this.name, response.metadata, request, item)),
      metadata: response.metadata,
    };
  }
}

abstract class StockSourceBase
  extends SourceAdapterBase<'stock', IStockSourceRequest, IProviderStockResponse, IStockSourceResult>
  implements IStockSource {
  protected constructor(provider: ISourceProvider<IStockSourceRequest, IProviderStockResponse>) {
    super('stock', provider);
  }

  public fetch(request: IStockSourceRequest): IStockSourceResult {
    const response = this.provider.execute(request, this.createRequestMetadata());
    return this.mapResponse(request, response);
  }

  protected override mapResponse(request: IStockSourceRequest, response: IProviderStockResponse): IStockSourceResult {
    if (response.status === 'failure') {
      return {
        status: 'failure',
        kind: this.kind,
        request,
        failure: toSourceFailure(response.failure, response.metadata),
        metadata: response.metadata,
      };
    }

    return {
      status: 'success',
      kind: this.kind,
      request,
      items: response.payload.items.map(item => mapStockQuote(this.name, response.metadata, request, item)),
      metadata: response.metadata,
    };
  }
}

export class YahooFinanceMarketSource extends StockSourceBase {
  public constructor(provider: ISourceProvider<IStockSourceRequest, IProviderStockResponse>) {
    super(provider);
  }
}

export class AkShareMarketSource extends StockSourceBase {
  public constructor(provider: ISourceProvider<IStockSourceRequest, IProviderStockResponse>) {
    super(provider);
  }
}
