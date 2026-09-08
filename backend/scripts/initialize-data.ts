import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadBackendEnv } from '../src/services/load-backend-env.js';
import { saveStockSyncFile } from './sync-stocks.js';

export interface IInitialStock {
  readonly symbol: string;
  readonly name: string;
}

export const parseInitialStocks = (payload: unknown): IInitialStock[] => {
  if (!Array.isArray(payload)) throw new Error('Stock universe must be an array');
  const stocks = new Map<string, IInitialStock>();
  for (const row of payload) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const symbol = String(record.code ?? record.symbol ?? record['代码'] ?? '').trim();
    const name = String(record.name ?? record.stock_name ?? record['名称'] ?? '').trim();
    if (/^(?:60|68|00|30)\d{4}$/.test(symbol) && name) stocks.set(symbol, { symbol, name });
  }
  if (stocks.size === 0) throw new Error('Stock universe is empty');
  return [...stocks.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
};

async function main(): Promise<void> {
  loadBackendEnv();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const baseUrl = (process.env.AKTOOLS_BASE_URL ?? 'http://127.0.0.1:8010').replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}/api/public/stock_info_a_code_name`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Stock universe HTTP ${response.status}`);
  const stocks = parseInitialStocks(await response.json());
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  try {
    for (const stock of stocks) {
      await prisma.stock.upsert({
        where: { clusterKey_symbol: { clusterKey: 'global', symbol: stock.symbol } },
        create: { id: `stock-${stock.symbol}`, ...stock, industry: '', clusterKey: 'global', exchange: stock.symbol.startsWith('6') ? 'SSE' : 'SZSE' },
        update: { name: stock.name },
      });
    }
    const file = await saveStockSyncFile({
      syncedAtBeijing: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }),
      totalSymbols: stocks.length,
      successCount: stocks.length,
      failedCount: 0,
      failedSymbols: [],
      requestedSymbols: stocks.map(stock => stock.symbol),
      data: stocks,
    });
    console.log(JSON.stringify({ stocks: stocks.length, file }));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
