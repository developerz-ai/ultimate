// Retry arithmetic, kept pure so the schedule is testable and printable. `x jobs show <id>`
// renders `retrySchedule()` verbatim as `JobTrace.retryDelaysMs` — an agent should be able to see
// when attempt 5 lands without running the queue. There is no `x jobs schedule`: the subcommands
// are `ls`, `show`, `retry`, `cancel`, `drain`.

import type { BackoffCurve, JitterMode, Random } from '@ultimat3/core';
import { backoffDelay } from '@ultimat3/core';
import type { DurationInput } from './clock';
import { finiteDurationMs } from './clock';

/**
 * This package's name for core's curve, and an ALIAS rather than a second union: two spellings of
 * `'exponential' | 'linear' | 'fixed'` can drift, and a `retry: { backoff: … }` an app declares has
 * to mean the same thing the arithmetic reads.
 */
export type BackoffStrategy = BackoffCurve;

export interface RetryPolicy {
  /** Total attempts including the first. `attempts: 1` means no retry. */
  readonly attempts: number;
  readonly backoff?: BackoffStrategy;
  /** Base delay. Default 1s. */
  readonly delay?: DurationInput;
  /** Ceiling for any single delay. Default 1h. */
  readonly maxDelay?: DurationInput;
  /**
   * Core's `JitterMode`. `'equal'` (half fixed, half random) by default: a job that has already
   * failed twice keeps a floor. `'none'` retries a burst in lockstep — the thundering herd that
   * killed the dependency — and is for tests and printable schedules.
   */
  readonly jitter?: JitterMode;
  /** Default true: an exhausted job is parked, never dropped. */
  readonly deadLetter?: boolean;
}

export const DEFAULT_RETRY = {
  attempts: 3,
  backoff: 'exponential',
  delay: 1_000,
  maxDelay: 3_600_000,
  jitter: 'equal',
  deadLetter: true,
} satisfies RetryPolicy;

export type { Random };

/**
 * Delay before `attempt` (1-based: the delay after attempt 1 failed is `attempt: 1`).
 *
 * The arithmetic is core's — one curve-and-jitter function for the framework, because four
 * packages shipped four of them. What stays here is the part that is this package's and not the
 * framework's: `DurationInput` (`'30s'` as well as a number) and the `DEFAULT_RETRY` fallbacks.
 * `jitter` is core's `JitterMode` itself since 31.0.0, never a flag mapped onto two of its modes.
 *
 * `?? DEFAULT_RETRY.jitter`, like every other option: an omitted `jitter` is the documented
 * `'equal'`, never off — masked for jobs declared through `job()` (it merges the defaults) and live
 * for every direct caller of this exported function, `retrySchedule` included.
 */
export function backoffDelayMs(policy: RetryPolicy, attempt: number, random?: Random): number {
  return backoffDelay({
    attempt,
    base: finiteDurationMs(policy.delay ?? DEFAULT_RETRY.delay, 'retry', 'delay'),
    max: finiteDurationMs(policy.maxDelay ?? DEFAULT_RETRY.maxDelay, 'retry', 'maxDelay'),
    curve: policy.backoff ?? DEFAULT_RETRY.backoff,
    jitter: policy.jitter ?? DEFAULT_RETRY.jitter,
    random,
  });
}

export interface RetryDecision {
  readonly retry: boolean;
  readonly delayMs: number;
  readonly deadLetter: boolean;
  readonly nextAttempt: number;
}

/**
 * Whether `attempt` is the last one the policy allows — the ONE comparison, read twice: by
 * `nextRetry` below to stop retrying, and by `executeJob` to hand the body `finalAttempt`. Two
 * spellings of it is how a body cleans up on an attempt the runner then retries.
 */
export function isFinalAttempt(policy: RetryPolicy, attempt: number): boolean {
  return attempt >= policy.attempts;
}

/**
 * The attempts a `compensates: true` job is ENQUEUED with past its policy's own: room for the
 * claim to re-offer a row whose lease lapsed on the final attempt, so its compensators still run.
 * `isFinalAttempt` keeps reading the policy, so the body's `finalAttempt` and the retry decision
 * are unchanged; only the row's `max_attempts` — what the claim buries by — carries the margin.
 */
export const UNWIND_MARGIN = 2;

/** `max_attempts` for a row of this job: the policy's, plus `UNWIND_MARGIN` when it compensates. */
export function enqueuedAttempts(policy: RetryPolicy, compensates: boolean): number {
  return compensates ? policy.attempts + UNWIND_MARGIN : policy.attempts;
}

/**
 * An attempt past the policy's last: only a `compensates` job reaches one, and only by the claim
 * re-offering a lapsed lease. It unwinds — it never runs forward — whatever its steps say.
 */
export function isUnwindAttempt(policy: RetryPolicy, attempt: number): boolean {
  return attempt > policy.attempts;
}

/** The last attempt an unwind may take: past it, a failing compensator is dead-lettered. */
export function isFinalUnwindAttempt(policy: RetryPolicy, attempt: number): boolean {
  return attempt >= policy.attempts + UNWIND_MARGIN;
}

/** The one place that decides retry vs dead-letter. Drivers never re-derive this. */
export function nextRetry(policy: RetryPolicy, attempt: number, random?: Random): RetryDecision {
  if (isFinalAttempt(policy, attempt)) {
    return {
      retry: false,
      delayMs: 0,
      deadLetter: policy.deadLetter ?? true,
      nextAttempt: attempt,
    };
  }
  return {
    retry: true,
    delayMs: backoffDelayMs(policy, attempt, random),
    deadLetter: false,
    nextAttempt: attempt + 1,
  };
}

/** Every delay in the policy, jitter off, for docs and `--json` output. */
export function retrySchedule(policy: RetryPolicy): readonly number[] {
  const deterministic: RetryPolicy = { ...policy, jitter: 'none' };
  const out: number[] = [];
  for (let attempt = 1; attempt < policy.attempts; attempt += 1) {
    out.push(backoffDelayMs(deterministic, attempt));
  }
  return out;
}
