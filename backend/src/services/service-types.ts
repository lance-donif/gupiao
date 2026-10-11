export interface IServiceTimeWindow {
  readonly start: Date;
  readonly end: Date;
}

export interface IServiceRuntimeContext {
  readonly cluster: string;
  readonly asOf?: Date;
  readonly timeWindow?: IServiceTimeWindow;
}

export interface IServiceIdempotencyBoundary {
  readonly scopeKey: string;
  readonly replaySafe: boolean;
  readonly deduplicationKey: string;
}

