export interface IAppConfig {
  readonly sourceType: string;
  readonly retryCount: number;
  readonly timeoutMs: number;
  readonly dryRun: boolean;
  readonly metadata: Readonly<Record<string, string>>;
}

interface IConfigState {
  sourceType: string;
  retryCount: number;
  timeoutMs: number;
  dryRun: boolean;
  metadata: Record<string, string>;
}

const DEFAULT_CONFIG: IConfigState = {
  sourceType: 'memory',
  retryCount: 3,
  timeoutMs: 1_000,
  dryRun: false,
  metadata: {},
};

export class ConfigBuilder {
  private readonly state: IConfigState;

  public constructor(state?: Partial<IConfigState>) {
    this.state = {
      sourceType: state?.sourceType ?? DEFAULT_CONFIG.sourceType,
      retryCount: state?.retryCount ?? DEFAULT_CONFIG.retryCount,
      timeoutMs: state?.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
      dryRun: state?.dryRun ?? DEFAULT_CONFIG.dryRun,
      metadata: { ...(state?.metadata ?? DEFAULT_CONFIG.metadata) },
    };
  }

  public setSourceType(sourceType: string): this {
    if (sourceType.trim().length === 0) {
      throw new Error('sourceType must not be empty');
    }

    this.state.sourceType = sourceType;
    return this;
  }

  public setRetryCount(retryCount: number): this {
    if (!Number.isInteger(retryCount) || retryCount < 0) {
      throw new Error('retryCount must be a non-negative integer');
    }

    this.state.retryCount = retryCount;
    return this;
  }

  public setTimeoutMs(timeoutMs: number): this {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error('timeoutMs must be a positive integer');
    }

    this.state.timeoutMs = timeoutMs;
    return this;
  }

  public setDryRun(dryRun: boolean): this {
    this.state.dryRun = dryRun;
    return this;
  }

  public addMetadata(key: string, value: string): this {
    this.state.metadata[key] = value;
    return this;
  }

  public build(): IAppConfig {
    const metadata = Object.freeze({ ...this.state.metadata });

    return Object.freeze({
      sourceType: this.state.sourceType,
      retryCount: this.state.retryCount,
      timeoutMs: this.state.timeoutMs,
      dryRun: this.state.dryRun,
      metadata,
    });
  }
}
