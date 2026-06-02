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

export interface IServiceExecutionContext {
  readonly runtime: IServiceRuntimeContext;
  readonly idempotency: IServiceIdempotencyBoundary;
}

const ensureValidTimeWindow = (timeWindow: IServiceTimeWindow): IServiceTimeWindow => {
  if (timeWindow.start.getTime() > timeWindow.end.getTime()) {
    throw new Error('Service timeWindow start must be earlier than or equal to end');
  }

  return timeWindow;
};

export const createServiceRuntimeContext = (
  runtime: IServiceRuntimeContext,
): IServiceRuntimeContext => {
  return {
    cluster: runtime.cluster,
    asOf: runtime.asOf,
    timeWindow: runtime.timeWindow ? ensureValidTimeWindow(runtime.timeWindow) : undefined,
  };
};

export const hasExplicitRuntimeBoundary = (runtime: IServiceRuntimeContext): boolean => {
  return Boolean(runtime.asOf || runtime.timeWindow);
};

const formatTimeWindow = (timeWindow?: IServiceTimeWindow): string => {
  if (!timeWindow) {
    return 'open-window';
  }

  return `${timeWindow.start.toISOString()}..${timeWindow.end.toISOString()}`;
};

export const createServiceIdempotencyBoundary = (
  runtime: IServiceRuntimeContext,
  discriminator: string,
): IServiceIdempotencyBoundary => {
  const scopeKey = [
    runtime.cluster,
    runtime.asOf?.toISOString() ?? 'latest',
    formatTimeWindow(runtime.timeWindow),
    discriminator,
  ].join('::');

  return {
    scopeKey,
    replaySafe: true,
    deduplicationKey: scopeKey,
  };
};

export const createServiceExecutionContext = (
  runtime: IServiceRuntimeContext,
  discriminator: string,
): IServiceExecutionContext => {
  const normalizedRuntime = createServiceRuntimeContext(runtime);

  return {
    runtime: normalizedRuntime,
    idempotency: createServiceIdempotencyBoundary(normalizedRuntime, discriminator),
  };
};

export const isDateInsideRuntimeWindow = (
  value: Date,
  runtime: IServiceRuntimeContext,
): boolean => {
  const afterWindowStart = !runtime.timeWindow || value.getTime() >= runtime.timeWindow.start.getTime();
  const beforeWindowEnd = !runtime.timeWindow || value.getTime() <= runtime.timeWindow.end.getTime();
  const beforeAsOf = !runtime.asOf || value.getTime() <= runtime.asOf.getTime();

  return afterWindowStart && beforeWindowEnd && beforeAsOf;
};
