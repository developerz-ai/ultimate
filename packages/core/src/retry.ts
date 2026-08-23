// Single responsibility: run work again, on the framework's own terms. The executor
// `error-retry.ts` never had — that module declares `terminal | retryable | retry-after` and
// nothing in the tree consulted it before deciding to try again, so four packages each shipped
// their own loop and only `@ultimat3/jobs`' asked the classification at all.

import { type BackoffCurve, backoffDelay, type JitterMode, type Random } from './backoff';
import { systemClock } from './clock';
import { classifyThrown, type ErrorRetry, statedDelayMs } from './error-retry';

export interface RetryPolicy {
  /** Total attempts INCLUDING the first. `attempts: 1` means no retry. */
  readonly attempts: number;
  /** The first delay, in ms. */
  readonly base: number;
  /** Ceiling for any single delay, in ms — a `retry-after` the responder named included. */
  readonly max: number;
  /**
   * Required, unlike `backoffDelay`'s, and that is the point: a retry loop with no jitter is the
   * thundering herd itself, so the mode is a decision each caller makes rather than one it can
   * inherit without noticing.
   */
  readonly jitter: JitterMode;
  readonly curve?: BackoffCurve | undefined;
  readonly factor?: number | undefined;
  /**
   * Wall-clock budget for the WHOLE loop, waits included. A wait that would end past it is never
   * started — the caller's own deadline outranks the attempts it was allowed.
   */
  readonly timeBudgetMs?: number | undefined;
}

export interface RetryDeps {
  /** Injected so a retry schedule is provable without waiting for one. */
  sleep(ms: number): Promise<void>;
  /** Monotonic ms, read only when `timeBudgetMs` is set. Defaults to the system clock. */
  now?: (() => number) | undefined;
  random?: Random | undefined;
}

/** Why the loop stopped. Absent while it is still retrying. */
export type RetryStopReason = 'terminal' | 'attempts-exhausted' | 'budget-exhausted';

export interface RetryDecision {
  readonly retry: boolean;
  readonly delayMs: number;
  readonly attempt: number;
  readonly nextAttempt: number;
  /** The classification consulted, or `undefined` when nobody classified the thrown code. */
  readonly classification: ErrorRetry | undefined;
  readonly stoppedBy: RetryStopReason | undefined;
}

/**
 * Retry, stop, and when — pure, so a caller can print the schedule and a test can pin it without a
 * loop. `terminal` stops on the attempt that failed: the same code run again is the same answer,
 * and the attempts left are a queue slot, a provider bill, or three more wrong passwords at a site
 * that locks the account after three. Everything else keeps the attempt count in charge, and
 * `retry-after` replaces only the DELAY, never the ceiling.
 */
export function retryDecision(
  policy: RetryPolicy,
  attempt: number,
  error: unknown,
  random?: Random,
): RetryDecision {
  const classification = classifyThrown(error);
  const stop = (stoppedBy: RetryStopReason): RetryDecision => ({
    retry: false,
    delayMs: 0,
    attempt,
    nextAttempt: attempt,
    classification,
    stoppedBy,
  });

  if (classification === 'terminal') return stop('terminal');
  if (attempt >= policy.attempts) return stop('attempts-exhausted');

  const computed = backoffDelay({
    attempt,
    base: policy.base,
    max: policy.max,
    factor: policy.factor,
    curve: policy.curve,
    jitter: policy.jitter,
    random,
  });
  const stated = classification === 'retry-after' ? statedDelayMs(error) : undefined;
  return {
    retry: true,
    // Clamped by the policy's own ceiling, which is what `max` is for: a responder naming a day is
    // still a responder this deployment has not agreed to wait a day for.
    delayMs: stated === undefined ? computed : Math.min(stated, policy.max),
    attempt,
    nextAttempt: attempt + 1,
    classification,
    stoppedBy: undefined,
  };
}

/**
 * Run `work` until it succeeds, the policy runs out, the classification says stop, or the time
 * budget does. `work` is handed the 1-based attempt number.
 *
 * The LAST error reaches the caller unchanged — never wrapped. An `UltimateError` carries a code, a
 * cause and a runnable `fix:`, and a wrapper would replace all three with the fact that something
 * was retried, which no reader can act on.
 */
export async function retry<T>(
  work: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  deps: RetryDeps,
): Promise<T> {
  const now = deps.now ?? ((): number => systemClock.monotonic());
  // Read once even when no budget is set: a clock call per attempt would be a cost the common case
  // does not owe. `startedAt` is only compared against when `timeBudgetMs` is present.
  const startedAt = now();

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work(attempt);
    } catch (error) {
      const decision = retryDecision(policy, attempt, error, deps.random);
      if (!decision.retry) throw error;
      const budget = policy.timeBudgetMs;
      // Decided BEFORE the wait, never after: a loop that sleeps and then discovers it is out of
      // budget has already spent the caller's deadline on a wait nobody could use.
      if (budget !== undefined && now() - startedAt + decision.delayMs > budget) throw error;
      await deps.sleep(decision.delayMs);
    }
  }
}
