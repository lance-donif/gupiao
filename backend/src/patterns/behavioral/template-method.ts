export interface IPipelineReport<TData> {
  readonly input: TData;
  readonly processed: TData;
  readonly steps: readonly string[];
}

export abstract class AbstractPipeline<TData> {
  protected constructor() {
    Object.defineProperty(this, 'process', {
      value: (input: TData): IPipelineReport<TData> => this.runTemplate(input),
      writable: false,
      configurable: false,
      enumerable: false,
    });
  }

  public process(input: TData): IPipelineReport<TData> {
    return this.runTemplate(input);
  }

  private runTemplate(input: TData): IPipelineReport<TData> {
    const steps: string[] = [];

    this.before(input, steps);
    const processed = this.transform(input, steps);
    this.after(processed, steps);

    return {
      input,
      processed,
      steps,
    };
  }

  protected before(_input: TData, _steps: string[]): void {}

  protected abstract transform(input: TData, steps: string[]): TData;

  protected after(_processed: TData, _steps: string[]): void {}
}

Object.defineProperty(AbstractPipeline.prototype, 'process', {
  writable: false,
  configurable: false,
});

export class NewsNormalizationPipeline extends AbstractPipeline<string> {
  public constructor() {
    super();
  }

  protected override before(_input: string, steps: string[]): void {
    steps.push('before:trim');
  }

  protected override transform(input: string, steps: string[]): string {
    steps.push('transform:normalize-whitespace');
    return input.trim().replace(/\s+/g, ' ');
  }

  protected override after(_processed: string, steps: string[]): void {
    steps.push('after:publish');
  }
}
