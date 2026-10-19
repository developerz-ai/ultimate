// How much slower this machine runs the gate than the one its declared numbers were measured on.
// Every deadline the gate declares — a step's (`verify-deadline.ts`), Bun's 5 s per test, a test's
// own — was set against a 4-core CI runner, and on a 2-core 1.8 GHz box the same honest work runs
// five to seven times longer: the gate failed there on the deadlines, never on the code. Measured
// once per gate, before any step runs, and applied to every one of those numbers.

import { TEST_PACE_ENV } from '@ultimat3/testing';
import { availableCpus } from './test-workers';

/**
 * The width the declared deadlines were measured at: a GitHub-hosted `ubuntu-latest` runner on a
 * public repository has 4 cores, and the `unit` deadline's "~3 minutes" is on one.
 */
export const REFERENCE_CPUS = 4;

/**
 * What `probeWork` takes on that runner, the median of `PROBE_RUNS`: the SLOWEST of the five gate
 * parts' readings, so the runner's own spread reads as pace 1 and its deadlines stay the declared
 * ones. MEASURED on GitHub's `ubuntu-latest`, `As of 2026-10-19`: 31, 32, 32, 34, 35 ms (`ci` run
 * 39208102081, each part's `data.pace.probeMs`). An idle 3.1 GHz Haswell core reads 65-90 ms.
 */
export const REFERENCE_PROBE_MS = 35;

/** Rows the probe allocates, round-trips through JSON and sorts: ~25 ms a run on the reference. */
export const PROBE_ROWS = 30_000;

/** Timed runs after one untimed warm-up, so the JIT is not what gets measured. */
export const PROBE_RUNS = 5;

/** The machine's pace, and the two readings it was computed from — `--json` carries all three. */
export type MachinePace = {
  /** Every declared deadline is multiplied by this. Never below 1: a fast machine keeps the number. */
  readonly factor: number;
  readonly cpus: number;
  /** The probe's median, in milliseconds. */
  readonly probeMs: number;
};

/** Pace 1: the numbers as declared. What a caller that measured nothing runs at. */
export const DECLARED_PACE: MachinePace = {
  factor: 1,
  cpus: REFERENCE_CPUS,
  probeMs: REFERENCE_PROBE_MS,
};

/**
 * Fewer cores than the reference is a proportionally longer parallel step, and a slower core is a
 * proportionally longer everything: the two multiply. Each is held at 1 from below, so a wide or
 * fast machine is never handed a TIGHTER deadline than the one declared. Two decimals: the number
 * is printed, and `ULTIMATE_TEST_PACE` carries it to every test run.
 */
export function paceOf(cpus: number, probeMs: number): MachinePace {
  const width = Math.max(1, REFERENCE_CPUS / Math.max(1, cpus));
  const speed = Math.max(1, probeMs / REFERENCE_PROBE_MS);
  return { factor: Math.round(width * speed * 100) / 100, cpus, probeMs };
}

/** A declared deadline at this pace. */
export const pacedMs = (ms: number, pace: MachinePace): number => Math.round(ms * pace.factor);

/**
 * Fixed single-threaded work of the kind the gate does — allocate, serialize, parse, sort, scan
 * strings — so a slower core, and a core shared with whatever else the box runs, both read slower.
 * The result is folded into the return value so the work cannot be optimized away.
 */
export function probeWork(): number {
  const rows = Array.from({ length: PROBE_ROWS }, (_, i) => ({
    id: `row-${String((i * 7919) % PROBE_ROWS)}`,
    n: i,
    tags: [i % 3, i % 5],
  }));
  const back = JSON.parse(JSON.stringify(rows)) as typeof rows;
  back.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return back
    .map((row) => row.id)
    .join('\n')
    .split('\n')
    .filter((line) => line.endsWith('7')).length;
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/** The probe's median over `PROBE_RUNS`, in whole milliseconds. */
export function probeMs(work: () => number = probeWork): number {
  work();
  const runs = Array.from({ length: PROBE_RUNS }, () => {
    const started = performance.now();
    work();
    return performance.now() - started;
  });
  return Math.round(median(runs));
}

/** This machine, now: what an entry point (`x verify`, `x build`, the MCP host) hands the gate. */
export const measurePace = (): MachinePace => paceOf(availableCpus(), probeMs());

/** Bun's own per-test default: what every test and hook without a number of its own runs under. */
export const BUN_TEST_TIMEOUT_MS = 5_000;

/**
 * `--timeout` for a test run at this pace, so a test with no number of its own — and every
 * `beforeEach` booting an embedded Postgres — gets Bun's 5 s stretched like everything else. None
 * at pace 1 or unmeasured: Bun's default already is the number, and the argv stays the one a
 * developer types.
 */
export const defaultTimeoutArgs = (pace: MachinePace | undefined): readonly string[] =>
  pace === undefined || pace.factor === 1
    ? []
    : [`--timeout=${String(pacedMs(BUN_TEST_TIMEOUT_MS, pace))}`];

/**
 * What a test run started at this pace is told, so its own declared deadlines stretch with it
 * (`@ultimat3/testing`'s `paced`). Set at 1 too, whenever a pace was measured: a gate nested in a
 * test must not inherit the outer run's pace as its own. Nothing when none was measured.
 */
export const paceEnv = (pace: MachinePace | undefined): Readonly<Record<string, string>> =>
  pace === undefined ? {} : { [TEST_PACE_ENV]: String(pace.factor) };
