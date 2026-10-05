// When a draining worker stops waiting for the jobs it holds. SIGTERM stops the CLAIMING; the jobs
// already running keep going, because a deploy that cancels work in flight re-runs every side
// effect it interrupted. Only near the end of the drain budget is what is still running told to
// stop (`cancel`), and a beat later what is still held goes back to the queue (`handBack`).

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

/** The cut-off for a deadline, read against the instant it was bound. */
export function cutoffTimes(deadlineAt: number, now: number): CutoffTimes {
  const remaining = Math.max(0, deadlineAt - now);
  const margin = Math.min(DRAIN_CANCEL_MARGIN_MS, remaining / 2);
  return { cancelAt: deadlineAt - margin, handBackAt: deadlineAt - margin / 2 };
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
): DrainCutoff {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let cancelled = false;
  let handedBack = false;
  const clear = (): void => {
    for (const timer of timers.splice(0)) clearTimeout(timer);
  };
  const at = (instant: number, fire: () => void): void => {
    const timer = setTimeout(fire, Math.max(0, instant - systemClock.monotonic()));
    timer.unref?.();
    timers.push(timer);
  };
  const unwatch = budget.watch((deadlineAt) => {
    clear();
    const times = cutoffTimes(deadlineAt, systemClock.monotonic());
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
  /** The shutdown's signal name, carried on the reason the bodies read. */
  readonly signal: string;
  readonly drain: AbortController;
  readonly held: HeldRuns;
}): DrainCutoff {
  const { workerId, held } = input;
  return armDrainCutoff(input.budget, {
    cancel: () => {
      if (held.size > 0) logger.warn('jobs.worker.drain-cancelling', { workerId, held: held.size });
      input.drain.abort(new JobDrainedError({ workerId, signal: input.signal }));
    },
    handBack: async () => {
      const handed = await held.handBackAll();
      if (handed > 0) logger.warn('jobs.worker.drain-handed-back', { workerId, handed });
    },
  });
}
