// Single responsibility: `WorkerOptions.maxInFlight` — the one count of runs this worker holds
// across EVERY queue, and the room it leaves. Sidekiq's `concurrency`: the per-queue slots bound
// each pool, this bounds the process. Read BEFORE a claim, so a worker at the cap asks the queue
// for nothing and no row is claimed only to be shed.

import { finiteCount } from '@ultimat3/core';
import { recordWorkerCapacity, recordWorkerInFlight } from './metrics';

export interface ProcessCap {
  /** The cap as declared, `undefined` when the worker has none. */
  readonly max: number | undefined;
  /** Room left under the cap: `Infinity` with no cap, never below 0. */
  free(): number;
  /** Runs counted against the cap right now. */
  held(): number;
  /**
   * One run admitted. The answer hands its count back, ONCE however often it is called — the
   * run's `finally` and nothing else, at the same instant its limiter lease goes back, so the
   * `kick` that follows sees the room it made.
   */
  take(): () => void;
}

/** `maxInFlight`, refused when it is not a whole number ≥ 1 — `jobWorker`'s other counts' rule. */
export function createProcessCap(max: number | undefined, slots: number): ProcessCap {
  if (max !== undefined) finiteCount('jobWorker', 'maxInFlight', max, 1);
  let held = 0;
  // What a scaler divides by: the most this process can run, whichever bound is tighter.
  recordWorkerCapacity(max === undefined ? slots : Math.min(max, slots));
  recordWorkerInFlight(0);
  return {
    max,
    free: () => (max === undefined ? Number.POSITIVE_INFINITY : Math.max(0, max - held)),
    held: () => held,
    take() {
      held += 1;
      recordWorkerInFlight(held);
      let returned = false;
      return () => {
        if (returned) return;
        returned = true;
        held -= 1;
        recordWorkerInFlight(held);
      };
    },
  };
}
