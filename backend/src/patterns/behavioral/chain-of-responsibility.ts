export interface IRequestHandler<TRequest, TResponse> {
  setNext: (handler: IRequestHandler<TRequest, TResponse>) => IRequestHandler<TRequest, TResponse>;
  handle: (request: TRequest) => TResponse | null;
}

export abstract class AbstractHandler<TRequest, TResponse>
implements IRequestHandler<TRequest, TResponse> {
  private nextHandler: IRequestHandler<TRequest, TResponse> | null = null;

  public setNext(
    handler: IRequestHandler<TRequest, TResponse>,
  ): IRequestHandler<TRequest, TResponse> {
    this.nextHandler = handler;
    return handler;
  }

  public handle(request: TRequest): TResponse | null {
    const result = this.tryHandle(request);

    if (result !== null) {
      return result;
    }

    return this.nextHandler?.handle(request) ?? null;
  }

  protected abstract tryHandle(request: TRequest): TResponse | null;
}

export interface IKeywordRequest {
  readonly keyword: string;
}

export class BankingKeywordHandler extends AbstractHandler<IKeywordRequest, string> {
  protected override tryHandle(request: IKeywordRequest): string | null {
    return request.keyword.includes('银行') ? 'banking' : null;
  }
}

export class TechnologyKeywordHandler extends AbstractHandler<IKeywordRequest, string> {
  protected override tryHandle(request: IKeywordRequest): string | null {
    return request.keyword.includes('芯片') ? 'technology' : null;
  }
}
