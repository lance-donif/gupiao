import { describe, expect, it } from 'vitest';

import {
  SourceRegistryFactory,
  SourceSelectionService,
  AbstractPipeline,
  AgentStateContext,
  AkShareMarketSource,
  AppendTaskCommand,
  BankingKeywordHandler,
  CompletedState,
  ErrorState,
  EventRecorder,
  EventSubject,
  FirstAvailableStrategy,
  FixedWindowRateLimiter,
  HighestPriorityAvailableStrategy,
  IdleState,
  NewsNormalizationPipeline,
  RegisteredSourceSelectionStrategyAdapter,
  RunningState,
  SourceSelectionContext,
  SourceFailureCategory,
  TaskBoard,
  TechnologyKeywordHandler,
  type INewsSourceRequest,
  type IProviderNewsResponse,
  type IProviderRequestMetadata,
  type IProviderStockResponse,
  type ISourceProvider,
  type ISourceProviderDependencies,
  type ISelectableSource,
  type IStockSourceRequest,
} from '../../../../src/index.js';

class StubNewsProvider implements ISourceProvider<INewsSourceRequest, IProviderNewsResponse> {
  public readonly name = 'tavily-provider';

  public execute(
    request: INewsSourceRequest,
    metadata: IProviderRequestMetadata,
  ): IProviderNewsResponse {
    void request;
    void metadata;
    return {
      status: 'failure',
      failure: {
        category: SourceFailureCategory.EmptyResult,
        message: 'no news',
      },
      metadata: {
        requestId: 'req-news',
        providerIdentity: 'tavily-provider',
      },
    };
  }

  public isAvailable(): boolean {
    return true;
  }

  public getHealthStatus(): {
    readonly available: boolean;
    readonly checkedAt: Date;
    readonly detail: string;
  } {
    return {
      available: true,
      checkedAt: new Date('2026-03-17T08:00:00.000Z'),
      detail: 'ok',
    };
  }
}

class StubStockProvider implements ISourceProvider<IStockSourceRequest, IProviderStockResponse> {
  public constructor(
    public readonly name: string,
    private readonly available: boolean,
  ) {}

  public execute(
    request: IStockSourceRequest,
    metadata: IProviderRequestMetadata,
  ): IProviderStockResponse {
    void request;
    void metadata;
    return {
      status: 'failure',
      failure: {
        category: SourceFailureCategory.EmptyResult,
        message: 'no quotes',
      },
      metadata: {
        requestId: `req-${this.name}`,
        providerIdentity: this.name,
      },
    };
  }

  public isAvailable(): boolean {
    return this.available;
  }

  public getHealthStatus(): {
    readonly available: boolean;
    readonly checkedAt: Date;
    readonly detail: string;
  } {
    return {
      available: this.available,
      checkedAt: new Date('2026-03-17T08:00:00.000Z'),
      detail: this.available ? 'ok' : 'offline',
    };
  }
}

const createDependencies = (): ISourceProviderDependencies => {
  return {
    rateLimiter: new FixedWindowRateLimiter({
      maxRequests: 10,
      windowMs: 60_000,
    }),
    tavilyNewsProvider: new StubNewsProvider(),
    yahooMarketProvider: new StubStockProvider('yahoo-provider', false),
    akshareMarketProvider: new StubStockProvider('akshare-provider', true),
  };
};

describe('behavioral patterns', () => {
  it('supports swapping strategies at runtime for source selection', () => {
    const sources: readonly ISelectableSource[] = [
      { name: 'fallback', priority: 3, available: true },
      { name: 'preferred', priority: 1, available: true },
      { name: 'offline', priority: 0, available: false },
    ];
    const context = new SourceSelectionContext(
      new HighestPriorityAvailableStrategy(),
    );

    expect(context.select(sources)?.name).toBe('preferred');

    context.setStrategy(new FirstAvailableStrategy());

    expect(context.select(sources)?.name).toBe('fallback');
  });

  it('applies availability-based selection to registered real sources instead of raw string branches', () => {
    const selectionService = new SourceSelectionService(
      new SourceRegistryFactory(createDependencies()),
      new RegisteredSourceSelectionStrategyAdapter(new HighestPriorityAvailableStrategy()),
    );

    const selected = selectionService.select([
      { kind: 'yahoo-market', priority: 0 },
      { kind: 'akshare-market', priority: 1 },
    ] as const);

    expect(selected?.kind).toBe('akshare-market');
    expect(selected?.source).toBeInstanceOf(AkShareMarketSource);
    expect(selected?.source.isAvailable()).toBe(true);
  });

  it('restores command state after undo', () => {
    const board = new TaskBoard(['fetch-news']);
    const command = new AppendTaskCommand(board, 'sync-stock');

    const executed = command.execute();
    const undone = command.undo();

    expect(executed.snapshot).toEqual(['fetch-news', 'sync-stock']);
    expect(undone.snapshot).toEqual(['fetch-news']);
    expect(board.snapshot()).toEqual(['fetch-news']);
  });

  it('notifies all observers when an event is published', () => {
    const subject = new EventSubject<{ readonly type: string }>();
    const firstObserver = new EventRecorder<{ readonly type: string }>();
    const secondObserver = new EventRecorder<{ readonly type: string }>();

    subject.subscribe(firstObserver);
    subject.subscribe(secondObserver);
    subject.notify({ type: 'pipeline.completed' });

    expect(firstObserver.getEvents()).toEqual([{ type: 'pipeline.completed' }]);
    expect(secondObserver.getEvents()).toEqual([{ type: 'pipeline.completed' }]);
  });

  it('enforces the template method skeleton through fixed process orchestration', () => {
    const pipeline = new NewsNormalizationPipeline();
    const report = pipeline.process('  A股   市场  回暖  ');
    const descriptor = Object.getOwnPropertyDescriptor(
      AbstractPipeline.prototype,
      'process',
    );

    expect(report.processed).toBe('A股 市场 回暖');
    expect(report.steps).toEqual([
      'before:trim',
      'transform:normalize-whitespace',
      'after:publish',
    ]);
    expect(descriptor?.writable).toBe(false);
  });

  it('prevents subclass process overrides from bypassing the template skeleton', () => {
    class OverrideAttemptPipeline extends AbstractPipeline<string> {
      public constructor() {
        super();
      }

      public override process(_input: string): {
        readonly input: string;
        readonly processed: string;
        readonly steps: readonly string[];
      } {
        return {
          input: 'override-input',
          processed: 'override-processed',
          steps: ['override:process'],
        };
      }

      protected override before(_input: string, steps: string[]): void {
        steps.push('before:guard');
      }

      protected override transform(input: string, steps: string[]): string {
        steps.push('transform:uppercase');
        return input.trim().toUpperCase();
      }

      protected override after(_processed: string, steps: string[]): void {
        steps.push('after:sealed');
      }
    }

    const pipeline = new OverrideAttemptPipeline();
    const ownDescriptor = Object.getOwnPropertyDescriptor(pipeline, 'process');
    const report = pipeline.process('  growth  ');

    expect(report).toEqual({
      input: '  growth  ',
      processed: 'GROWTH',
      steps: ['before:guard', 'transform:uppercase', 'after:sealed'],
    });
    expect(ownDescriptor?.writable).toBe(false);
    expect(ownDescriptor?.configurable).toBe(false);
  });

  it('propagates requests through the chain until one handler resolves them', () => {
    const bankingHandler = new BankingKeywordHandler();
    bankingHandler.setNext(new TechnologyKeywordHandler());

    expect(bankingHandler.handle({ keyword: '银行股估值修复' })).toBe('banking');
    expect(bankingHandler.handle({ keyword: '国产芯片突破' })).toBe('technology');
    expect(bankingHandler.handle({ keyword: '白酒板块震荡' })).toBeNull();
  });

  it('validates state transitions and records enter/exit hooks', () => {
    const context = new AgentStateContext(new IdleState());

    context.transitionTo(new RunningState());
    context.transitionTo(new CompletedState());

    expect(context.getState().name).toBe('completed');
    expect(context.getTransitionLog()).toEqual([
      'enter:idle',
      'exit:idle',
      'enter:running',
      'exit:running',
      'enter:completed',
    ]);
    expect(() => context.transitionTo(new ErrorState())).toThrowError(
      'Invalid transition from completed to error.',
    );
  });
});
