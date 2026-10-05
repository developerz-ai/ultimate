// Single responsibility: the drain budget's default and its domain — `drain.deadlineMs` in
// `app.config.ts`. One module because the config validator, the lifecycle's own default and the
// chart's grace period must all mean the same number.

import { countIssue } from './config-count';
import { readinessGraceIssue } from './lifecycle-grace';

/**
 * How long a SIGTERM'd process has to finish what it holds — in-flight requests, a running job's
 * step — before the lifecycle abandons the rest. 25 s sits inside a 30 s kubelet grace with the
 * teardown margin beside it; an app whose jobs run longer raises it, and the chart's
 * `terminationGracePeriodSeconds` is derived from the raised number.
 */
export const DRAIN_DEADLINE_DEFAULT_MS = 25_000;

/**
 * An hour. Past it a deploy is not draining, it is waiting on work that should checkpoint: a step
 * is the replay unit, so a job longer than this belongs in more steps, not a longer drain.
 */
export const DRAIN_DEADLINE_MAX_MS = 3_600_000;

const DEADLINE_KEY = 'drain.deadlineMs';

/**
 * Why a value is not a drain budget, or `undefined` when it is one. A whole number of milliseconds
 * in `1 ≤ v ≤ 3600000`. Zero is refused here although `configureLifecycle` accepts it: "drain now"
 * is a test's or a tool's decision, never one a deployed app makes by typing it into its config.
 */
export function drainDeadlineIssue(value: unknown): string | undefined {
  const count = countIssue(DEADLINE_KEY, value, 1);
  if (count !== undefined) return count;
  return (value as number) > DRAIN_DEADLINE_MAX_MS
    ? `${DEADLINE_KEY} must be at most ${DRAIN_DEADLINE_MAX_MS} milliseconds — a longer drain is work that should checkpoint in steps, not a deploy waiting on it`
    : undefined;
}

/** The `drain` section's issues, one per key, for `defineConfig`'s validator. */
export function drainIssues(drain: {
  readonly readinessGraceMs: unknown;
  readonly deadlineMs: unknown;
}): readonly (string | undefined)[] {
  return [readinessGraceIssue(drain.readinessGraceMs), drainDeadlineIssue(drain.deadlineMs)];
}
