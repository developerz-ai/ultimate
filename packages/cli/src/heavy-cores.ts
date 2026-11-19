// How many cores a local run may take: every one in CI, at most `LOCAL_CORE_CAP` on a shared box, and
// fewer while other sessions' runnable tasks already fill the machine. Oversubscribed cores do not
// finish work sooner; they turn timing-sensitive tests red.

// why: Bun ships no synchronous file read for `/proc/loadavg`.
import { readFileSync } from 'node:fs';
// why: Bun exposes no available-parallelism primitive.
import { availableParallelism } from 'node:os';
import type { HeavyEnv } from './heavy-env';
import { HEAVY_CORES_ENV, isCi } from './heavy-env';

export const LOCAL_CORE_CAP = 4;
/** A busy machine still gets this much, or one run behind a burst never makes progress. */
export const BUSY_CORE_FLOOR = 2;

/** The instantaneous runnable count: `/proc/loadavg`'s `running/total`. The load average lags. */
export function parseRunnable(loadavg: string): number | undefined {
  const match = /^\S+\s+\S+\s+\S+\s+(\d+)\/\d+\s/.exec(loadavg);
  return match === null ? undefined : Number(match[1]);
}

/** Runnable tasks now, this reader excluded; 0 where the kernel does not report them. */
export function runnableTasks(read: () => string = () => readFileSync('/proc/loadavg', 'utf8')) {
  try {
    return Math.max(0, (parseRunnable(read()) ?? 1) - 1);
  } catch {
    return 0;
  }
}

/** `undefined` means no ceiling: a CI runner, whose every core is this run's. */
export function coreCap(
  env: HeavyEnv,
  cores: number = availableParallelism(),
  runnable: number = runnableTasks(),
): number | undefined {
  const raw = Number(env[HEAVY_CORES_ENV]);
  if (Number.isInteger(raw) && raw > 0) return raw;
  if (isCi(env)) return undefined;
  const ceiling = Math.min(LOCAL_CORE_CAP, Math.max(1, cores));
  return Math.min(ceiling, Math.max(BUSY_CORE_FLOOR, cores - runnable));
}

/** Thread caps for the native tools: tsc is Go, biome is rayon. An exported value wins. */
export function nativeToolEnv(env: HeavyEnv, cap: number | undefined): Record<string, string> {
  if (cap === undefined) return {};
  return {
    ...(env['GOMAXPROCS'] === undefined ? { GOMAXPROCS: String(cap) } : {}),
    ...(env['RAYON_NUM_THREADS'] === undefined ? { RAYON_NUM_THREADS: String(cap) } : {}),
  };
}
