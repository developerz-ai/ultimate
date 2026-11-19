// When a draining worker stops waiting for the jobs it holds. SIGTERM stops the CLAIMING; the jobs
// already running keep going, because a deploy that cancels work in flight re-runs every side
// effect it interrupted. Only near the end of the drain budget is what is still running told to
// stop (`cancel`), and a beat later what is still held goes back to the queue (`handBack`).

import type { ShutdownReason } from '@ultimat3/core';
import { logger, renderThrowable, systemClock } from '@ultimat3/core';
import type { DrainBudget } from './drain-wait';
import { JobDrainedError } from './errors';
import type { HeldRuns } from './worker-held';

/**
 * The most of the budget's tail kept for unwinding: the cancel lands this far before the deadline,
 * the hand-back half as far, and the teardown — the registry row, the driver — gets the rest. Two
 * seconds of a 25 s default, and never more than HALF of a small budget, so a budget of 300 ms
 * still spends 150 ms letting its jobs finish before anything is cut.
 */
export const DRAIN_CANCEL_MARGIN_MS = 2_000;

export interface CutoffTimes {
  /** Real monotonic ms: the held runs' `ctx.signal` aborts with `X_DRAINING`. */
  readonly cancelAt: number;
  /** Real monotonic ms: every claim still held is handed back uncounted. */
  readonly handBackAt: number;
}

/**
 * The cut-off for a deadline, read against the instant it was bound. Measured back from
 * `inflightUntil` — core's `ShutdownReason.inflightUntil`, the instant its in-flight wait ends —
 * and not from `deadlineAt`: a cancel at the very instant that wait gives up loses the race to a
 * nack that takes one round trip, and the drain exits `X_SHUTDOWN_TIMEOUT` for a job it handed back.
 */
export function cutoffTimes(
  deadlineAt: number,
  now: number,
  inflightUntil: number = deadlineAt,
): CutoffTimes {
  const end = Math.min(deadlineAt, inflightUntil);
  const remaining = Math.max(0, end - now);
  const margin = Math.min(DRAIN_CANCEL_MARGIN_MS, remaining / 2);
  return { cancelAt: end - margin, handBackAt: end - margin / 2 };
}

export interface DrainCutoff {
  /** Stop listening to the budget and clear both timers — the teardown is over. */
  dispose(): void;
}

/**
 * Arm `cancel` and `handBack` on `budget`, re-armed each time it tightens (the earliest deadline
 * wins — `drain-wait.ts`). Each fires at most once. The timers are `unref`ed: a drained process is
 * never kept alive by its own cut-off.
 */
export function armDrainCutoff(
  budget: DrainBudget,
  steps: { readonly cancel: () => void; readonly handBack: () => Promise<void> },
  /** How far before the deadline the drain's in-flight wait ends: `deadlineAt − inflightUntil`. */
  reserveMs = 0,
): DrainCutoff {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let cancelled = false;
  let handedBack = false;
  const clear = (): void => {
    for (const timer of timers.splice(0)) clearTimeout(timer);
  };
  const at = (instant: number, fire: () => void): void => {
    // Real time, not `liveClock`: this races a real `setTimeout`, and a frozen clock under it never fires.
    const timer = setTimeout(fire, Math.max(0, instant - systemClock.monotonic()));
    timer.unref?.();
    timers.push(timer);
  };
  const unwatch = budget.watch((deadlineAt) => {
    clear();
    const times = cutoffTimes(deadlineAt, systemClock.monotonic(), deadlineAt - reserveMs);
    if (!cancelled) {
      at(times.cancelAt, () => {
        cancelled = true;
        steps.cancel();
      });
    }
    if (!handedBack) {
      at(times.handBackAt, () => {
        handedBack = true;
        // Each nack's failure is logged where it happens (`worker-hand-back.ts`); this is the one
        // place anything else could still escape a timer, so it is observed here.
        void steps.handBack().catch((error: unknown) => {
          logger.error('jobs.worker.drain-hand-back-failed', { error: renderThrowable(error) });
        });
      });
    }
  });
  return {
    dispose() {
      unwatch();
      clear();
    },
  };
}

/**
 * The worker's cut-off: `drain` aborted with `X_DRAINING` at `cancelAt`, every run `held` still
 * holds handed back at `handBackAt`. Aborted even with nothing held: a round still inside its
 * `claim()` starts its runs under this controller, and they must hear the cut-off too.
 */
export function armWorkerCutoff(input: {
  readonly budget: DrainBudget;
  readonly workerId: string;
  /** The shutdown that armed it: its signal name rides the reason the bodies read, and core's
   *  `inflightUntil` is where the cut-off measures back from (`cutoffTimes`). */
  readonly shutdown: ShutdownReason;
  readonly drain: AbortController;
  readonly held: HeldRuns;
}): DrainCutoff {
  const { workerId, held, shutdown } = input;
  const reserveMs = Math.max(
    0,
    shutdown.deadlineAt - (shutdown.inflightUntil ?? shutdown.deadlineAt),
  );
  return armDrainCutoff(
    input.budget,
    {
      cancel: () => {
        if (held.size > 0)
          logger.warn('jobs.worker.drain-cancelling', { workerId, held: held.size });
        input.drain.abort(new JobDrainedError({ workerId, signal: shutdown.signal }));
      },
      handBack: async () => {
        const handed = await held.handBackAll();
        if (handed > 0) logger.warn('jobs.worker.drain-handed-back', { workerId, handed });
      },
    },
    reserveMs,
  );
}
