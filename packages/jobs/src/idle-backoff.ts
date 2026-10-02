// How long a polling loop waits before its next pass: the floor while there is work, doubling to
// a declared ceiling while there is none. The worker and the outbox relay both polled at a fixed
// interval — 250 ms and 200 ms — so a queue with nothing in it cost a statement every pass, for
// ever: 9 to 13 queries a second from an idle pod. One definition, so both loops back off alike.

import { backoffDelay, finiteOption } from '@ultimat3/core';
import { wakeIsLive } from './enqueue-signal';

/**
 * The longest an idle loop waits between passes when nothing else can wake it — and so the worst
 * case added to the pickup of a job ANOTHER process committed. It is the guarantee: a wake is an
 * optimisation that a pooling proxy, a lost session or a missed notification takes away.
 */
export const IDLE_POLL_CEILING_MS = 2_000;

/**
 * The ceiling once a cross-process wake is PROVEN (`wakeIsLive()`): work committed anywhere
 * announces itself, so the poll is only the backstop — for a notification lost with a session,
 * and for a row that becomes due by the clock rather than by a commit.
 */
export const WOKEN_IDLE_POLL_CEILING_MS = 5_000;

/** The first step when the floor is 0 (a loop that re-arms at once while there is work). */
const MIN_STEP_MS = 25;

export interface IdleBackoff {
  /** The delay before the next pass, given whether the last one found work. */
  next(foundWork: boolean): number;
  /** Work arrived from outside a pass: the next delay is the floor again. */
  reset(): void;
  /** True once a pass has come back empty — the loop is idling. */
  idle(): boolean;
}

export function createIdleBackoff(options: {
  readonly subject: string;
  readonly floorMs: number;
  readonly ceilingMs?: number;
}): IdleBackoff {
  const floor = finiteOption(options.subject, 'pollIntervalMs', options.floorMs);
  const declared =
    options.ceilingMs === undefined
      ? undefined
      : finiteOption(options.subject, 'idlePollMaxMs', options.ceilingMs);
  // Read per pass, never once: the wake is proven after the loop starts and can be lost again.
  const ceiling = (): number =>
    Math.max(floor, declared ?? (wakeIsLive() ? WOKEN_IDLE_POLL_CEILING_MS : IDLE_POLL_CEILING_MS));
  /** Empty passes in a row. */
  let empty = 0;
  return {
    next(foundWork) {
      if (foundWork) {
        empty = 0;
        return floor;
      }
      empty += 1;
      // floor, 2x, 4x, … — the FIRST empty pass waits the floor, so one quiet poll costs nothing.
      // The doubling is core's curve, never a second one: no jitter, because every loop here polls
      // its own queue and a herd of idle workers is the cheap case.
      if (empty === 1) return floor;
      return backoffDelay({
        attempt: empty,
        base: Math.max(floor, MIN_STEP_MS),
        max: ceiling(),
        curve: 'exponential',
        jitter: 'none',
      });
    },
    reset() {
      empty = 0;
    },
    idle: () => empty > 0,
  };
}
