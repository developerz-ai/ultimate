// What the worker running a claimed job tells a `limiter()` gate inside its body: the slot's TTL
// and renewal interval (the visibility timeout and the heartbeat's, as `job.concurrency`'s slot
// gets them), the schedule every renewal arms on, and whether the run is a RE-ENTRY. Carried in an
// async frame because the gate sits inside `handle.run`, below `executeJob`'s public arguments.

import { asyncContext } from '@ultimat3/core';
import type { IntervalScheduler } from './renewal-timer';

export interface LimiterRunFrame {
  readonly ttlMs: number;
  readonly renewIntervalMs: number;
  readonly schedule: IntervalScheduler | undefined;
  /**
   * Whether the claimed run already persisted a step — a resume after `step.sleep` or
   * `waitForEvent`, or a retry past a completed step — read off the claim's own step list.
   * `undefined` when the driver handed none: the gate then asks the step store.
   */
  readonly reentered: boolean | undefined;
}

const frame = asyncContext<LimiterRunFrame>('the limiter run frame');

/** Run one claimed job's execution with `value` visible to every limiter gate inside it. */
export function withLimiterFrame<T>(value: LimiterRunFrame, fn: () => T): T {
  return frame.run(value, fn);
}

/**
 * One claimed run's frame: the worker's visibility timeout as the slot TTL, its heartbeat interval
 * as the renewal, its `schedule`, and whether the claim's own step list says the run re-entered.
 */
export function limiterFrameOf(
  claimed: { readonly steps?: readonly unknown[] | undefined },
  ttlMs: number,
  renewIntervalMs: number,
  worker: { readonly schedule?: IntervalScheduler | undefined },
): LimiterRunFrame {
  return {
    ttlMs,
    renewIntervalMs,
    schedule: worker.schedule,
    reentered: claimed.steps === undefined ? undefined : claimed.steps.length > 0,
  };
}

/** The frame of the run in progress, or `undefined` outside a worker (a test calling a body). */
export function limiterFrame(): LimiterRunFrame | undefined {
  return frame.get();
}
