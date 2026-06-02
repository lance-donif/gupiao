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

export interface IStockSourceRequest extends ISourceRequestBase {
  readonly symbol: string;
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

export type IProviderStockResponse
  = | IProviderSuccessResponse<IProviderStockQuotesPayload>
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

export interface IStockSourceQuote {
  readonly symbol: string;
  readonly price: number;
  readonly currency: string;
  readonly marketTime: Date;
  readonly capturedAt: Date;
  readonly metadata: ISourceItemMetadata;
}

export interface ISourceFailure {
  readonly category: SourceFailureCategory;
  readonly message: string;
  readonly retryAfterSeconds?: number;
  readonly metadata: IProviderSourceResponseMetadata;
}

export interface ISourceSuccessResult<
  TKind extends 'news' | 'stock',
  TRequest extends ISourceRequestBase,
  TItem,
> {
  readonly status: 'success';
  readonly kind: TKind;
  readonly request: TRequest;
  readonly items: readonly TItem[];
  readonly metadata: IProviderSourceResponseMetadata;
}

export interface ISourceFailureResult<TKind extends 'news' | 'stock', TRequest extends ISourceRequestBase> {
  readonly status: 'failure';
  readonly kind: TKind;
  readonly request: TRequest;
  readonly failure: ISourceFailure;
  readonly metadata: IProviderSourceResponseMetadata;
}

export type INewsSourceFetchSuccess = ISourceSuccessResult<'news', INewsSourceRequest, INewsSourceArticle>;
export type INewsSourceFetchFailure = ISourceFailureResult<'news', INewsSourceRequest>;
export type INewsSourceResult = INewsSourceFetchSuccess | INewsSourceFetchFailure;

export type IStockSourceFetchSuccess = ISourceSuccessResult<'stock', IStockSourceRequest, IStockSourceQuote>;
export type IStockSourceFetchFailure = ISourceFailureResult<'stock', IStockSourceRequest>;
export type IStockSourceResult = IStockSourceFetchSuccess | IStockSourceFetchFailure;

export interface ISourceProvider<TRequest extends ISourceRequestBase, TResponse> {
  readonly name: string;

  execute: (request: TRequest, metadata: IProviderRequestMetadata) => TResponse;

  isAvailable: () => boolean;

  getHealthStatus: () => ISourceProviderHealthStatus;
}

export interface INewsSource {
  readonly kind: 'news';
  readonly name: string;

  fetch: (request: INewsSourceRequest) => INewsSourceResult;

  isAvailable: () => boolean;

  getHealthStatus: () => ISourceProviderHealthStatus;
}

export interface IStockSource {
  readonly kind: 'stock';
  readonly name: string;

  fetch: (request: IStockSourceRequest) => IStockSourceResult;

  isAvailable: () => boolean;

  getHealthStatus: () => ISourceProviderHealthStatus;
}

export const toSourceFailure = (
  failure: IProviderFailurePayload,
  metadata: IProviderSourceResponseMetadata,
): ISourceFailure => {
  return {
    category: failure.category,
    message: failure.message,
    retryAfterSeconds: failure.retryAfterSeconds,
    metadata,
  };
};

export const createProviderRequestMetadata = (): IProviderRequestMetadata => {
  return {
    requestedAt: new Date(),
  };
};
