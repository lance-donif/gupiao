import type { KeywordCategory } from './keyword.js';

export type SignalTemperature = 'hot' | 'cold' | 'warming';

export interface ISignalNodeInput {
  readonly keyword: string;
  readonly category: KeywordCategory;
  readonly temperature: SignalTemperature;
  readonly weakSignal: boolean;
  readonly frequency: number;
  readonly updatedAt: Date;
}

export class SignalNode {
  public readonly keyword: string;
  public readonly category: KeywordCategory;
  public readonly temperature: SignalTemperature;
  public readonly weakSignal: boolean;
  public readonly frequency: number;
  public readonly updatedAt: Date;

  public constructor(input: ISignalNodeInput) {
    this.keyword = input.keyword;
    this.category = input.category;
    this.temperature = input.temperature;
    this.weakSignal = input.weakSignal;
    this.frequency = input.frequency;
    this.updatedAt = new Date(input.updatedAt);
  }
}
