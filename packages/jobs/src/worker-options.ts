// Every numeric knob `createWorker` accepts, read and REFUSED in one place — the slot table
// included, because a queue name is data and a slot count is a bound, and both arrive from the
// same deployment config.
//
// WHY A REFUSAL AND NOT A CLAMP. `Number(process.env.JOB_VISIBILITY_MS)` on an unset variable is
// `NaN`; `??` guards only nullish, and `Math.max`/`Math.min`/`Math.floor` PROPAGATE it. So the
// value arrives at a lease deadline, a claim limit and a timer interval intact, and every
// comparison against it reads FALSE — measured on `createMemoryDriver`: `visibleAt = at + NaN`,
// the reclaim scan asks `visibleAt <= at`, and a job whose worker died is never claimable again.
// At-least-once becomes never, with no error and a row `x jobs ls` still prints as `running`.
// `slice(0, NaN)` is `[]`, so a `concurrency: NaN` worker claims nothing and reports healthy.
// Same shape as `createLimiter`'s `maxTenants` and `backfill()`'s `batch`, refused the same way.

import { finiteOption } from '@ultimat3/core';
import { DEFAULT_VISIBILITY_TIMEOUT_MS } from './driver';

/** Slots a queue gets when `concurrency` names no number for it. */
const DEFAULT_SLOTS = 5;

/** The subset of `WorkerOptions` this module reads. Structural, so `WorkerOptions` satisfies it. */
export interface WorkerNumericOptions {
  readonly concurrency?: number | Readonly<Record<string, number>> | undefined;
  readonly visibilityTimeoutMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly heartbeatIntervalMs?: number | undefined;
}

export interface WorkerTimings {
  readonly visibilityTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly heartbeatIntervalMs: number;
  /** Slots for one queue, by OWN key — see `slotsFor` below. */
  readonly slotsFor: (queue: string) => number;
}

/**
 * Slots for one queue. A queue NAME is deployment data, so the table is read by OWN keys:
 * `concurrency['constructor']` answers `Object.prototype.constructor`, and
 * `Math.max(0, <function> - inFlight)` is `NaN`, which the `free === 0` guard does not catch.
 * `bun run proto-index` cannot see this one — the table is a parameter, not a literal in a file.
 */
const slotTable =
  (declared: number | Readonly<Record<string, number>> | undefined) =>
  (queue: string): number => {
    if (typeof declared === 'number') return declared;
    if (declared === undefined || !Object.hasOwn(declared, queue)) return DEFAULT_SLOTS;
    return declared[queue] ?? DEFAULT_SLOTS;
  };

export function resolveWorkerTimings(options: WorkerNumericOptions): WorkerTimings {
  const visibilityTimeoutMs = options.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS;
  finiteOption('createWorker', 'visibilityTimeoutMs', visibilityTimeoutMs);
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  // `setTimeout(fn, NaN)` coerces the delay to 0, so the claim loop stops being a poll and becomes
  // a spin: one round trip to Postgres per event-loop turn, from every worker replica.
  finiteOption('createWorker', 'pollIntervalMs', pollIntervalMs);
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.floor(visibilityTimeoutMs / 3);
  finiteOption('createWorker', 'heartbeatIntervalMs', heartbeatIntervalMs);
  const declared = options.concurrency;
  if (typeof declared === 'number') finiteOption('createWorker', 'concurrency', declared);
  else if (declared !== undefined) {
    // Per queue, by own key: an inherited member is not this table's to answer with either.
    for (const queue of Object.keys(declared)) {
      finiteOption('createWorker', `concurrency.${queue}`, declared[queue] ?? DEFAULT_SLOTS);
    }
  }
  return {
    visibilityTimeoutMs,
    pollIntervalMs,
    heartbeatIntervalMs,
    slotsFor: slotTable(declared),
  };
}
