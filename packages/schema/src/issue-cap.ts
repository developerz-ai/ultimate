// Single responsibility: the bound on how many issues one validation collects. A public action's
// body is the attack surface: 10k invalid items cost 289 ms of sync CPU and a 7.2 MiB problem
// document before this, for a list no client renders past `MAX_ISSUES` (`@ultimat3/action`'s
// `wire-issues.ts` refuses a longer one on arrival).

import type { StandardIssue } from './standard';

/**
 * The default cap, and the bound the typed client's `issuesFromWire` imports: a list longer than
 * this is not a form's worth of rejections, it is a body meant to be expensive.
 */
export const MAX_ISSUES = 100;

export interface IssueCapOptions {
  /** Stop collecting at this many issues. Default `MAX_ISSUES`; a whole number from 1 up. */
  readonly maxIssues?: number | undefined;
}

/**
 * The cap of the validation in flight, `undefined` between validations. Module state, not a
 * parameter on every check: `Check` is a public signature, and builtin validation is synchronous,
 * so exactly one validation is ever in flight on this thread while a check runs.
 */
let active: number | undefined;
/** Set when a loop left input unchecked because the cap was reached. */
let stopped = false;

/**
 * Why `maxIssues` is no cap, or `undefined` when it is one. The refusal is thrown by `standard.ts`,
 * which already imports `errors.ts`: this module stays a leaf so `builder.ts` can read it.
 */
export function issueCapFault(maxIssues: number): string | undefined {
  return Number.isSafeInteger(maxIssues) && maxIssues >= 1
    ? undefined
    : 'maxIssues must be a whole number from 1 up';
}

/**
 * Has a loop collected enough? Asked after each member a builtin composite checks; outside any
 * validation (a `Check` called directly) the default cap applies, so no door is unbounded.
 */
export function issueCapReached(count: number): boolean {
  return count >= (active ?? MAX_ISSUES);
}

/**
 * The question every collecting loop asks after a member: stop here? `true` once `count` has
 * reached the cap — and when input is left unchecked (`hasMore`), the result is marked a prefix.
 */
export function stopCollecting(count: number, hasMore: boolean): boolean {
  if (!issueCapReached(count)) return false;
  if (hasMore) stopped = true;
  return true;
}

/** A loop is leaving input unchecked: the result says so (`issuesTruncated`). */
export function markIssuesStopped(): void {
  stopped = true;
}

/**
 * `markIssuesStopped`'s flag as it stands, and a way to put it back. A union tries members and
 * DISCARDS a failing member's issues, so a member that stopped early must not mark the result.
 */
export function issuesStopped(): boolean {
  return stopped;
}

export function restoreIssuesStopped(previous: boolean): void {
  stopped = previous;
}

export interface CappedRun<T> {
  readonly value: T;
  readonly cap: number;
  /** Only the OUTERMOST run reports: a nested validation is part of its caller's. */
  readonly stopped: boolean;
}

/** Run one validation under a cap. Re-entrant: a nested call joins the outer run's cap. */
export function withIssueCap<T>(cap: number, run: () => T): CappedRun<T> {
  if (active !== undefined) return { value: run(), cap: active, stopped: false };
  active = cap;
  stopped = false;
  try {
    const value = run();
    return { value, cap, stopped };
  } finally {
    active = undefined;
    stopped = false;
  }
}

/**
 * A failure result held to `cap`. `issuesTruncated: true` when issues were dropped here OR a loop
 * stopped checking — either way the list is a prefix, and a reader must not treat it as complete.
 */
export function cappedFailure(
  issues: readonly StandardIssue[],
  cap: number,
  stoppedEarly: boolean,
): { readonly issues: readonly StandardIssue[]; readonly issuesTruncated?: true } {
  const over = issues.length > cap;
  // A nested validation cut here is its caller's truncation too: the flag the outermost run reads.
  if (over) stopped = true;
  const kept = over ? issues.slice(0, cap) : issues;
  return over || stoppedEarly ? { issues: kept, issuesTruncated: true } : { issues: kept };
}
