// A renewal loop that is TERMINAL once stopped, and the one shape two files renew against.
// `heartbeat.ts` renews a job's lease and `worker-fleet-slots.ts` a fleet slot, and both decided a
// LOSS from an answer that arrived after the run had already finished cleanly: `stop()` cleared
// the interval, which does nothing to the request already on the wire. So a flag is what every
// branch after an `await` re-reads — the shape `settleWithin`'s `decided` uses in core.

import { logger, renderThrowable } from '@ultimat3/core';

export interface RenewalTimer {
  /**
   * True once `stop()` has been called. Read AFTER every await in the renewal body: a clean
   * completion settles the row this renewal is fenced on, so the driver answering "not yours"
   * past that point is a finished job, not a lost lease — and reporting it is an error-level page
   * for a non-event, on exactly the signals that mean the queue re-delivered live work.
   */
  stopped(): boolean;
  /** Stop renewing, for the pass in flight as well as the next one. Idempotent. */
  stop(): void;
}

export function startRenewalTimer(
  intervalMs: number,
  renew: () => void | Promise<void>,
): RenewalTimer {
  let stopped = false;
  const timer = setInterval(() => {
    // `Promise.resolve().then(renew)` and never `void renew()`: a `renew` that throws SYNCHRONOUSLY
    // escapes before any `.catch` its body chained exists. `worker-fleet-slots.ts` guards the
    // promise chain and cannot guard this — `LeaseStore.renew` is an injected seam, and a store
    // that throws on a closed pool throws on the call, not in the chain. Nothing sits above a
    // `setInterval` callback, so that throw is an uncaught exception in the timer that was going
    // to keep the lease alive. The shape `outbox.ts`'s tick loop already uses.
    void Promise.resolve()
      .then(renew)
      .catch((error: unknown) => {
        // A renewal that FAILS is each caller's own business and both handle it. Reaching here
        // means the seam broke its contract, which is a different fact and is worth its own line —
        // swallowed, it would be a lease that stops renewing with nothing anywhere saying so.
        logger.error('jobs.renewal.raised', { error: renderThrowable(error) });
      });
  }, intervalMs);
  return {
    stopped: () => stopped,
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
