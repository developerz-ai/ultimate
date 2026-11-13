// One step's host checks, run side by side and answered in the order they are listed. They ran
// one after another — ten on `errors`, thirty on `manifest` — and most spend their time waiting
// on a file read or a `tsc` child, so the step cost the sum where it can cost the slowest.

import type { HostCheck } from '@ultimat3/cli';
import type { Finding } from './log';

/** `serial` is the reference answer the parallel one is held to (`verify-host-checks.test.ts`). */
export type HostCheckMode = 'serial' | 'parallel';

/**
 * Every check's findings, concatenated in LIST order whichever finished first — so the report a
 * reader sees is the serial one, finding for finding. A throw is the one the serial run would have
 * surfaced: the first rejected check in list order, never whichever lost the race.
 */
export async function runHostChecks(
  checks: readonly HostCheck[],
  root: string,
  mode: HostCheckMode = 'parallel',
): Promise<readonly Finding[]> {
  const out: Finding[] = [];
  if (mode === 'serial') {
    for (const check of checks) out.push(...(await check(root)));
    return out;
  }
  const settled = await Promise.allSettled(checks.map((check) => check(root)));
  for (const result of settled) {
    if (result.status === 'rejected') throw result.reason;
    out.push(...result.value);
  }
  return out;
}

/** A step's checks as the one `HostCheck` `runVerify` takes for it. */
export const allOf =
  (checks: readonly HostCheck[]): HostCheck =>
  (root) =>
    runHostChecks(checks, root);

/**
 * A FIFO pool: at most `width` checks wrapped by one `atMost()` run at once, admitted in the order
 * they were STARTED, which is list order. Each keeps its own place in the list, so its findings
 * land where they always did; the checks around them do not wait. A throw frees its slot.
 */
export function atMost(width: number): (check: HostCheck) => HostCheck {
  let free = Math.max(1, Math.trunc(width));
  const queue: (() => void)[] = [];
  const release = (): void => {
    const next = queue.shift();
    if (next === undefined) free += 1;
    else next();
  };
  return (check) => async (root) => {
    if (free > 0) free -= 1;
    else await new Promise<void>((resolve) => queue.push(resolve));
    try {
      return await check(root);
    } finally {
      release();
    }
  };
}

/**
 * Checks that share something on disk — `readmeFenceFindings` and `wikiFenceFindings` compile in
 * one fixture directory, and each wipes it first — run one after another, in list order.
 */
export const oneAtATime = (): ((check: HostCheck) => HostCheck) => atMost(1);

/**
 * The cores one `tsc` keeps busy. TypeScript 7's compiler is native and threaded: four checkers
 * by default, its parse over every core. Measured 2026-11-13, `tsconfig.tests.json`: 49 CPU-s in
 * 14 s on 4 cores — so two at once on a 4-vCPU CI runner bought no overlap, only a stall for
 * `biome` and this process's one JS thread, which hold the gate's critical path.
 */
export const COMPILER_THREADS = 4;

/**
 * How many `tsc` children the host checks run at once on `cpus` cores: one per four, never none.
 * 4 cores: one, as the serial gate ran them; 12: three, which is every compiler chain the
 * `manifest` step has (test sources, the fence pair, the public API) side by side.
 */
export const compilerWidth = (cpus: number = navigator.hardwareConcurrency): number =>
  Number.isFinite(cpus) && cpus > 0 ? Math.max(1, Math.floor(cpus / COMPILER_THREADS)) : 1;
