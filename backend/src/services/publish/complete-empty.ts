/**
 * M4 COMPLETE_EMPTY 判定与记录
 *
 * 区分两种“无推荐”结果：
 * - 证据为空（evidenceCount === 0）→ 视为流程无法继续，按现状语义**抛错停止**。
 * - 证据存在但候选被质量门槛全部过滤（recommendationsCreated === 0 但 evidenceCount > 0）
 *   → 记录 `COMPLETE_EMPTY` 状态与原因，**不补位、不重复重试、不当作失败抛出**。
 */
import { PrismaClient, Prisma } from '@prisma/client';

export type EmptyDecision = 'stop' | 'complete_empty' | 'ok';

export interface EmptyDecisionInput {
  recommendationsCreated: number;
  evidenceCount: number;
}

export function classifyEmptyResult(input: EmptyDecisionInput): EmptyDecision {
  if (input.recommendationsCreated > 0) {
    return 'ok';
  }
  if (input.evidenceCount > 0) {
    return 'complete_empty';
  }
  return 'stop';
}

/**
 * 记录 COMPLETE_EMPTY 状态到 RunTrace（不抛错、不发布）。
 * 用显式 status='COMPLETE_EMPTY' 记录，errorMessage 写入原因，
 * metrics 写入 completeEmpty 标记，避免新增表/列。
 */
export async function recordCompleteEmpty(
  prisma: PrismaClient,
  traceId: string,
  reason: string,
): Promise<void> {
  const existing = await prisma.runTrace.findUnique({ where: { traceId } });
  await prisma.runTrace.update({
    where: { traceId },
    data: {
      status: 'COMPLETE_EMPTY',
      completedAt: new Date(),
      errorMessage: `COMPLETE_EMPTY: ${reason}`,
      metrics: {
        ...(existing?.metrics && typeof existing.metrics === 'object' ? existing.metrics : {}),
        completeEmpty: true,
        completeEmptyReason: reason,
        completedAt: new Date().toISOString(),
      } as unknown as Prisma.InputJsonValue,
    },
  });
}
