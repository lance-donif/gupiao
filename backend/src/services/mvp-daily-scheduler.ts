import { spawnSync } from 'node:child_process';

export type MvpScheduleCadence = 'daily' | 'weekly' | 'monthly';

export interface IMvpBeijingTime {
  readonly hour: number;
  readonly minute: number;
}

export interface IMvpScheduleTask {
  readonly id: string;
  readonly description: string;
  readonly cadence: MvpScheduleCadence;
  readonly beijingTime: IMvpBeijingTime;
  readonly weekdays?: readonly number[];
  readonly monthDays?: readonly number[];
  readonly dataFrequency: string;
  readonly failureStrategy: string;
  readonly commandHint: string;
}

export interface IMvpScheduledRun {
  readonly task: IMvpScheduleTask;
  readonly scheduledAt: Date;
  readonly beijingDateTime: string;
  readonly delayMs: number;
}

interface IBeijingDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly weekday: number;
}

const BEIJING_UTC_OFFSET_HOURS = 8;
const MS_PER_HOUR = 60 * 60 * 1000;
const MVP_SCHEDULE_TABLE: readonly IMvpScheduleTask[] = [
  {
    id: 'stock_list_check',
    description: 'Verify the local stock universe before market workflows start.',
    cadence: 'daily',
    beijingTime: { hour: 7, minute: 30 },
    dataFrequency: 'daily before A-share market open',
    failureStrategy: 'fail fast and block downstream market-data tasks until the stock list is checked',
    commandHint: 'bun dist/scripts/sync-stocks.js --mode check',
  },
  {
    id: 'daily_candle_incremental',
    description: 'Prepare the latest daily candle increment after market close.',
    cadence: 'daily',
    beijingTime: { hour: 16, minute: 10 },
    dataFrequency: 'daily trading-day OHLCV increment',
    failureStrategy: 'fail fast; do not publish snapshots when candle data is stale',
    commandHint: 'bun dist/scripts/sync-stock-history.js --mode incremental',
  },
  {
    id: 'news_fetch',
    description: 'Fetch the day news corpus for later normalization.',
    cadence: 'daily',
    beijingTime: { hour: 16, minute: 30 },
    dataFrequency: 'daily news batch',
    failureStrategy: 'fail fast and preserve the previous successful corpus; no silent fallback news source',
    commandHint: 'bun dist/scripts/fetch-newsnow.js --date today',
  },
  {
    id: 'normalize_dedupe_llm',
    description: 'Normalize and deduplicate the fetched news with LLM-assisted extraction.',
    cadence: 'daily',
    beijingTime: { hour: 16, minute: 40 },
    dataFrequency: 'daily news normalization batch',
    failureStrategy: 'throw on any LLM error; no rule-based downgrade or fallback extraction',
    commandHint: 'bun dist/scripts/run-daily-recommendation.js --stop-after dedup',
  },
  {
    id: 'graph_score_recommend',
    description: 'Build graph signals, score contributions, and produce recommendations.',
    cadence: 'daily',
    beijingTime: { hour: 16, minute: 50 },
    dataFrequency: 'daily recommendation scoring batch',
    failureStrategy: 'fail fast; keep partial traces for debugging and skip publish_snapshot',
    commandHint: 'bun dist/scripts/run-daily-recommendation.js',
  },
  {
    id: 'publish_snapshot',
    description: 'Publish the recommendation snapshot after scoring succeeds.',
    cadence: 'daily',
    beijingTime: { hour: 17, minute: 0 },
    dataFrequency: 'daily immutable recommendation snapshot',
    failureStrategy: 'fail fast and leave the last published snapshot untouched',
    commandHint: 'bun dist/scripts/run-daily-recommendation.js --publish-only',
  },
  {
    id: 'forecast_replay',
    description: '盘中基于已存档预测+最新Candle重排推荐（不重新抓新闻/LLM）',
    cadence: 'daily',
    beijingTime: { hour: 14, minute: 30 },
    dataFrequency: 'intraday forecast replay',
    failureStrategy: 'fail fast; leave morning snapshot untouched',
    commandHint: 'bun dist/scripts/run-daily-recommendation.js --from-forecast true',
  },
  {
    id: 'tickflow_industry_exposure_refresh',
    description: 'Refresh monthly tick-flow industry exposure facts.',
    cadence: 'monthly',
    monthDays: [1],
    beijingTime: { hour: 3, minute: 30 },
    dataFrequency: 'monthly first-day industry exposure refresh',
    failureStrategy: 'fail fast; retain the previous exposure table and require manual retry',
    commandHint: 'bun dist/scripts/sync-tickflow-stock-exposure.js',
  },
  {
    id: 'history_gap_repair',
    description: 'Repair historical market-data gaps after the morning stock-pool check window.',
    cadence: 'daily',
    beijingTime: { hour: 8, minute: 30 },
    dataFrequency: 'daily morning historical data gap scan',
    failureStrategy: 'fail fast for the current repair batch; retry on the next scheduler cycle',
    commandHint: 'bun dist/scripts/sync-stock-history.js --mode repair-gaps',
  },
  {
    id: 'reconcile_recommendations',
    description: 'Reconcile historical recommendations with actual returns and update keyword penalties.',
    cadence: 'daily',
    beijingTime: { hour: 16, minute: 45 },
    dataFrequency: 'daily after candle sync batch',
    failureStrategy: 'fail gracefully; log errors but do not block downstream scoring tasks',
    commandHint: 'bun dist/scripts/reconcile-historical-recommendations.js',
  },
];

export const getMvpScheduleTable = (): readonly IMvpScheduleTask[] => {
  return MVP_SCHEDULE_TABLE;
};

const filterScheduleTasks = (taskIds: readonly string[] | undefined): readonly IMvpScheduleTask[] => {
  if (!taskIds || taskIds.length === 0) {
    return MVP_SCHEDULE_TABLE;
  }

  const requested = new Set(taskIds);
  const tasks = MVP_SCHEDULE_TABLE.filter(task => requested.has(task.id));

  if (tasks.length !== requested.size) {
    const knownTaskIds = new Set(MVP_SCHEDULE_TABLE.map(task => task.id));
    const unknown = [...requested].filter(taskId => !knownTaskIds.has(taskId));
    throw new Error(`Unknown MVP scheduler task id: ${unknown.join(', ')}`);
  }

  return tasks;
};

const getBeijingDateParts = (date: Date): IBeijingDateParts => {
  const beijingDate = new Date(date.getTime() + BEIJING_UTC_OFFSET_HOURS * MS_PER_HOUR);

  return {
    year: beijingDate.getUTCFullYear(),
    month: beijingDate.getUTCMonth() + 1,
    day: beijingDate.getUTCDate(),
    weekday: beijingDate.getUTCDay(),
  };
};

const addBeijingDays = (parts: IBeijingDateParts, days: number): IBeijingDateParts => {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
};

const isTaskScheduledOnBeijingDate = (task: IMvpScheduleTask, dateParts: IBeijingDateParts): boolean => {
  if (task.cadence === 'daily') {
    return true;
  }

  if (task.cadence === 'weekly') {
    return (task.weekdays ?? []).includes(dateParts.weekday);
  }

  return (task.monthDays ?? []).includes(dateParts.day);
};

const beijingWallTimeToUtcDate = (dateParts: IBeijingDateParts, time: IMvpBeijingTime): Date => {
  return new Date(Date.UTC(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day,
    time.hour - BEIJING_UTC_OFFSET_HOURS,
    time.minute,
    0,
    0,
  ));
};

const pad2 = (value: number): string => {
  return value.toString().padStart(2, '0');
};

const formatBeijingDateTime = (date: Date): string => {
  const parts = getBeijingDateParts(date);
  const beijingDate = new Date(date.getTime() + BEIJING_UTC_OFFSET_HOURS * MS_PER_HOUR);

  return [
    `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`,
    `${pad2(beijingDate.getUTCHours())}:${pad2(beijingDate.getUTCMinutes())}`,
  ].join(' ');
};

const getNextRunForTask = (now: Date, task: IMvpScheduleTask): Date => {
  const today = getBeijingDateParts(now);

  for (let offsetDays = 0; offsetDays <= 62; offsetDays += 1) {
    const candidateDay = addBeijingDays(today, offsetDays);
    if (!isTaskScheduledOnBeijingDate(task, candidateDay)) {
      continue;
    }

    const candidate = beijingWallTimeToUtcDate(candidateDay, task.beijingTime);
    if (candidate.getTime() > now.getTime()) {
      return candidate;
    }
  }

  throw new Error(`Unable to find next run for MVP scheduler task: ${task.id}`);
};

export const getNextScheduledRunBeijing = (
  now: Date = new Date(),
  taskIds?: readonly string[],
): IMvpScheduledRun => {
  const candidates = filterScheduleTasks(taskIds).map((task) => {
    const scheduledAt = getNextRunForTask(now, task);

    return {
      task,
      scheduledAt,
      beijingDateTime: formatBeijingDateTime(scheduledAt),
      delayMs: Math.max(0, scheduledAt.getTime() - now.getTime()),
    } satisfies IMvpScheduledRun;
  });

  const nextRun = [...candidates].sort((left, right) => left.scheduledAt.getTime() - right.scheduledAt.getTime())[0];
  if (!nextRun) {
    throw new Error('MVP scheduler has no tasks to schedule');
  }

  return nextRun;
};

const formatBeijingDayKey = (date: Date): string => {
  const parts = getBeijingDateParts(date);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
};

const sleepWithSignal = (delayMs: number, signal: AbortSignal | undefined): Promise<void> => {
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

export const runSchedulerLoop = async (options?: {
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}): Promise<void> => {
  const signal = options?.signal;
  const nowFn = options?.now ?? (() => new Date());
  const completedToday = new Set<string>();
  let lastDayKey = formatBeijingDayKey(nowFn());

  // ponytail: 内存 Set 防当日重跑；进程重启会清空（可接受，最多重跑一次）。
  // ponytail: 不处理"同一时刻多任务"——当前调度表无时间冲突，若未来出现需改用任务级游标。
  while (!signal?.aborted) {
    const next = getNextScheduledRunBeijing(nowFn());
    await sleepWithSignal(next.delayMs, signal);
    if (signal?.aborted) {
      break;
    }

    const currentDayKey = formatBeijingDayKey(nowFn());
    if (currentDayKey !== lastDayKey) {
      completedToday.clear();
      lastDayKey = currentDayKey;
    }

    const runKey = `${next.task.id}:${currentDayKey}`;
    if (completedToday.has(runKey)) {
      continue;
    }

    const startedAt = Date.now();
    const result = spawnSync(next.task.commandHint, {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: true,
    });
    const elapsedMs = Date.now() - startedAt;
    const exitCode = result.status ?? -1;
    if (exitCode === 0) {
      completedToday.add(runKey);
    }
    console.log(
      `[scheduler] task=${next.task.id} beijing=${next.beijingDateTime} exit=${exitCode} elapsedMs=${elapsedMs}`,
    );
    if (result.error) {
      console.error(`[scheduler] ${next.task.id} spawn error: ${result.error.message}`);
    }
  }
};

