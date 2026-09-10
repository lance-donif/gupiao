/**
 * Deterministic block bootstrap helpers with a fixed seed.
 */
export interface BootstrapResult {
  readonly samples: readonly number[];
  readonly lower: number;
  readonly upper: number;
  readonly mean: number;
}

export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const blockBootstrap = (
  dailyReturns: readonly number[],
  options: { iterations?: number; blockLength?: number; seed?: number } = {},
): BootstrapResult => {
  const iterations = options.iterations ?? 2000;
  const blockLength = options.blockLength ?? 10;
  const seed = options.seed ?? 20260910;
  const rand = mulberry32(seed);
  const n = dailyReturns.length;
  const means: number[] = [];
  for (let iter = 0; iter < iterations; iter += 1) {
    let sum = 0;
    let count = 0;
    let cur = Math.floor(rand() * n);
    while (count < n) {
      const take = dailyReturns[cur] ?? 0;
      sum += take;
      count += 1;
      if (count % blockLength === 0) cur = Math.floor(rand() * n);
      else cur = (cur + 1) % n;
    }
    means.push(sum / count);
  }
  means.sort((a, b) => a - b);
  const loIdx = Math.floor(0.05 * (means.length - 1));
  const hiIdx = Math.ceil(0.95 * (means.length - 1));
  return {
    samples: means,
    lower: means[loIdx] ?? 0,
    upper: means[hiIdx] ?? 0,
    mean: means.reduce((a, b) => a + b, 0) / Math.max(1, means.length),
  };
};

