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
   * Whether the claimed run already did work (`didWork`) — a resume after `step.sleep` or
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
  claimed: { readonly steps?: readonly { readonly status: string }[] | undefined },
  ttlMs: number,
  renewIntervalMs: number,
  worker: { readonly schedule?: IntervalScheduler | undefined },
): LimiterRunFrame {
  return {
    ttlMs,
    renewIntervalMs,
    schedule: worker.schedule,
    reentered: claimed.steps === undefined ? undefined : didWork(claimed.steps),
  };
}

/**
 * The statuses that prove the run got past its start: a step that completed, or one the run is
 * suspended on. Never `failed` (a step that threw — an HTTP 500 retried is a fresh start, or
 * every retry would skip the rate), `started` (a `once` step's outcome is unknown) or `cleared`.
 */
const WORK_DONE: ReadonlySet<string> = new Set(['completed', 'sleeping', 'waiting']);

/** Whether any of a run's step records proves it already did work — the one re-entry rule. */
export function didWork(steps: readonly { readonly status: string }[]): boolean {
  return steps.some((step) => WORK_DONE.has(step.status));
}

/** The frame of the run in progress, or `undefined` outside a worker (a test calling a body). */
export function limiterFrame(): LimiterRunFrame | undefined {
  return frame.get();
}
