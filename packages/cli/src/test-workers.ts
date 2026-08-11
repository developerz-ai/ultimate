// How wide a parallel test run goes, decided in one place. `x test --workers`, `x verify
// --workers` and every parallel step of the gate read this — a second default would split the same
// suite two different ways, and the `--worker N` reproduction a shard failure prints would then
// name a shard the gate never ran.

// Bun ships no CPU-count primitive; `cpus()` is the fallback when navigator cannot answer.
import { cpus } from 'node:os';

/** navigator first: it is the runtime's own answer, and it respects a container's CPU limit. */
export function availableCpus(): number {
  const hinted = typeof navigator === 'undefined' ? Number.NaN : navigator.hardwareConcurrency;
  return Math.max(1, Number.isFinite(hinted) && hinted > 0 ? Math.trunc(hinted) : cpus().length);
}

/**
 * One core of headroom, and a ceiling.
 *
 * The headroom is for the parent: it is holding every shard's captured stdout while they run, and
 * a suite that saturates every core makes the gate's own reporting the slowest thing in it.
 *
 * The ceiling is memory, not cores. A worker is a whole Bun process with the framework's module
 * graph loaded and — in the typed suites — its own cloned Postgres or an in-process PGlite, so
 * width costs hundreds of MB per step. Free `ubuntu-latest` runners are the target this repo
 * commits to (2 or 4 vCPU, 16 GB), where the clamp never binds; it binds on a developer's 12- or
 * 32-core machine, which is exactly where an unbounded count would swap.
 */
export const WORKER_CEILING = 8;

export const defaultWorkers = (available: number = availableCpus()): number =>
  Math.max(1, Math.min(WORKER_CEILING, available - 1));
