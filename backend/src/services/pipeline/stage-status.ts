/**
 * 流水线阶段状态机：阶段生命周期状态、合法迁移边与校验函数。
 *
 * `SUCCESS` 与 `FAILED` 为终态，不可再迁移。
 */

/** 阶段生命周期状态。 */
export type StageStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'WAITING'
  | 'SUCCESS'
  | 'PAUSED'
  | 'NEEDS_ATTENTION'
  | 'FAILED';

/** 全部阶段状态（稳定顺序）。 */
export const STAGE_STATUSES: readonly StageStatus[] = [
  'PENDING',
  'RUNNING',
  'WAITING',
  'SUCCESS',
  'PAUSED',
  'NEEDS_ATTENTION',
  'FAILED',
];

/** 合法状态迁移边；终态无出边。 */
export const STAGE_STATUS_TRANSITIONS: Readonly<Record<StageStatus, readonly StageStatus[]>> = {
  PENDING: ['RUNNING', 'PAUSED', 'FAILED'],
  RUNNING: ['SUCCESS', 'WAITING', 'PAUSED', 'NEEDS_ATTENTION', 'FAILED', 'PENDING'],
  WAITING: ['RUNNING', 'PAUSED', 'NEEDS_ATTENTION', 'FAILED'],
  SUCCESS: [],
  PAUSED: ['PENDING', 'FAILED'],
  NEEDS_ATTENTION: ['PENDING', 'FAILED'],
  FAILED: [],
};

/** 终态：进入后不可再迁移。 */
export const TERMINAL_STAGE_STATUSES: readonly StageStatus[] = ['SUCCESS', 'FAILED'];

/** 判断 `from -> to` 是否为合法迁移。 */
export function isValidStageTransition(from: StageStatus, to: StageStatus): boolean {
  return STAGE_STATUS_TRANSITIONS[from].includes(to);
}

/** 运行时校验字符串是否为合法 `StageStatus`。 */
export function isStageStatus(value: string): value is StageStatus {
  return (STAGE_STATUSES as readonly string[]).includes(value);
}

/** 非法迁移时抛错，错误信息包含两个状态名。 */
export function assertStageTransition(from: StageStatus, to: StageStatus): void {
  if (!isValidStageTransition(from, to)) {
    throw new Error(`非法的阶段状态迁移：${from} -> ${to}`);
  }
}
