/**
 * LLM 请求体硬限制（AGENTS.md 核心规则）。
 *
 * 常量曾以字面量 `240000` 散落在 4 个服务里，各自还能被下���"对齐"注释追平。
 * 这里是唯一事实源，任何服务都从这里取，不要再写裸数字。
 */

/** 最终 LLM 请求体（prompt + 序列化 body）的硬字符上限。 */
export const AI_MAX_REQUEST_CHARS = 240000;

/**
 * 判断 prompt 与序列化 body 是否都在上限内。
 *
 * 返回布尔而非直接抛错：部分调用点（如关键词生成）在超限时需要先做批次二分，
 * 只有二分到单个标的仍超限才应抛错。
 */
export function isAiRequestWithinLimit(
  promptChars: number,
  bodyChars: number,
  maxRequestChars: number = AI_MAX_REQUEST_CHARS,
): boolean {
  return promptChars <= maxRequestChars && bodyChars <= maxRequestChars;
}