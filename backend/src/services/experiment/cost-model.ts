/**
 * Cost / slippage model for M7 evaluation. Default 10 bps per side.
 */
export interface CostModelOptions {
  readonly basisPointsPerSide?: number;
}

export const DEFAULT_BPS_PER_SIDE = 10;

export const applyRoundTripCost = (
  grossReturn: number,
  options: CostModelOptions = {},
): { readonly net: number; readonly costBps: number } => {
  const bps = options.basisPointsPerSide ?? DEFAULT_BPS_PER_SIDE;
  const cost = bps * 2 / 10000;
  return { net: grossReturn - cost, costBps: bps * 2 };
};

export const simulateRotatingCapital = (
  weights: readonly number[],
  grossReturns: readonly number[],
  options: CostModelOptions = {},
): { readonly netReturns: number[]; readonly finalEquity: number } => {
  const bps = options.basisPointsPerSide ?? DEFAULT_BPS_PER_SIDE;
  const cost = bps * 2 / 10000;
  const netReturns = grossReturns.map((g, i) => (weights[i] ?? 1) * (g - cost));
  const finalEquity = netReturns.reduce((eq, r) => eq * (1 + r), 1);
  return { netReturns, finalEquity };
};
