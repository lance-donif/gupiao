import { describe, expect, it } from 'vitest';

import { Candle, Price, Stock, Symbol, TradeDate } from '../../../../src/index.js';

const createCandle = (date: string, close: number): Candle => {
  const price = Price.from(close);

  return new Candle(
    TradeDate.from(date),
    price,
    Price.from(close + 1),
    Price.from(close - 1),
    price,
    1000,
  );
};

describe('Stock', () => {
  it('compares equality by id only', () => {
    const left = new Stock('stock-1', Symbol.from('600000'), '浦发银行', '银行');
    const sameId = new Stock('stock-1', Symbol.from('000001'), '平安银行', '银行');
    const differentId = new Stock('stock-2', Symbol.from('600000'), '浦发银行', '银行');

    expect(left.equals(sameId)).toBe(true);
    expect(left.equals(differentId)).toBe(false);
  });

  it('inserts candles in ascending date order', () => {
    const stock = new Stock('stock-1', Symbol.from('600000'), '浦发银行', '银行');

    stock.addCandle(createCandle('2025-03-14', 12));
    stock.addCandle(createCandle('2025-03-12', 10));
    stock.addCandle(createCandle('2025-03-13', 11));

    expect(stock.candles.map((candle) => candle.date.toString())).toEqual([
      '2025-03-12',
      '2025-03-13',
      '2025-03-14',
    ]);
  });

  it('keeps constructor-provided candles sorted through repeated insertion', () => {
    const stock = new Stock('stock-1', Symbol.from('600000'), '浦发银行', '银行', [
      createCandle('2025-03-14', 12),
      createCandle('2025-03-12', 10),
      createCandle('2025-03-13', 11),
    ]);

    expect(stock.candles.map((candle) => candle.date.toString())).toEqual([
      '2025-03-12',
      '2025-03-13',
      '2025-03-14',
    ]);
  });
});
