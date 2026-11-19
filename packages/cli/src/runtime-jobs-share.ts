// A supervised worker child's part of the container's job slots. `jobs.concurrency` and
// `jobs.maxInFlight` are per-CONTAINER totals, split across `ULTIMATE_CHILD`'s N children with
// core's `childShare`; a total below N is served only by children with index < total, so a
// `concurrency: 1` queue stays strictly serial across the container.

import type { JobsConcurrency, SupervisedChild } from '@ultimat3/core';
import { childShare, JOBS_CONCURRENCY_DEFAULT } from '@ultimat3/core';

/**
 * One total's share for this child. `childShare` never answers below 1 (a pool must hand every
 * child a connection), which for slots would turn 1 into N: a child the total has no slot left for
 * gets 0, and a queue at 0 free slots is never asked for a row (`worker-admit.ts`'s `claimAsks`).
 */
export function childSlots(total: number, child: SupervisedChild): number {
  return child.index < total ? childShare(total, child.index, child.count) : 0;
}

/** A queue's container total, by OWN key — `worker-options.ts`'s `slotTable` rule. */
const totalFor = (declared: JobsConcurrency | undefined, queue: string): number => {
  if (typeof declared === 'number') return declared;
  if (declared === undefined || !Object.hasOwn(declared, queue)) return JOBS_CONCURRENCY_DEFAULT;
  return declared[queue] ?? JOBS_CONCURRENCY_DEFAULT;
};

export interface ChildWorkerShare {
  /** Every served queue named, so no queue falls back to an unsplit default inside `jobWorker`. */
  readonly concurrency: Readonly<Record<string, number>>;
  /** Absent when the container has no cap, or when this child is past it and claims nothing. */
  readonly maxInFlight?: number;
}

/**
 * This child's slot table and cap. A child past `maxInFlight` keeps its queues (its registry row
 * still says what the container serves) at 0 slots each: `jobWorker` refuses a cap below 1.
 */
export function childWorkerShare(input: {
  readonly queues: readonly string[];
  readonly concurrency: JobsConcurrency | undefined;
  readonly maxInFlight: number | undefined;
  readonly child: SupervisedChild;
}): ChildWorkerShare {
  const cap =
    input.maxInFlight === undefined ? undefined : childSlots(input.maxInFlight, input.child);
  const idle = cap === 0;
  const concurrency = Object.fromEntries(
    input.queues.map((queue) => [
      queue,
      idle ? 0 : childSlots(totalFor(input.concurrency, queue), input.child),
    ]),
  );
  return cap === undefined || idle ? { concurrency } : { concurrency, maxInFlight: cap };
}
