import type { Stock } from '../../types/entities/stock.js';

export interface IStockRepository {
  add: (stock: Stock) => Promise<void>;
  remove: (id: string) => Promise<void>;
  findById: (id: string) => Promise<Stock | null>;
  findAll: () => Promise<readonly Stock[]>;
}
