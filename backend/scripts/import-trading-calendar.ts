/**
 * 从 Candle 表反推真实交易日历，写入 TradingCalendarDay。
 *
 * 安全约束：默认只允许测试库（数据库名含 gupiao_test）。
 * 对生产库运行必须显式传 `--allow-production` 或设置 `ALLOW_PRODUCTION_WRITES=1`，
 * `--force` 仅作为旧参数别名保留。脚本只做 upsert，绝不删除既有行。
 * 反推逻辑：在 [最早交易日, 最晚交易日] 区间内逐日判定，凡存在 Candle 的日期即为开市日，
 * 否则（周末 / 法定调休假期等）为休市日。source 标记为 candle_reverse_engineered。
 *
 * 用法：
 *   DATABASE_URL=... bun scripts/import-trading-calendar.ts --exchange SSE --version candle-import
 *   DATABASE_URL=... bun scripts/import-trading-calendar.ts --exchange SSE --version candle-prod --allow-production
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const isTestDatabase = (url: string | undefined): boolean => {
  if (!url) return false;
  // 只允许测试库
  return /gupiao_test/i.test(url) || /[/?]database=gupiao_test/i.test(url);
};

const parseArgs = (argv: readonly string[]): { exchange: string; version: string; allowProduction: boolean } => {
  let exchange = 'SSE';
  let version = 'candle-import';
  let allowProduction = process.env.ALLOW_PRODUCTION_WRITES === '1';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--exchange') exchange = argv[i + 1] ?? exchange;
    else if (arg === '--version') version = argv[i + 1] ?? version;
    else if (arg === '--allow-production' || arg === '--force') allowProduction = true;
  }
  return { exchange, version, allowProduction };
};

const main = async (): Promise<void> => {
  const databaseUrl = process.env.DATABASE_URL
    ?? process.env.AI_TEST_DATABASE_URL
    ?? 'postgresql://gupiao:gupiao@localhost:5432/gupiao_test';

  const { exchange, version, allowProduction } = parseArgs(process.argv.slice(2));

  if (!isTestDatabase(databaseUrl) && !allowProduction) {
    throw new Error('拒绝在测试库以外的数据库运行 import-trading-calendar（数据库名需含 gupiao_test，或显式传 --allow-production / 设置 ALLOW_PRODUCTION_WRITES=1）。');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

  try {
    const bounds = await prisma.candle.aggregate({
      _min: { tradingDay: true },
      _max: { tradingDay: true },
    });
    const minDay = bounds._min.tradingDay;
    const maxDay = bounds._max.tradingDay;
    if (!minDay || !maxDay) {
      console.log('Candle 表无数据，跳过导入。');
      return;
    }

    const dayCursor = new Date(minDay.getTime());
    const dayMs = 24 * 60 * 60 * 1000;
    const tradingDays = new Set<string>();
    while (dayCursor.getTime() <= maxDay.getTime()) {
      const key = dayCursor.toISOString().slice(0, 10);
      tradingDays.add(key);
      dayCursor.setTime(dayCursor.getTime() + dayMs);
    }

    const existing = await prisma.candle.findMany({
      where: { tradingDay: { gte: minDay, lte: maxDay } },
      select: { tradingDay: true },
      distinct: ['tradingDay'],
    });
    const candleDays = new Set<string>(
      existing.map(row => (row.tradingDay instanceof Date ? row.tradingDay : new Date(row.tradingDay)).toISOString().slice(0, 10)),
    );

    let upserted = 0;
    const batch: Array<{ date: Date; isOpen: boolean }> = [];
    const cursor = new Date(minDay.getTime());
    while (cursor.getTime() <= maxDay.getTime()) {
      const key = cursor.toISOString().slice(0, 10);
      const isOpen = candleDays.has(key);
      batch.push({ date: new Date(cursor.getTime()), isOpen });
      cursor.setTime(cursor.getTime() + dayMs);
      if (batch.length >= 500) {
        upserted += await flush(prisma, exchange, version, batch.splice(0));
      }
    }
    if (batch.length > 0) {
      upserted += await flush(prisma, exchange, version, batch);
    }

    console.log(`已写入 TradingCalendarDay：${upserted} 条（exchange=${exchange}, version=${version}, 区间 ${tradingDays.size} 天）。`);
  } finally {
    await prisma.$disconnect();
  }
};

const flush = async (
  prisma: PrismaClient,
  exchange: string,
  version: string,
  rows: Array<{ date: Date; isOpen: boolean }>,
): Promise<number> => {
  let count = 0;
  for (const row of rows) {
    await prisma.tradingCalendarDay.upsert({
      where: {
        exchange_date_calendarVersion: {
          exchange,
          date: row.date,
          calendarVersion: version,
        },
      },
      create: {
        exchange,
        date: row.date,
        isOpen: row.isOpen,
        source: 'candle_reverse_engineered',
        calendarVersion: version,
      },
      update: {
        isOpen: row.isOpen,
        source: 'candle_reverse_engineered',
      },
    });
    count += 1;
  }
  return count;
};

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
