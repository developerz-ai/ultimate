// Retry arithmetic, kept pure so the schedule is testable and printable. `x jobs schedule`
// renders `retrySchedule()` verbatim — an agent should be able to see when attempt 5 lands
// without running the queue.

import type { DurationInput } from './clock';
import { toMs } from './clock';

export type BackoffStrategy = 'exponential' | 'linear' | 'fixed';

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

export type Random = () => number;

/** Delay before `attempt` (1-based: the delay after attempt 1 failed is `attempt: 1`). */
export function backoffDelayMs(policy: RetryPolicy, attempt: number, random?: Random): number {
  const base = toMs(policy.delay ?? DEFAULT_RETRY.delay ?? 1_000);
  const cap = toMs(policy.maxDelay ?? DEFAULT_RETRY.maxDelay ?? 3_600_000);
  const strategy = policy.backoff ?? 'exponential';
  const step = Math.max(1, attempt);

  let raw: number;
  if (strategy === 'fixed') raw = base;
  else if (strategy === 'linear') raw = base * step;
  else raw = base * 2 ** (step - 1);

  const capped = Math.min(raw, cap);
  // `?? DEFAULT_RETRY.jitter`, like every other option above. It read `!== true`, so an omitted
  // `jitter` meant OFF while the field's own doc says "Equal jitter … by default" — a burst of
  // failures then retried in lockstep, which is the thundering herd the default exists to break.
  // Masked for jobs declared through `job()` (it merges the defaults) and live for every direct
  // caller of this exported function, `retrySchedule` included.
  if ((policy.jitter ?? DEFAULT_RETRY.jitter) !== true) return Math.round(capped);
  const roll = (random ?? Math.random)();
  return Math.round(capped / 2 + (capped / 2) * roll);
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
