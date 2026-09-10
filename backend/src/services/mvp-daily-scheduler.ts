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
/**
 * 每天只在晚间 20:00（北京时间）跑一次：日线增量 → 历史收益对账 → 推荐主链路。
 *
 * 顺序不可调换：
 *  - 日线增量先行，否则推荐链路的 candle 预检会因数据陈旧直接停止；
 *  - 收益对账在推荐之前，让关键词惩罚读到已成熟的 5 日收益；
 *  - 推荐主链路自身包含新闻抓取、LLM 因果抽取、图谱/评分与发布。
 *
 * 任一步失败即中断当日链路（`&&` 串联），保留上一份已发布快照，绝不降级或折中。
 */
const MVP_SCHEDULE_TABLE: readonly IMvpScheduleTask[] = [
  {
    id: 'daily_recommendation',
    description: '每晚 20:00 一次性执行：日线增量 → 历史收益对账 → 新闻/LLM 抽取 → 图谱评分 → 发布推荐。',
    cadence: 'daily',
    beijingTime: { hour: 20, minute: 0 },
    dataFrequency: 'daily after market close',
    failureStrategy: 'fail fast; 任一步失败即停止当日链路并保留上一份已发布快照，不降级、不折中',
    commandHint: 'bun dist/scripts/sync-stock-history.js --mode incremental && bun dist/scripts/backfill-yield-records.js && bun dist/scripts/run-daily-recommendation.js',
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
  console.log(`[scheduler] started tasks=${MVP_SCHEDULE_TABLE.length} now=${formatBeijingDateTime(nowFn())} (Asia/Shanghai)`);

  // ponytail: 内存 Set 防当日重跑；进程重启会清空（可接受，最多重跑一次）。
  // ponytail: 不处理"同一时刻多任务"——当前调度表无时间冲突，若未来出现需改用任务级游标。
  while (!signal?.aborted) {
    const next = getNextScheduledRunBeijing(nowFn());
    console.log(`[scheduler] next task=${next.task.id} beijing=${next.beijingDateTime} delayMs=${next.delayMs}`);
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

