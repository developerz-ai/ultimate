// Single responsibility: the two ambient things an evaluation needs that the declaration cannot
// carry — what "now" is, and how often the same overdue flag may report.
//
// The reporter itself is NOT here. `@ultimat3/core`'s `ErrorReporter` is the framework's one
// error-monitoring seam; a second one in this package would be a second place an app has to wire
// its monitor, and two places to look when a report does not arrive. What this package adds is the
// rate limit, which core deliberately has no opinion about: `reportError` is called once per
// caught failure, while a flag is evaluated on every request.

import type { Clock, UltimateError } from '@ultimat3/core';
import { reportError, systemClock } from '@ultimat3/core';

/**
 * One hour. Small enough that an overdue flag shows up the same day, large enough that a flag read
 * on every request does not become the loudest thing in the monitor — which is how a report that
 * fires per call ends up muted, and the debt invisible again.
 */
export const DEFAULT_REPORT_INTERVAL_MS = 60 * 60 * 1000;

export interface FlagsRuntimeOptions {
  readonly clock?: Clock | undefined;
  /** Minimum gap between two reports of the SAME flag key. */
  readonly reportEveryMs?: number | undefined;
}

let clock: Clock = systemClock;
let reportEveryMs = DEFAULT_REPORT_INTERVAL_MS;
const lastReportedAt = new Map<string, number>();

/**
 * Swapping the clock CLEARS the watermarks, because a monotonic reading is only meaningful against
 * the clock that produced it. A process that reported at monotonic 10_000_000 and then took a
 * clock starting at 0 computed `now - previous` as -10_000_000 — below every interval, so that key
 * could never report again until the new clock passed the old one's reading, which on a frozen
 * test clock is never. `resetFlagReporting()` always did this; `configureFlags` is what apps and
 * test kits actually call.
 *
 * Only the clock. An interval change re-reads the SAME clock, so clearing there would let a report
 * through on every configure call and turn the rate limit into a suggestion.
 */
export function configureFlags(options: FlagsRuntimeOptions): void {
  if (options.clock !== undefined && options.clock !== clock) {
    clock = options.clock;
    lastReportedAt.clear();
  }
  if (options.reportEveryMs !== undefined) reportEveryMs = options.reportEveryMs;
}

export const flagsClock = (): Clock => clock;

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
  const now = clock.monotonic();
  const previous = lastReportedAt.get(key);
  if (previous !== undefined && now - previous < reportEveryMs) return false;
  lastReportedAt.set(key, now);
  // `reportError` never throws and logs a failing transport itself, so an evaluation cannot fail
  // because the monitor is down.
  reportError(build(), { source: 'process', severity: 'warning', scope: { operation: key } });
  return true;
}

/** Test-only, and the counterpart to every other reset in the framework. */
export function resetFlagReporting(): void {
  clock = systemClock;
  reportEveryMs = DEFAULT_REPORT_INTERVAL_MS;
  lastReportedAt.clear();
}
