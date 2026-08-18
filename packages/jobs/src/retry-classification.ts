// One retry decision from two questions the executor used to ask only half of: "are there
// attempts left?" (./retry) and "is this error worth trying again at all?" (core's classification).
// The backoff arithmetic stays in ./retry — nothing here recomputes a delay `nextRetry` owns.

import type { ErrorRetry } from '@ultimat3/core';
import {
  DEFAULT_ERROR_RETRY,
  declaredErrorRetry,
  isErrorRetry,
  isUltimateError,
} from '@ultimat3/core';
import { toMs } from './clock';
import type { Random, RetryDecision, RetryPolicy } from './retry';
import { DEFAULT_RETRY, nextRetry } from './retry';

/** Why this attempt was the last one. Absent while the job is still being retried. */
export type JobStopReason = 'terminal' | 'attempts-exhausted';

export interface JobRetryDecision extends RetryDecision {
  readonly stoppedBy: JobStopReason | undefined;
  /** The classification consulted, or `undefined` when nobody classified the thrown code. */
  readonly classification: ErrorRetry | undefined;
}

/**
 * The classification that was DECLARED for this throw, or `undefined` when there is none.
 *
 * Deliberately not `error.retry` alone. That field is `init.retry ?? retryFor(code)` and
 * `retryFor` fails closed, so every unclassified `UltimateError` already carries `terminal` —
 * reading it would dead-letter the first attempt of every job in every app whose codes nobody has
 * classified yet. So `terminal` counts only when it can have come from somewhere: an explicit
 * per-instance override is indistinguishable from the default here, which is why an UNCLASSIFIED
 * code carrying an instance `retry: 'terminal'` is read as unclassified. Register the code
 * (`registerErrorRetry({ X_YOUR_CODE: 'terminal' })`) to have it honoured — one way, and the same
 * way every other package declares it.
 */
export function classifyThrown(error: unknown): ErrorRetry | undefined {
  if (!isUltimateError(error)) return undefined;
  const retry: unknown = error.retry;
  if (!isErrorRetry(retry)) return undefined;
  // Anything other than the fail-closed default can only have come from the code table or from an
  // explicit override, so it is somebody's answer either way.
  if (retry !== DEFAULT_ERROR_RETRY) return retry;
  return declaredErrorRetry(error.code) === undefined ? undefined : retry;
}

/**
 * The delay a `retry-after` error NAMED, in ms. `retryAfterSeconds` on the error's `meta` is the
 * framework's one spelling for it — `@ultimat3/http`'s `rateLimited` writes it and the 429's
 * `Retry-After` header renders it — so a job and an HTTP client read the same number.
 */
export function statedDelayMs(error: unknown): number | undefined {
  if (!isUltimateError(error)) return undefined;
  const seconds: unknown = error.meta?.['retryAfterSeconds'];
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1_000);
}

/**
 * Retry, dead-letter, and when. `terminal` stops here on the attempt that failed — the same code
 * run again is the same answer, and the attempts left are a queue slot, a provider bill, and (the
 * case that forced this) three more wrong passwords at a site that locks the account after three.
 *
 * Everything else keeps the attempt count in charge: `retry-after` only replaces the delay, never
 * the ceiling, and an unclassified code takes exactly the path it took before this existed.
 */
export function nextRetryForError(
  policy: RetryPolicy,
  attempt: number,
  error: unknown,
  random?: Random,
): JobRetryDecision {
  const classification = classifyThrown(error);
  if (classification === 'terminal') {
    return {
      retry: false,
      delayMs: 0,
      // The policy still decides park-or-drop: `deadLetter: false` means this app does not keep
      // failed jobs, and that is not a preference a classification gets to overturn.
      deadLetter: policy.deadLetter ?? true,
      nextAttempt: attempt,
      stoppedBy: 'terminal',
      classification,
    };
  }

  const decision = nextRetry(policy, attempt, random);
  if (!decision.retry) {
    return { ...decision, stoppedBy: 'attempts-exhausted', classification };
  }
  if (classification !== 'retry-after')
    return { ...decision, stoppedBy: undefined, classification };

  const stated = statedDelayMs(error);
  if (stated === undefined) return { ...decision, stoppedBy: undefined, classification };
  // Clamped by the policy's own ceiling, which is what `maxDelay` is for: a responder naming a
  // day is still a responder this deployment has not agreed to wait a day for.
  const cap = toMs(policy.maxDelay ?? DEFAULT_RETRY.maxDelay);
  return { ...decision, delayMs: Math.min(stated, cap), stoppedBy: undefined, classification };
}

/**
 * What the job ROW records. `lastError` is the one failure field a row carries, so a dead letter
 * that stopped at attempt 1 of 5 has to explain itself there or `x jobs show` reads as a silent
 * early stop. Only the terminal verdict is appended: exhaustion is already legible from
 * `attempt === maxAttempts`.
 */
export function recordedFailure(message: string, decision: JobRetryDecision): string {
  return decision.stoppedBy === 'terminal'
    ? `${message} — not retried: this code is classified terminal, so every remaining attempt fails the same way`
    : message;
}
