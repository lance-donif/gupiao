export interface IExternalSourceRecord {
  readonly headline: string;
  readonly body: string;
  readonly publishedAtIso: string;
  readonly externalLink: string;
}

export interface ISourceArticle {
  readonly title: string;
  readonly summary: string;
  readonly publishedAt: Date;
  readonly url: string;
}

export interface ISourceHealthStatus {
  readonly available: boolean;
  readonly checkedAt: Date;
  readonly detail: string;
}

export interface ISourceTarget {
  readonly name: string;

  fetch: () => readonly ISourceArticle[];

  isAvailable: () => boolean;

  getHealthStatus: () => ISourceHealthStatus;
}

export interface IExternalSourceApi {
  readonly providerName: string;

  fetchRecords: () => readonly IExternalSourceRecord[];

  ping: () => {
    readonly ok: boolean;
    readonly checkedAtIso: string;
    readonly detail: string;
  };
}

export class ExternalSourceAdapter implements ISourceTarget {
  public constructor(private readonly adaptee: IExternalSourceApi) {}

  public get name(): string {
    return this.adaptee.providerName;
  }

  public fetch(): readonly ISourceArticle[] {
    return this.adaptee.fetchRecords().map((record) => {
      return {
        title: record.headline,
        summary: record.body,
        publishedAt: new Date(record.publishedAtIso),
        url: record.externalLink,
      } satisfies ISourceArticle;
    });
  }

  public isAvailable(): boolean {
    return this.adaptee.ping().ok;
  }

  public getHealthStatus(): ISourceHealthStatus {
    const status = this.adaptee.ping();

    return {
      available: status.ok,
      checkedAt: new Date(status.checkedAtIso),
      detail: status.detail,
    } satisfies ISourceHealthStatus;
  }
}
