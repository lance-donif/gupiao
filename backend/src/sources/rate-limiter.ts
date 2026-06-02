import type { IProviderNewsResponse, IProviderRequestMetadata, IProviderSourceResponseMetadata, IProviderStockResponse, ISourceProvider, ISourceProviderHealthStatus, ISourceRequestBase } from './contracts.js';
import {

  SourceFailureCategory,
} from './contracts.js';

export interface IRateLimitWindow {
  readonly maxRequests: number;
  readonly windowMs: number;
}

export interface IRateLimiterClock {
  now: () => number;
}

export interface IRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds?: number;
}

export interface IRateLimitRequestDescriptor {
  readonly providerName: string;
}

export interface IRateLimiter {
  consume: (request: IRateLimitRequestDescriptor) => IRateLimitDecision;
}

type ProviderResponse = IProviderNewsResponse | IProviderStockResponse;

const toRetryAfterSeconds = (windowMs: number): number => {
  return Math.max(1, Math.ceil(windowMs / 1000));
};

export class SystemRateLimiterClock implements IRateLimiterClock {
  public now(): number {
    return Date.now();
  }
}

export class FixedWindowRateLimiter implements IRateLimiter {
  private readonly requestLog: Map<string, number[]> = new Map();

  public constructor(
    private readonly window: IRateLimitWindow,
    private readonly clock: IRateLimiterClock = new SystemRateLimiterClock(),
  ) {}

  public consume(request: IRateLimitRequestDescriptor): IRateLimitDecision {
    const now = this.clock.now();
    const windowStart = now - this.window.windowMs;
    const recentRequests = (this.requestLog.get(request.providerName) ?? []).filter(
      timestamp => timestamp > windowStart,
    );

    if (recentRequests.length >= this.window.maxRequests) {
      this.requestLog.set(request.providerName, recentRequests);
      const oldestTimestamp = recentRequests[0];
      const retryAfterMs = oldestTimestamp + this.window.windowMs - now;

      return {
        allowed: false,
        retryAfterSeconds: toRetryAfterSeconds(retryAfterMs),
      };
    }

    recentRequests.push(now);
    this.requestLog.set(request.providerName, recentRequests);

    return {
      allowed: true,
    };
  }
}

const createRateLimitedResponse = <TResponse extends ProviderResponse>(
  metadata: IProviderSourceResponseMetadata,
  retryAfterSeconds: number,
): TResponse => {
  return {
    status: 'failure',
    failure: {
      category: SourceFailureCategory.RateLimited,
      message: 'Provider rate limit exceeded.',
      retryAfterSeconds,
    },
    metadata,
  } as TResponse;
};

export class RateLimitedSourceProvider<
  TRequest extends ISourceRequestBase,
  TResponse extends ProviderResponse,
> implements ISourceProvider<TRequest, TResponse> {
  public constructor(
    private readonly inner: ISourceProvider<TRequest, TResponse>,
    private readonly rateLimiter: IRateLimiter,
  ) {}

  public get name(): string {
    return this.inner.name;
  }

  public execute(request: TRequest, metadata: IProviderRequestMetadata): TResponse {
    const decision = this.rateLimiter.consume({
      providerName: this.name,
    });

    if (!decision.allowed) {
      return createRateLimitedResponse<TResponse>(
        this.createRateLimitMetadata(metadata),
        decision.retryAfterSeconds ?? 1,
      );
    }

    return this.inner.execute(request, metadata);
  }

  public isAvailable(): boolean {
    return this.inner.isAvailable();
  }

  public getHealthStatus(): ISourceProviderHealthStatus {
    return this.inner.getHealthStatus();
  }

  private createRateLimitMetadata(metadata: IProviderRequestMetadata): IProviderSourceResponseMetadata {
    return {
      requestId: `rate-limited-${this.name}-${metadata.requestedAt.toISOString()}`,
      providerIdentity: this.name,
    };
  }
}

export interface ISourceProviderRateLimiterDependencies {
  readonly rateLimiter: IRateLimiter;
}

export const withRateLimit = <
  TRequest extends ISourceRequestBase,
  TResponse extends ProviderResponse,
>(
  provider: ISourceProvider<TRequest, TResponse>,
  dependencies: ISourceProviderRateLimiterDependencies,
): ISourceProvider<TRequest, TResponse> => {
  return new RateLimitedSourceProvider(provider, dependencies.rateLimiter);
};
