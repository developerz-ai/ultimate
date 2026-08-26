// Internal: every scheduling decision in this package is made in epoch ms against an
// injected Clock, so tests never sleep and a frozen clock cannot be bypassed.

import type { Clock } from '@ultimat3/core';
import { finiteOption, systemClock } from '@ultimat3/core';
import { parseDuration } from '@ultimat3/time';

export type DurationInput = string | number;

/** A Clock may hand back a `Date` or epoch ms; scheduling needs one comparable number. */
export function nowMs(clock: Clock = systemClock): number {
  const reading: unknown = clock.now();
  if (reading instanceof Date) return reading.getTime();
  return Number(reading);
}

/**
 * `'3d'` | `'30s'` | `1500` -> ms, refused under the name the CALLER wrote.
 *
 * NOT a copy of `@ultimat3/time`'s `toMs`, and the name says which one this is — three functions
 * spelled `toMs`, `toMs` and `toDurationMs` are exactly the trap a rule spelled by NAME falls into.
 * The STRING arm delegates to `parseDuration`, the one duration vocabulary, which refuses
 * everything it cannot read (an overflowing amount included). What this adds is the NUMBER arm and
 * the two names on it.
 *
 * The number arm passed straight through, and this is the conversion every scheduling decision in
 * this package goes through: `step.sleep(Number(process.env.DELAY))` on an unset variable made
 * `wakeAt = at + NaN`, and every `wakeAt <= now` against a `NaN` is false forever — a sleep that
 * never ends, a retry ceiling that is not one, an event that never expires, with no error
 * anywhere. `??` does not guard it, because `NaN` is not nullish.
 *
 * `finiteOption`, not `finiteCount`, and the floor is measured rather than assumed:
 * `backoffDelayMs({ ...policy, maxDelay: -5 }, 1) === 0` is pinned by `retry-core-parity.test.ts`
 * and `retry: { delay: 0 }` is what four of this package's own `.job.test.ts` suites configure, so
 * a negative and a zero duration are shipped behaviour here. Only a non-finite one is refused. A
 * caller needing a positive whole number narrows ON TOP — `job()` does exactly that for
 * `stepTimeout` and `eventPoll`.
 *
 * `subject` and `option` are REQUIRED, and that is the enforcement rather than a convention: a new
 * call site that does not name the key the app author actually wrote is `TS2554: Expected 3
 * arguments` at the call. `@ultimat3/time`'s screen names the subject `toMs`, a framework internal
 * that tells an app author nothing about which knob of theirs is wrong — the shape
 * `@ultimat3/notify`'s `toDurationMs` already has. The callee carrying `Finite` is load-bearing
 * too: `bun run finite-bounds` reads a repair off the callee's NAME, so every
 * `finiteDurationMs(x.y ?? DEFAULT, …)` site is recognised as screened without a second wrapper.
 */
export function finiteDurationMs(duration: DurationInput, subject: string, option: string): number {
  if (typeof duration === 'number') return finiteOption(subject, option, duration);
  return parseDuration(duration);
}
