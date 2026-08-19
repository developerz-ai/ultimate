// A renewal loop that is TERMINAL once stopped, and the one shape two files renew against.
// `heartbeat.ts` renews a job's lease and `worker-fleet-slots.ts` a fleet slot, and both decided a
// LOSS from an answer that arrived after the run had already finished cleanly: `stop()` cleared
// the interval, which does nothing to the request already on the wire. So a flag is what every
// branch after an `await` re-reads — the shape `settleWithin`'s `decided` uses in core.

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
    void renew();
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
