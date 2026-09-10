/**
 * M7 evaluation report CLI.
 *
 * Usage:
 *   bun scripts/run-m7-report.ts --input data/reports/m7-input.json --basis-points 10
 *
 * Input JSON shape:
 * { tradingDays: string[]; returns: number[]; baselineReturns?: number[] }
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateRollingWindows } from '../src/services/experiment/rolling-walk-forward.js';
import { blockBootstrap } from '../src/services/experiment/bootstrap.js';
import { applyRoundTripCost } from '../src/services/experiment/cost-model.js';

interface M7Input {
  readonly tradingDays?: readonly string[];
  readonly returns?: readonly number[];
  readonly baselineReturns?: readonly number[];
}

const parseArgs = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i += 1) {
    const token = process.argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = process.argv[i + 1];
    out[key] = next && !next.startsWith('--') ? process.argv[++i] : 'true';
  }
  return out;
};

const maxDrawdown = (returns: readonly number[]): number => {
  let equity = 1;
  let peak = 1;
  let worst = 0;
  for (const r of returns) {
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    worst = Math.min(worst, equity / peak - 1);
  }
  return worst;
};

const netOfCost = (returns: readonly number[] | undefined, bps: number): number[] =>
  (returns ?? []).map(r => applyRoundTripCost(Number(r), { basisPointsPerSide: bps }).net);

const main = async (): Promise<void> => {
  const args = parseArgs();
  const inputPath = args.input ?? args['input-file'];
  if (!inputPath) throw new Error('--input <path> is required.');
  const raw = JSON.parse(readFileSync(inputPath, 'utf8')) as M7Input;
  const days = (raw.tradingDays ?? []).map(d => new Date(d));
  const bps = Number(args['basis-points'] ?? 10);
  const netReturns = netOfCost(raw.returns, bps);
  const baselineNet = netOfCost(raw.baselineReturns, bps);
  const windows = generateRollingWindows(days);
  const bootstrap = blockBootstrap(netReturns, { seed: args.seed ? Number(args.seed) : 20260910 });
  const sorted = netReturns.slice().sort((a, b) => a - b);
  const report = {
    generatedAt: new Date().toISOString(),
    overrideForced: true,
    windows: windows.length,
    bootstrap,
    maxDrawdown: maxDrawdown(netReturns),
    worst5Percentile: sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(0.05 * (sorted.length - 1))))] ?? 0,
    baselineMaxDrawdown: baselineNet.length ? maxDrawdown(baselineNet) : null,
    costBasisPointsPerSide: bps,
    input: inputPath,
  };
  const outDir = path.resolve('data/reports');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `m7-report-${Date.now()}.json`);
  writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`report: ${outFile}`);
};

await main();
