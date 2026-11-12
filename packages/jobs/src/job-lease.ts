// `args.lease`: a job body's handle on the lease its worker renews. The renewal is automatic, but a
// timer cannot fire inside a long synchronous section, and an external hand-off has no way to say
// "still alive" — so the body gets the same three facts `LeaseHeartbeat` keeps, and nothing more.

import type { LeaseHeartbeat } from './heartbeat';
import type { AnyJobHandle, JobRunArgs } from './job-types';

export interface JobLease {
  /**
   * Renew now, and answer whether this attempt still holds the row. Call it between the chunks of
   * a section that outlasts the visibility timeout. With a renewal already on the wire it sends no
   * second one and answers `true` (the window has not lapsed) — never a body hung on a dead
   * connection. `false` is final: the row was cancelled or re-claimed, `signal` has aborted, and
   * every `step.run` past it is refused. A lease meant to outlive ONE job is not this: that is
   * `withLock()`.
   */
  renew(): Promise<boolean>;
  /** True once the lease is gone: the queue may already have delivered this job again. */
  lost(): boolean;
  /** Aborts when the lease is gone — the lease's own source of `ctx.signal`. */
  readonly signal: AbortSignal;
}

/** The body's view of a running heartbeat. Never `stop()`: the worker owns the heartbeat's end. */
export function jobLease(heartbeat: Pick<LeaseHeartbeat, 'renew' | 'lost' | 'signal'>): JobLease {
  return {
    async renew() {
      await heartbeat.renew();
      return !heartbeat.lost();
    },
    lost: () => heartbeat.lost(),
    signal: heartbeat.signal,
  };
}

/**
 * `handle` whose `run` is handed `lease` — how the worker reaches the body's arguments without a
 * second field on `executeJob`, which `@ultimat3/testing`'s fixture also calls with no heartbeat.
 * `name` is copied by value: `registerJob` rebinds it in place, and this view is per run.
 */
export function withLease(handle: AnyJobHandle, lease: JobLease): AnyJobHandle {
  return {
    ...handle,
    name: handle.name,
    run: (args: JobRunArgs<unknown>) => handle.run({ ...args, lease }),
  };
}
