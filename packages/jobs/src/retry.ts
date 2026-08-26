// Retry arithmetic, kept pure so the schedule is testable and printable. `x jobs show <id>`
// renders `retrySchedule()` verbatim as `JobTrace.retryDelaysMs` — an agent should be able to see
// when attempt 5 lands without running the queue. There is no `x jobs schedule`: the subcommands
// are `ls`, `show`, `retry`, `cancel`, `drain`.

import type { BackoffCurve, Random } from '@ultimat3/core';
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
   * Equal jitter (half fixed, half random) by default. Without it, a burst of failures
   * retries in lockstep and re-creates the thundering herd that killed the dependency.
   */
  readonly jitter?: boolean;
  /** Default true: an exhausted job is parked, never dropped. */
  readonly deadLetter?: boolean;
}

export const DEFAULT_RETRY = {
  attempts: 3,
  backoff: 'exponential',
  delay: 1_000,
  maxDelay: 3_600_000,
  jitter: true,
  deadLetter: true,
} satisfies RetryPolicy;

export type { Random };

/**
 * Delay before `attempt` (1-based: the delay after attempt 1 failed is `attempt: 1`).
 *
 * The arithmetic is core's — one curve-and-jitter function for the framework, because four
 * packages shipped four of them. What stays here is the part that is this package's and not the
 * framework's: `DurationInput` (`'30s'` as well as a number), the `DEFAULT_RETRY` fallbacks, and
 * the `jitter: boolean` this package's public `RetryPolicy` has always spelled as a flag.
 *
 * `?? DEFAULT_RETRY.jitter`, like every other option. It read `!== true` before, so an omitted
 * `jitter` meant OFF while the field's own doc says "Equal jitter … by default" — a burst of
 * failures then retried in lockstep, which is the thundering herd the default exists to break.
 * Masked for jobs declared through `job()` (it merges the defaults) and live for every direct
 * caller of this exported function, `retrySchedule` included.
 */
export function backoffDelayMs(policy: RetryPolicy, attempt: number, random?: Random): number {
  return backoffDelay({
    attempt,
    base: finiteDurationMs(policy.delay ?? DEFAULT_RETRY.delay, 'retry', 'delay'),
    max: finiteDurationMs(policy.maxDelay ?? DEFAULT_RETRY.maxDelay, 'retry', 'maxDelay'),
    curve: policy.backoff ?? DEFAULT_RETRY.backoff,
    // EQUAL, not full: a job that has already failed twice must not be handed a near-zero wait,
    // and this package's `jitter: true` has meant "half fixed, half random" since it shipped.
    jitter: (policy.jitter ?? DEFAULT_RETRY.jitter) === true ? 'equal' : 'none',
    random,
  });
}

export interface RetryDecision {
  readonly retry: boolean;
  readonly delayMs: number;
  readonly deadLetter: boolean;
  readonly nextAttempt: number;
}

/** The one place that decides retry vs dead-letter. Drivers never re-derive this. */
export function nextRetry(policy: RetryPolicy, attempt: number, random?: Random): RetryDecision {
  const exhausted = attempt >= policy.attempts;
  if (exhausted) {
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
  const deterministic: RetryPolicy = { ...policy, jitter: false };
  const out: number[] = [];
  for (let attempt = 1; attempt < policy.attempts; attempt += 1) {
    out.push(backoffDelayMs(deterministic, attempt));
  }
  return out;
}
