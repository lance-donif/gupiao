import 'dotenv/config';
import { createBackendIntegrationConfig } from '../src/services/integration-config.js';
import { ensureLocalStockPoolFile, hasLocalStockPoolFile } from '../src/services/stock-history-sync-source.js';
import { runStockHistorySync } from '../src/services/stock-history-sync-runner.js';

const DEFAULT_CLUSTER_KEY = 'global';
const DEFAULT_CONCURRENCY = 8;
const BEIJING_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const parsePositiveInteger = (raw: string | undefined, fallback: number): number => {
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const parseNonNegativeInteger = (raw: string | undefined, fallback: number): number => {
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const parseSymbolFilter = (raw: string | undefined): readonly string[] => {
  if (!raw) {
    return [];
  }
  return raw.split(',').map(item => item.trim()).filter(item => /^\d{6}$/.test(item));
};

const parseAsOf = (raw: string | undefined): Date => {
  if (!raw) {
    return new Date();
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T12:00:00.000+08:00`)
    : new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`无效日期: ${raw}`);
  }
  return date;
};

const toBeijingTime = (date: Date): string => BEIJING_TIME_FORMATTER.format(date).replace(/\//g, '-');

async function main(): Promise<void> {
  const config = createBackendIntegrationConfig();
  const isIncremental = process.argv.includes('--mode') && process.argv[process.argv.indexOf('--mode') + 1] === 'incremental';

  try {
    const hasStockPool = await hasLocalStockPoolFile();
    if (!hasStockPool) {
      console.log('未发现本地股票池文件，先执行股票池同步。');
      ensureLocalStockPoolFile();
    }

    const options = {
      databaseUrl: process.env.DATABASE_URL ?? config.databaseUrl,
      clusterKey: process.env.CLUSTER_KEY ?? DEFAULT_CLUSTER_KEY,
      limit: parseNonNegativeInteger(process.env.STOCK_HISTORY_LIMIT, 0),
      concurrency: parsePositiveInteger(process.env.STOCK_HISTORY_CONCURRENCY, DEFAULT_CONCURRENCY),
      asOf: parseAsOf(process.env.STOCK_HISTORY_AS_OF),
      symbolFilter: parseSymbolFilter(process.env.STOCK_HISTORY_SYMBOLS),
      incremental: isIncremental,
    };

    console.log(`开始：按股票同步三年日线，北京时间 ${toBeijingTime(new Date())}`);
    console.log(`集团：${options.clusterKey}`);
    console.log('方式：一只股票一次请求，返回最近三年日线后整包入库');

    const summary = await runStockHistorySync(options, message => console.log(message));
    console.log(JSON.stringify(summary, null, 2));

    if (summary.失败 > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('同步失败:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
