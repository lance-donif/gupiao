import type { IPgStockHistoryPool } from './stock-history-sync-repository.js';
import type {
  IStockHistoryItemResult,
  IStockHistorySyncOptions,
  IStockHistorySyncSummary,
  IStockHistoryTarget,
  IStockHistoryWindow,
} from './stock-history-sync-types.js';
import { PgStockHistoryRepository } from './stock-history-sync-repository.js';
import { determineHistoryTargets, resolveThreeYearWindow, StockHistorySource } from './stock-history-sync-source.js';

interface IPgModule {
  readonly Pool: new (config: { readonly connectionString: string }) => IPgStockHistoryPool;
}

const createPgPool = async (databaseUrl: string): Promise<IPgStockHistoryPool> => {
  const pgModule = await import('pg') as unknown as IPgModule;
  return new pgModule.Pool({ connectionString: databaseUrl });
};

const syncOneStock = async (
  source: StockHistorySource,
  repository: PgStockHistoryRepository,
  target: IStockHistoryTarget,
  window: IStockHistoryWindow,
): Promise<IStockHistoryItemResult> => {
  try {
    const result = await source.fetchCandles(target, window);
    const candles = result.candles;
    if (candles.length === 0) {
      return { symbol: target.symbol, name: target.name, status: '跳过', source: result.provider, candleCount: 0, latestTradeDay: null, message: '三年窗口内无行情' };
    }
    await repository.saveStockHistory(result.target, candles);
    return {
      symbol: target.symbol,
      name: result.target.name,
      status: '完成',
      source: result.provider,
      candleCount: candles.length,
      latestTradeDay: candles[candles.length - 1]!.tradingDay,
      message: `${result.provider} 按股票整包入库`,
    };
  }
  catch (error) {
    return {
      symbol: target.symbol,
      name: target.name,
      status: '失败',
      source: null,
      candleCount: 0,
      latestTradeDay: null,
      message: error instanceof Error ? error.message : '未知错误',
    };
  }
};

const runWithConcurrency = async (
  targets: readonly IStockHistoryTarget[],
  concurrency: number,
  worker: (target: IStockHistoryTarget) => Promise<void>,
): Promise<void> => {
  let index = 0;
  const workers = new Array(Math.min(concurrency, targets.length)).fill(null).map(async () => {
    while (index < targets.length) {
      const target = targets[index++];
      if (target) {
        await worker(target);
      }
    }
  });
  await Promise.all(workers);
};

export const runStockHistorySync = async (
  options: IStockHistorySyncOptions,
  onProgress: (message: string) => void = () => {},
): Promise<IStockHistorySyncSummary> => {
  const window = resolveThreeYearWindow(options.asOf);
  const source = new StockHistorySource();
  const pool = await createPgPool(options.databaseUrl);
  const repository = new PgStockHistoryRepository(pool, options.clusterKey);
  const results: IStockHistoryItemResult[] = [];

  try {
    const universe = await source.fetchUniverse();
    const targets = determineHistoryTargets(universe, options.limit, options.symbolFilter);

    let latestDaysMap = new Map<string, string>();
    if (options.incremental) {
      onProgress('正在从数据库加载个股已有最新交易日，准备进入增量同步模式...');
      latestDaysMap = await repository.getLatestTradeDays();
    }

    // 1. 预处理：在并发循环之外，一瞬间过滤掉所有已经是最新、无需拉取的股票，彻底避免排队阻塞
    const targetsToSync: IStockHistoryTarget[] = [];
    for (const target of targets) {
      if (options.incremental) {
        const latestTradeDay = latestDaysMap.get(target.symbol);
        if (latestTradeDay) {
          const date = new Date(`${latestTradeDay}T12:00:00.000+08:00`);
          date.setDate(date.getDate() + 1);

          // 跳过周末
          while (date.getDay() === 0 || date.getDay() === 6) {
            date.setDate(date.getDate() + 1);
          }

          const yyyy = date.getFullYear();
          const mm = String(date.getMonth() + 1).padStart(2, '0');
          const dd = String(date.getDate()).padStart(2, '0');
          const nextDayStr = `${yyyy}-${mm}-${dd}`;

          const endDayStr = window.endDate;

          if (nextDayStr > endDayStr) {
            results.push({
              symbol: target.symbol,
              name: target.name,
              status: '跳过',
              source: null,
              candleCount: 0,
              latestTradeDay,
              message: `已是最新日期 ${latestTradeDay}，无需拉取`,
            });
            continue;
          }
        }
      }
      targetsToSync.push(target);
    }

    const skippedCount = results.length;
    onProgress(`股票：5206 只，其中跳过 ${skippedCount} 只，真正需要同步 ${targetsToSync.length} 只。`);

    // 2. 仅对真正需要同步的差额股票运行并发请求
    if (targetsToSync.length > 0) {
      let done = 0;
      await runWithConcurrency(targetsToSync, options.concurrency, async (target) => {
        let targetWindow = window;
        if (options.incremental) {
          const latestTradeDay = latestDaysMap.get(target.symbol);
          if (latestTradeDay) {
            const date = new Date(`${latestTradeDay}T12:00:00.000+08:00`);
            date.setDate(date.getDate() + 1);

            // 跳过周末
            while (date.getDay() === 0 || date.getDay() === 6) {
              date.setDate(date.getDate() + 1);
            }

            const yyyy = date.getFullYear();
            const mm = String(date.getMonth() + 1).padStart(2, '0');
            const dd = String(date.getDate()).padStart(2, '0');
            const nextDayStr = `${yyyy}-${mm}-${dd}`;

            targetWindow = {
              startDate: nextDayStr,
              endDate: window.endDate,
            };
          }
        }

        const result = await syncOneStock(source, repository, target, targetWindow);
        results.push(result);
        done++;

        if (done % 5 === 0 || done === targetsToSync.length) {
          const ok = results.filter(item => item.status === '完成').length;
          const failed = results.filter(item => item.status === '失败');
          const lastFailedMsg = failed.length > 0 ? failed[failed.length - 1].message : '';
          onProgress(`[${done}/${targetsToSync.length}] 最新完成: ${target.symbol} ${target.name} | 成功: ${ok}, 失败: ${failed.length} ${lastFailedMsg ? `(最后错误: ${lastFailedMsg})` : ''}`);
        }
      });
    }

    const completed = results.filter(item => item.status === '完成');
    const skipped = results.filter(item => item.status === '跳过');
    const failed = results.filter(item => item.status === '失败');
    const verification = await repository.verify();

    return {
      状态: failed.length === 0 ? '完成' : '有失败',
      范围: window,
      股票数: targets.length,
      完成: completed.length,
      跳过: skipped.length,
      失败: failed.length,
      请求数: targets.length,
      K线数: completed.reduce((sum, item) => sum + item.candleCount, 0),
      最新交易日: completed.map(item => item.latestTradeDay).filter(Boolean).sort().at(-1) ?? null,
      失败样例: failed.slice(0, 20),
      数据库核验: verification,
    };
  }
  finally {
    await pool.end();
  }
};
