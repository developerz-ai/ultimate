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
  /** The worker serves again (`start()`): counted in the process gauges. */
  revive(): void;
  /** The worker stopped: out of the process gauges, its capacity with it. */
  retire(): void;
}

interface Counted {
  held: number;
  readonly capacity: number;
}

/**
 * Every worker this PROCESS has live. The two gauges are unlabelled, one series per process, so
 * they carry the SUM: a second `jobWorker` in one process used to reset the first's in-flight to 0
 * and overwrite its capacity, and each later update published one worker's count as the whole.
 */
const live = new Set<Counted>();

const publish = (): void => {
  let held = 0;
  let capacity = 0;
  for (const worker of live) {
    held += worker.held;
    capacity += worker.capacity;
  }
  recordWorkerInFlight(held);
  recordWorkerCapacity(capacity);
};

/** `maxInFlight`, refused when it is not a whole number ≥ 1 — `jobWorker`'s other counts' rule. */
export function createProcessCap(max: number | undefined, slots: number): ProcessCap {
  if (max !== undefined) finiteCount('jobWorker', 'maxInFlight', max, 1);
  // What a scaler divides by: the most this worker can run, whichever bound is tighter.
  const counted: Counted = { held: 0, capacity: max === undefined ? slots : Math.min(max, slots) };
  live.add(counted);
  publish();
  return {
    max,
    free: () => (max === undefined ? Number.POSITIVE_INFINITY : Math.max(0, max - counted.held)),
    held: () => counted.held,
    take() {
      counted.held += 1;
      publish();
      let returned = false;
      return () => {
        if (returned) return;
        returned = true;
        counted.held -= 1;
        publish();
      };
    },
    revive() {
      if (live.has(counted)) return;
      live.add(counted);
      publish();
    },
    retire() {
      if (!live.delete(counted)) return;
      publish();
    },
  };
}
