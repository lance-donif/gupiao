export interface ISourceTimeWindow {
  readonly start: Date;
  readonly end: Date;
}

export interface ISourceRequestBase {
  readonly asOf?: Date;
  readonly timeWindow?: ISourceTimeWindow;
  readonly limit?: number;
}

export interface INewsSourceRequest extends ISourceRequestBase {
  readonly query: string;
}

export interface ISourceProviderHealthStatus {
  readonly available: boolean;
  readonly checkedAt: Date;
  readonly detail: string;
}

export interface IProviderRequestMetadata {
  readonly requestedAt: Date;
}

export interface IProviderSourceResponseMetadata {
  readonly requestId: string;
  readonly providerIdentity: string;
  readonly queryRef?: string;
  readonly symbolRef?: string;
}

export enum SourceFailureCategory {
  Unavailable = 'unavailable',
  RateLimited = 'rate_limited',
  BadPayload = 'bad_payload',
  EmptyResult = 'empty_result',
}

export interface IProviderFailurePayload {
  readonly category: SourceFailureCategory;
  readonly message: string;
  readonly retryAfterSeconds?: number;
}

export interface IProviderNewsArticlePayload {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly url: string;
  readonly publishedAt: string;
  readonly capturedAt: string;
  readonly providerMetadata?: Readonly<Record<string, unknown>>;
}

export interface IProviderNewsPayload {
  readonly kind: 'news';
  readonly items: readonly IProviderNewsArticlePayload[];
}

export interface IProviderStockQuotePayload {
  readonly symbol: string;
  readonly price: number;
  readonly currency: string;
  readonly marketTime: string;
  readonly capturedAt: string;
  readonly providerMetadata?: Readonly<Record<string, unknown>>;
}

export interface IProviderStockQuotesPayload {
  readonly kind: 'stock';
  readonly items: readonly IProviderStockQuotePayload[];
}

export type IProviderSuccessPayload = IProviderNewsPayload | IProviderStockQuotesPayload;

export interface IProviderSuccessResponse<TPayload extends IProviderSuccessPayload> {
  readonly status: 'success';
  readonly payload: TPayload;
  readonly metadata: IProviderSourceResponseMetadata;
}

export interface IProviderFailureResponse {
  readonly status: 'failure';
  readonly failure: IProviderFailurePayload;
  readonly metadata: IProviderSourceResponseMetadata;
}

export type IProviderNewsResponse
  = | IProviderSuccessResponse<IProviderNewsPayload>
    | IProviderFailureResponse;

export interface ISourceItemMetadata extends Readonly<Record<string, unknown>> {
  readonly provider: string;
  readonly requestId: string;
  readonly providerIdentity: string;
}

export interface INewsSourceArticle {
  readonly title: string;
  readonly summary: string;
  readonly url: string;
  readonly publishedAt: Date;
  readonly capturedAt: Date;
  readonly metadata: ISourceItemMetadata;
}


export interface ISourceProvider<TRequest extends ISourceRequestBase, TResponse> {
  readonly name: string;

  execute: (request: TRequest, metadata: IProviderRequestMetadata) => TResponse;

  isAvailable: () => boolean;

  getHealthStatus: () => ISourceProviderHealthStatus;
}




export const createProviderRequestMetadata = (): IProviderRequestMetadata => {
  return {
    requestedAt: new Date(),
  };
};
