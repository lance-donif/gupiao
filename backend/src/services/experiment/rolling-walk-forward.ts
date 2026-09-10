/**
 * M7 rolling walk-forward schedule: train 120, validation 20, test 20,
 * isolation gap 5 sessions, test window advances by 20 sessions.
 */
export interface M7Window {
  readonly train: readonly Date[];
  readonly validation: readonly Date[];
  readonly test: readonly Date[];
}

export interface RollingOptions {
  readonly trainSessions?: number;
  readonly validationSessions?: number;
  readonly testSessions?: number;
  readonly gapSessions?: number;
}

export const DEFAULT_ROLLING_OPTIONS = {
  trainSessions: 120,
  validationSessions: 20,
  testSessions: 20,
  gapSessions: 5,
};

const uniqueSorted = (dates: readonly Date[]): Date[] =>
  [...new Set(dates.map(date => date.toISOString()))].sort().map(s => new Date(s));

export const generateRollingWindows = (
  tradingDays: readonly Date[],
  options: RollingOptions = {},
): RollingWindow[] => {
  const days = uniqueSorted(tradingDays);
  const o = { ...DEFAULT_ROLLING_OPTIONS, ...options };
  const windows: RollingWindow[] = [];
  let cursor = 0;
  const need = o.trainSessions + o.validationSessions + o.testSessions;
  while (cursor + need <= days.length) {
    const train = days.slice(cursor, cursor + o.trainSessions);
    const afterTrain = cursor + o.trainSessions + o.gapSessions;
    const validation = days.slice(afterTrain, afterTrain + o.validationSessions);
    const afterValidation = afterTrain + o.validationSessions + o.gapSessions;
    const test = days.slice(afterValidation, afterValidation + o.testSessions);
    if (validation.length < o.validationSessions || test.length < o.testSessions) break;
    windows.push({ train, validation, test });
    cursor += o.testSessions;
  }
  return windows;
};

export interface RollingWindow {
  readonly train: readonly Date[];
  readonly validation: readonly Date[];
  readonly test: readonly Date[];
}
