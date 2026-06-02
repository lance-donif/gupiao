import type { Price } from '../value-objects/price.js';
import type { Symbol } from '../value-objects/symbol.js';
import type { TradeDate } from '../value-objects/trade-date.js';

export class Candle {
  public constructor(
    public readonly date: TradeDate,
    public readonly open: Price,
    public readonly high: Price,
    public readonly low: Price,
    public readonly close: Price,
    public readonly volume: number,
  ) {}
}

export class Stock {
  private readonly mutableCandles: Candle[];

  public constructor(
    public readonly id: string,
    public readonly symbol: Symbol,
    public readonly name: string,
    public readonly industry: string,
    candles: readonly Candle[] = [],
  ) {
    this.mutableCandles = [];

    for (const candle of candles) {
      this.addCandle(candle);
    }
  }

  public get candles(): readonly Candle[] {
    return this.mutableCandles;
  }

  public addCandle(candle: Candle): void {
    const insertionIndex = Stock.findInsertionIndex(this.mutableCandles, candle);
    this.mutableCandles.splice(insertionIndex, 0, candle);
  }

  public equals(other: Stock): boolean {
    return this.id === other.id;
  }

  private static findInsertionIndex(candles: readonly Candle[], target: Candle): number {
    let left = 0;
    let right = candles.length;
    const targetValue = target.date.valueOf();

    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      const middleValue = candles[middle]?.date.valueOf() ?? targetValue;

      if (middleValue <= targetValue) {
        left = middle + 1;
      }
      else {
        right = middle;
      }
    }

    return left;
  }
}
