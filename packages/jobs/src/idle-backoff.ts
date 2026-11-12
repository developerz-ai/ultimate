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

/**
 * The longest an idle loop RESTS once a pass has told it when the next row falls due (a claim's
 * `onEmpty`) and the wake is live: until that row is due, never past this. It bounds the two
 * things nothing announces — a notification lost while the session stayed up, a row whose due
 * time moved under a skewed clock. Measured 2026-11: an idle worker at the 5 s ceiling was 87% of
 * a near-idle app's claims; this is the same backstop at a twelfth of the cost.
 */
export const IDLE_REST_MAX_MS = 60_000;

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

/**
 * A rest is armed in slices of the short ceiling, each re-reading `wakeIsLive()`: a session lost
 * mid-rest stops announcing work, and the loop falls back to the poll the ceiling promises rather
 * than sleeping out the minute. A slice costs a timer, never a statement.
 */
export const REST_SLICE_MS = IDLE_POLL_CEILING_MS;

/** After the due time, never on it: the row's due time is the database's clock, not this one. */
export const DUE_MARGIN_MS = 10;

/** The wait a pass ends on, and whether it is a REST — armed in `REST_SLICE_MS` slices. */
export interface RestPlan {
  readonly delayMs: number;
  readonly resting: boolean;
}

/**
 * The wait after a pass, for the worker and the relay alike. `dueInMs` is what the pass's empty
 * claims said of the next due row (`null`: none; `undefined`: not asked or not answered). A pass
 * that found work, or a due time already past — a row a peer holds locked — keeps `backoffMs`.
 * With the wake live the loop RESTS until the due time, at most `IDLE_REST_MAX_MS` (or the
 * declared ceiling, the app's own bound); without it the due time only shortens the poll.
 */
export function restAfter(pass: {
  readonly found: boolean;
  readonly dueInMs: number | null | undefined;
  readonly backoffMs: number;
  readonly floorMs: number;
  readonly declaredCeilingMs?: number | undefined;
}): RestPlan {
  const { dueInMs, backoffMs, floorMs } = pass;
  const keep = { delayMs: backoffMs, resting: false };
  if (pass.found || dueInMs === undefined || (dueInMs !== null && dueInMs <= 0)) return keep;
  const due = dueInMs === null ? Number.POSITIVE_INFINITY : dueInMs + DUE_MARGIN_MS;
  if (!wakeIsLive())
    return { delayMs: Math.max(floorMs, Math.min(backoffMs, due)), resting: false };
  const delayMs = Math.max(floorMs, Math.min(due, pass.declaredCeilingMs ?? IDLE_REST_MAX_MS));
  return { delayMs, resting: pass.declaredCeilingMs === undefined && delayMs > REST_SLICE_MS };
}
