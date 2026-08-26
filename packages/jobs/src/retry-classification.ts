// One retry decision from two questions the executor used to ask only half of: "are there
// attempts left?" (./retry) and "is this error worth trying again at all?" (core's classification).
// The backoff arithmetic stays in ./retry — nothing here recomputes a delay `nextRetry` owns.

import type { ErrorRetry } from '@ultimat3/core';
import { classifyThrown, statedDelayMs } from '@ultimat3/core';
import { finiteDurationMs } from './clock';
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
 * Core's, re-exported rather than copied — they are the readers of core's classification table and
 * every executor in the framework has to answer them the same way. Both were declared here first
 * and moved down a tier VERBATIM, the subtle rule included: an UNCLASSIFIED code carrying an
 * instance `retry: 'terminal'` reads as unclassified, because a per-instance `terminal` is
 * indistinguishable from the fail-closed default and honouring it would dead-letter the first
 * attempt of every job in every app whose codes nobody has classified. `retry-classification.test.ts`
 * pins that they are the same FUNCTION, not merely two functions that agree today.
 */
export { classifyThrown, statedDelayMs };

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
  const cap = finiteDurationMs(policy.maxDelay ?? DEFAULT_RETRY.maxDelay, 'retry', 'maxDelay');
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
