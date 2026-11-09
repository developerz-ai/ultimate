// Single responsibility: how often the same overdue flag may report, and the watermarks that rate
// limit keeps. "Now" is not this package's: it is core's `ambientClock()`, which the boot fills
// from `clock` in `apps/<app>/runtime.ts` and a test from `@ultimat3/testing` (v31).
//
// The reporter itself is NOT here. `@ultimat3/core`'s `ErrorReporter` is the framework's one
// error-monitoring seam; a second one in this package would be a second place an app has to wire
// its monitor, and two places to look when a report does not arrive. What this package adds is the
// rate limit, which core deliberately has no opinion about: `reportError` is called once per
// caught failure, while a flag is evaluated on every request.

import type { Clock, UltimateError } from '@ultimat3/core';
import { ambientClock, finiteCount, recordFailureFact, reportError } from '@ultimat3/core';

/**
 * One hour. Small enough that an overdue flag shows up the same day, large enough that a flag read
 * on every request does not become the loudest thing in the monitor — which is how a report that
 * fires per call ends up muted, and the debt invisible again.
 */
export const DEFAULT_REPORT_INTERVAL_MS = 60 * 60 * 1000;

export interface FlagsRuntimeOptions {
  /** Minimum gap between two reports of the SAME flag key. */
  readonly reportEveryMs?: number | undefined;
}

let reportEveryMs = DEFAULT_REPORT_INTERVAL_MS;
const lastReportedAt = new Map<string, number>();
/** The clock every watermark in `lastReportedAt` was read from. */
let watermarkClock: Clock | undefined;

/**
 * The process clock, and the watermarks forgotten whenever it is a DIFFERENT clock from the one
 * they were read on: a monotonic reading is only meaningful against the clock that produced it. A
 * process that reported at monotonic 10_000_000 and then took a clock starting at 0 computed
 * `now - previous` as -10_000_000 — below every interval, so that key could never report again
 * until the new clock passed the old one's reading, which on a frozen test clock is never.
 *
 * Only on a clock change. An interval change re-reads the SAME clock, so clearing there would let
 * a report through on every configure call and turn the rate limit into a suggestion.
 */
export const flagsClock = (): Clock => {
  const clock = ambientClock();
  if (clock !== watermarkClock) {
    lastReportedAt.clear();
    watermarkClock = clock;
  }
  return clock;
};

/**
 * `reportEveryMs` is screened, and BEFORE anything is touched so a refused call changes nothing.
 * `now - previous < NaN` is false, so a `NaN` interval — `Number(process.env.X)` on an unset
 * variable — removed the rate limit entirely and an overdue flag reported on every evaluation;
 * `Infinity` did the opposite and muted it for good. `0` stays legal: every evaluation reporting
 * is a decision a caller can make on purpose.
 */
export function configureFlags(options: FlagsRuntimeOptions): void {
  const interval =
    options.reportEveryMs === undefined
      ? reportEveryMs
      : finiteCount('configureFlags', 'reportEveryMs', options.reportEveryMs);
  reportEveryMs = interval;
}

/**
 * Report `build()`'s error through core's seam at most once per `reportEveryMs` for this key, and
 * say whether it did. The rate limit is keyed on the MONOTONIC clock: a wall-clock jump — an NTP
 * correction, a container resuming — must not reopen the window and flood the monitor.
 *
 * The error is built lazily, so a rate-limited call costs a map lookup and a subtraction. That
 * matters: this sits on the same path as `can()`.
 *
 * `severity: 'warning'` because the framework recovered — the flag still answered. `source:
 * 'process'` because an overdue flag is a fact about this deploy, not about whichever request
 * happened to evaluate it first.
 */
export function reportOnce(key: string, build: () => UltimateError): boolean {
  const now = flagsClock().monotonic();
  const previous = lastReportedAt.get(key);
  if (previous !== undefined && now - previous < reportEveryMs) return false;
  lastReportedAt.set(key, now);
  // `reportError` never throws and logs a failing transport itself, so an evaluation cannot fail
  // because the monitor is down.
  reportError(build(), { source: 'process', severity: 'warning', scope: { operation: key } });
  return true;
}

/**
 * What an evaluation answered, into the failure buffer when a captured call is in flight — so
 * `x repro` replays the branch the failing request took. Off, one `undefined` check in core.
 */
export function recordEvaluation(key: string, on: boolean): boolean {
  recordFailureFact({ kind: 'flag', key, value: on });
  return on;
}

/** Test-only, and the counterpart to every other reset in the framework. */
export function resetFlagReporting(): void {
  watermarkClock = undefined;
  reportEveryMs = DEFAULT_REPORT_INTERVAL_MS;
  lastReportedAt.clear();
}
