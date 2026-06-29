import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadBackendEnv } from '../src/services/load-backend-env.js';

loadBackendEnv();

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://gupiao:password@localhost:5432/gupiaodb';
const AKTOOLS_BASE_URL = process.env.AKTOOLS_BASE_URL ?? 'http://127.0.0.1:8010';

interface IAkCandle {
  日期: string;
  开盘: number;
  最高: number;
  最低: number;
  收盘: number;
  成交量: number;
}

// 格式化 Date 为 YYYYMMDD
const toYYYYMMDD = (date: Date): string => {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
};

async function asyncPool<T, R>(concurrency: number, iterable: T[], iteratorFn: (item: T) => Promise<R>): Promise<R[]> {
  const ret: Promise<R>[] = [];
  const executing: Promise<any>[] = [];
  for (const item of iterable) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);
    if (concurrency <= iterable.length) {
      const e: any = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= concurrency) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(ret);
}

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL }),
  });

  try {
    console.log('正在获取所有股票符号...');
    const stocks = await prisma.stock.findMany({
      select: { id: true, symbol: true },
    });
    console.log(`数据库中共有 ${stocks.length} 只股票。`);

    // 1. 自动推断增量同步的开始时间（读数据库里最新的行情日期）
    const latestCandle = await prisma.candle.findFirst({
      orderBy: { tradingDay: 'desc' },
      select: { tradingDay: true },
    });

    // 默认从 2026-01-01 开始，或者基于最新 K 线的时间
    let startDate = '20260101';
    if (latestCandle?.tradingDay) {
      // 增量从数据库最新 K 线交易日开始（Prisma createMany 会通过 skipDuplicates 避免重复）
      startDate = toYYYYMMDD(latestCandle.tradingDay);
    }

    // 结束日期为当前时间（北京时间今天）
    const endDate = toYYYYMMDD(new Date());

    console.log(`自动推断的同步区间：[${startDate} -> ${endDate}]`);

    if (startDate >= endDate) {
      console.log('数据已经是最新，无需同步。');
      return;
    }

    let successCount = 0;
    let failCount = 0;
    let totalCandlesInserted = 0;
    let insertQueue: any[] = [];

    const flushQueue = async () => {
      if (insertQueue.length === 0) return;
      await prisma.candle.createMany({
        data: insertQueue,
        skipDuplicates: true,
      });
      totalCandlesInserted += insertQueue.length;
      insertQueue = [];
    };

    console.log(`开始增量同步行情...`);
    const startTime = Date.now();
    let processed = 0;

    await asyncPool(40, stocks, async (stock) => {
      const url = `${AKTOOLS_BASE_URL}/api/public/stock_zh_a_hist?symbol=${stock.symbol}&start_date=${startDate}&end_date=${endDate}&adjust=qfq`;
      try {
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json() as IAkCandle[];
        if (Array.isArray(data)) {
          const rows = data.map((item) => {
            const tradingDay = new Date(item['日期'] + 'T00:00:00.000Z');
            return {
              stockId: stock.id,
              tradingDay,
              open: item['开盘'],
              high: item['最高'],
              low: item['最低'],
              close: item['收盘'],
              volume: BigInt(item['成交量']),
            };
          });

          insertQueue.push(...rows);
          if (insertQueue.length >= 2000) {
            await flushQueue();
          }
          successCount++;
        } else {
          failCount++;
        }
      } catch (err) {
        failCount++;
      } finally {
        processed++;
        if (processed % 500 === 0) {
          console.log(`  已处理 ${processed}/${stocks.length} 只股票...`);
        }
      }
    });

    await flushQueue();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n行情增量同步完成：`);
    console.log(`  成功: ${successCount} 只股票`);
    console.log(`  失败: ${failCount} 只股票`);
    console.log(`  共写入/更新 K 线数: ${totalCandlesInserted}`);
    console.log(`  总耗时: ${elapsed} 秒`);
  } catch (error) {
    console.error('同步异常:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
