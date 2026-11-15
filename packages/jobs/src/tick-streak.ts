// A polling loop's failures as ONE streak per cause (core's `failureStreak`), named the one way the
// scheduler, the worker and the outbox relay share: `jobs.<loop>.tick-failed` / `-recovered`. A
// database restart fails every tick until it ends: one line opens the streak, one closes it.

import { failureStreak, type LogFields } from '@ultimat3/core';

export type TickLoop = 'scheduler' | 'worker' | 'outbox';

/** The streak as a claim loop's hooks (`ClaimLoopOptions`), each safe to pass detached. */
export interface TickStreak {
  /** A tick failed: logged when it opens a streak or changes its cause, counted otherwise. */
  readonly onError: (error: unknown) => void;
  /** A tick passed: closes an open streak with one line counting it. */
  readonly onPassed: () => void;
  /** The loop (re)started: a stopped run's open streak is not this run's. */
  readonly onStart: () => void;
}

export function tickStreak(loop: TickLoop, fields?: LogFields): TickStreak {
  const streak = failureStreak({
    event: `jobs.${loop}.tick-failed`,
    recoveredEvent: `jobs.${loop}.tick-recovered`,
    ...(fields === undefined ? {} : { fields }),
  });
  return {
    onError: (error) => {
      streak.failed(error);
    },
    onPassed: () => streak.passed(),
    onStart: () => streak.reset(),
  };
}
