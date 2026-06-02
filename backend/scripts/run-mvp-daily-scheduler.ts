import {
  executeTask,
  getMvpScheduleTable,
  getMvpScheduleTask,
  getNextScheduledRunBeijing,
  type IMvpScheduleTask,
  type IMvpScheduledRun,
} from '../src/services/mvp-daily-scheduler.js';

type ParsedArgs =
  | { readonly mode: 'list' }
  | { readonly mode: 'once'; readonly taskId: string }
  | { readonly mode: 'loop' };

const LOOP_RECHECK_MAX_DELAY_MS = 2_147_000_000;

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  if (argv.includes('--list')) {
    return { mode: 'list' };
  }

  const onceIndex = argv.indexOf('--once');
  if (onceIndex !== -1) {
    const taskId = argv[onceIndex + 1];
    if (!taskId || taskId.startsWith('--')) {
      throw new Error('Usage: bun run scripts/run-mvp-daily-scheduler.ts --once <taskId>');
    }

    return { mode: 'once', taskId };
  }

  return { mode: 'loop' };
};

const printJson = (payload: unknown): void => {
  console.log(JSON.stringify(payload, null, 2));
};

const toTaskPayload = (task: IMvpScheduleTask): Record<string, unknown> => {
  return {
    id: task.id,
    description: task.description,
    cadence: task.cadence,
    beijingTime: `${pad2(task.beijingTime.hour)}:${pad2(task.beijingTime.minute)}`,
    weekdays: task.weekdays,
    dataFrequency: task.dataFrequency,
    failureStrategy: task.failureStrategy,
    commandHint: task.commandHint,
  };
};

const buildListPayload = (): Record<string, unknown> => {
  return {
    scheduler: 'mvp-daily-scheduler',
    timezone: 'Asia/Shanghai (UTC+8, fixed Beijing time)',
    externalCalls: true,
    tasks: getMvpScheduleTable().map(toTaskPayload),
  };
};

const buildExecutionPlan = (
  task: IMvpScheduleTask,
  scheduledRun?: IMvpScheduledRun,
): Record<string, unknown> => {
  return {
    scheduler: 'mvp-daily-scheduler',
    task: toTaskPayload(task),
    executionMode: scheduledRun ? 'scheduled-exec' : 'manual-once-exec',
    externalCalls: true,
    scheduledAtUtc: scheduledRun?.scheduledAt.toISOString() ?? new Date().toISOString(),
    scheduledAtBeijing: scheduledRun?.beijingDateTime ?? 'manual-now',
    action: 'execute_command_hint',
    commandHint: task.commandHint,
    failureStrategy: task.failureStrategy,
  };
};

const runOnce = (taskId: string): void => {
  const task = getMvpScheduleTask(taskId);
  if (!task) {
    throw new Error(`Unknown MVP scheduler task id: ${taskId}`);
  }

  printJson(buildExecutionPlan(task));

  const result = executeTask(task);

  printJson({
    event: 'task_completed',
    taskId: task.id,
    exitCode: result.code,
    stdoutLength: result.stdout.length,
    stderrLength: result.stderr.length,
  });

  if (result.code !== 0) {
    throw new Error(`Task ${task.id} failed with exit code ${result.code}: ${result.stderr.slice(0, 500)}`);
  }
};

const sleep = (delayMs: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.min(delayMs, LOOP_RECHECK_MAX_DELAY_MS));
  });
};

const runLoop = async (): Promise<void> => {
  printJson({
    scheduler: 'mvp-daily-scheduler',
    mode: 'loop',
    timezone: 'Asia/Shanghai (UTC+8, fixed Beijing time)',
    externalCalls: true,
    failureStrategy: 'Each task executes commandHint and throws on non-zero exit code; LLM errors are never downgraded.',
  });

  for (;;) {
    const nextRun = getNextScheduledRunBeijing();
    printJson({
      event: 'next_run_scheduled',
      nextTaskId: nextRun.task.id,
      scheduledAtUtc: nextRun.scheduledAt.toISOString(),
      scheduledAtBeijing: nextRun.beijingDateTime,
      delayMs: nextRun.delayMs,
    });

    await sleep(nextRun.delayMs);

    if (Date.now() < nextRun.scheduledAt.getTime()) {
      continue;
    }

    printJson(buildExecutionPlan(nextRun.task, nextRun));

    const result = executeTask(nextRun.task);

    printJson({
      event: 'task_completed',
      taskId: nextRun.task.id,
      exitCode: result.code,
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
    });

    if (result.code !== 0) {
      printJson({
        event: 'task_failed',
        taskId: nextRun.task.id,
        exitCode: result.code,
        errorPreview: result.stderr.slice(0, 500),
        failureStrategy: nextRun.task.failureStrategy,
      });
    }
  }
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === 'list') {
    printJson(buildListPayload());
    return;
  }

  if (args.mode === 'once') {
    runOnce(args.taskId);
    return;
  }

  await runLoop();
};

const pad2 = (value: number): string => {
  return value.toString().padStart(2, '0');
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({
    scheduler: 'mvp-daily-scheduler',
    status: 'failed',
    error: message,
  }, null, 2));
  process.exitCode = 1;
});
