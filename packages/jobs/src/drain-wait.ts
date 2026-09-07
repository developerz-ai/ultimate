// The wait a role's teardown makes, under the drain's own budget — the worker's in-flight jobs,
// the scheduler's dispatch round. One shape for both, because the race closes over nothing either
// of them holds: the same seam `lifecycle-deadline.ts` takes in core, and for the same reason —
// an unbounded wait inside a shutdown hook is a process the kubelet ends with SIGKILL.

import { systemClock } from '@ultimat3/core';

/**
 * The deadline a teardown waits under, and it is bound LATE. `undefined` while the stop is manual;
 * a real monotonic instant (the clock `ShutdownReason.deadlineAt` is measured on) the moment a
 * shutdown lands — before the teardown starts, or in the middle of it. A wait already in progress
 * adopts it, which is the case a plain number could not express: `worker.stop('deploy')` starts a
 * teardown with no budget, SIGTERM arrives, core's `close` hook JOINS the memoised teardown — and
 * the number that teardown was started with is the number it kept. Core abandoned the hook at the
 * deadline and moved on; the worker sat on a body that ignores `ctx.signal` with its driver open
 * and `stopping` never settling, exactly the wedge the bound was written to end.
 *
 * The EARLIEST deadline wins: a second bind can only tighten, never extend, because the budget it
 * comes from is one process-wide grace period and not a per-caller allowance.
 */
export interface DrainBudget {
  /** The deadline in force — `undefined` until a shutdown binds one. */
  readonly deadlineAt: number | undefined;
  /** Bind a deadline, or tighten the one held. Every wait in progress hears it at once. */
  bind(deadlineAt: number): void;
  /**
   * Hear the deadline: now, when one is already bound, and again each time it tightens. Answers
   * the unsubscribe, which a settled wait calls so a budget outlives none of its waiters.
   */
  watch(listener: (deadlineAt: number) => void): () => void;
}

export function createDrainBudget(deadlineAt?: number): DrainBudget {
  let bound = deadlineAt;
  const listeners = new Set<(deadlineAt: number) => void>();
  return {
    get deadlineAt() {
      return bound;
    },
    bind(at) {
      if (bound !== undefined && at >= bound) return;
      bound = at;
      for (const listener of listeners) listener(at);
    },
    watch(listener) {
      listeners.add(listener);
      if (bound !== undefined) listener(bound);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Everything in `pending`, settled — or abandoned once the deadline (real monotonic ms) has
 * passed. Answers `true` when everything settled.
 *
 * The deadline is a number for a role whose teardown cannot be joined mid-flight, and a
 * `DrainBudget` for one that can — the worker, whose manual `stop()` a later SIGTERM joins.
 * `undefined` is a MANUAL `stop()`, which waits as long as its work takes: a caller that asked a
 * role to stop has no budget to spend, and closing the queue under a live job — or handing the
 * lease back under a live dispatch — is exactly what draining exists to prevent. The bound belongs
 * to the SIGTERM path, where the budget is real and a handler that ignores `ctx.signal` would
 * otherwise hold the teardown — and with it the memoized `stopping` promise every later `stop()`
 * joins — open forever.
 *
 * `allSettled`, so work that rejected is work that finished: each caller observes its own failures
 * already, and a teardown that rethrew here would skip the close behind it.
 */
export async function settleAllBy(
  pending: readonly Promise<unknown>[],
  deadline: DrainBudget | number | undefined,
): Promise<boolean> {
  if (pending.length === 0) return true;
  const settled = Promise.allSettled(pending);
  const budget = typeof deadline === 'object' ? deadline : createDrainBudget(deadline);
  return await new Promise<boolean>((resolve) => {
    let decided = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const decide = (drained: boolean): void => {
      if (decided) return;
      decided = true;
      unwatch();
      if (timer !== undefined) clearTimeout(timer);
      resolve(drained);
    };
    // Re-armed on every tightening, so a wait that began with no deadline ends at the one a later
    // shutdown bound. Never the thing keeping a drained process alive — the rule
    // `lifecycle-deadline.ts` states for its own timer. A spent budget still gives the
    // already-settled case its turn, because a resolved promise settles on a microtask and this
    // timer on a macrotask.
    const unwatch = budget.watch((deadlineAt) => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => decide(false), Math.max(0, deadlineAt - systemClock.monotonic()));
      timer.unref?.();
    });
    void settled.then(() => decide(true));
  });
}
