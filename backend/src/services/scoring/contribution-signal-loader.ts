/**
 * EvidenceContribution 信号加载（单一真源）。
 *
 * 原实现曾在 temp-stock-recommendation-service.ts 与 strategy-runner.ts
 * 中重复；现在统一为独立纯函数，行为保持一致：
 * 按 traceId + symbols 读取证据贡献，按 keyword 聚合 finalContribScore，
 * 输出按分数降序、keyword 升序的信号列表。
 */

import { toNumber } from '../../lib/number-utils.js';

export type IContributionSignal = { readonly keyword: string; readonly score: number };

type IPrismaLike = {
  evidenceContribution?: {
    findMany?: (args: unknown) => Promise<unknown>;
  };
};

export const loadContributionSignalMap = async (
  prisma: IPrismaLike,
  traceId: string,
  symbols: readonly string[],
): Promise<Map<string, readonly IContributionSignal[]>> => {
  const signalsBySymbol = new Map<string, readonly IContributionSignal[]>();
  if (!prisma.evidenceContribution?.findMany || symbols.length === 0) {
    return signalsBySymbol;
  }

  const rows = (await prisma.evidenceContribution.findMany({
    where: {
      traceId,
      symbol: { in: [...symbols] },
    },
  })) as any[];

  const keywordScoreBySymbol = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const symbol = String(row.symbol);
    const keyword = String(row.matchedExposureKeyword ?? row.keyword);
    const current = keywordScoreBySymbol.get(symbol) ?? new Map<string, number>();
    current.set(keyword, (current.get(keyword) ?? 0) + toNumber(row.finalContribScore));
    keywordScoreBySymbol.set(symbol, current);
  }

  for (const [symbol, keywordScores] of keywordScoreBySymbol.entries()) {
    const signals = [...keywordScores.entries()]
      .map(([keyword, score]) => ({ keyword, score }))
      .sort((left, right) => right.score - left.score || left.keyword.localeCompare(right.keyword));
    signalsBySymbol.set(symbol, signals);
  }

  return signalsBySymbol;
};
