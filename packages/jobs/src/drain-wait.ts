// The wait a role's teardown makes, under the drain's own budget — the worker's in-flight jobs,
// the scheduler's dispatch round. One shape for both, because the race closes over nothing either
// of them holds: the same seam `lifecycle-deadline.ts` takes in core, and for the same reason —
// an unbounded wait inside a shutdown hook is a process the kubelet ends with SIGKILL.

import { systemClock } from '@ultimat3/core';

/**
 * Everything in `pending`, settled — or abandoned once `deadlineAt` (real monotonic ms, the clock
 * `ShutdownReason.deadlineAt` is measured on) has passed. Answers `true` when everything settled.
 *
 * `deadlineAt` is `undefined` for a MANUAL `stop()`, which waits as long as its work takes: a
 * caller that asked a role to stop has no budget to spend, and closing the queue under a live job
 * — or handing the lease back under a live dispatch — is exactly what draining exists to prevent. The bound belongs to the SIGTERM path, where the
 * budget is real and a handler that ignores `ctx.signal` would otherwise hold the teardown — and
 * with it the memoized `stopping` promise every later `stop()` joins — open forever.
 *
 * `allSettled`, so work that rejected is work that finished: each caller observes its own failures
 * already, and a teardown that rethrew here would skip the close behind it.
 */
export async function settleAllBy(
  pending: readonly Promise<unknown>[],
  deadlineAt: number | undefined,
): Promise<boolean> {
  if (pending.length === 0) return true;
  const settled = Promise.allSettled(pending);
  if (deadlineAt === undefined) {
    await settled;
    return true;
  }
  const remainingMs = Math.max(0, deadlineAt - systemClock.monotonic());
  return await new Promise<boolean>((resolve) => {
    let decided = false;
    const timer = setTimeout(() => {
      if (decided) return;
      decided = true;
      resolve(false);
    }, remainingMs);
    // Never the thing keeping a drained process alive — the rule `lifecycle-deadline.ts` states
    // for its own timer. A spent budget still gives the already-settled case its turn, because a
    // resolved promise settles on a microtask and this timer on a macrotask.
    timer.unref?.();
    void settled.then(() => {
      if (decided) return;
      decided = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}
