// One retry decision from two questions the executor used to ask only half of: "are there
// attempts left?" (./retry) and "is this error worth trying again at all?" (core's classification).
// The backoff arithmetic stays in ./retry — nothing here recomputes a delay `nextRetry` owns.

import type { ErrorRetry } from '@ultimat3/core';
import {
  classifyThrown,
  isUltimateError,
  jitterStatedDelay,
  renderThrowable,
  singleLine,
  statedDelayMs,
} from '@ultimat3/core';
import { finiteDurationMs } from './clock';
import { appendToOperatorLine, CALLER_FIX_SEPARATOR } from './failure-row';
import type { Random, RetryDecision, RetryPolicy } from './retry';
import { backoffDelayMs, DEFAULT_RETRY, nextRetry } from './retry';

/** Why this attempt was the last one. Absent while the job is still being retried. */
export type JobStopReason = 'terminal' | 'attempts-exhausted';

export interface JobRetryDecision extends RetryDecision {
  readonly stoppedBy: JobStopReason | undefined;
  /** The classification consulted, or `undefined` when nobody classified the thrown code. */
  readonly classification: ErrorRetry | undefined;
}

// `classifyThrown` and `statedDelayMs` are core's, imported — the readers of core's classification
// table, which every executor answers the same way. An UNCLASSIFIED code carrying an instance
// `retry: 'terminal'` reads as unclassified (a per-instance `terminal` is indistinguishable from
// the fail-closed default); `retry-classification.test.ts` holds that rule against core's function.

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
  // The floor is clamped by the policy's own ceiling, which is what `maxDelay` is for: a responder
  // naming a day is still a responder this deployment has not agreed to wait a day for. The spread
  // on top is core's `jitterStatedDelay` — the one rule for a named delay — because an HTTP-date
  // hands every delivery to one receiver the SAME instant, and waking them together is the herd.
  const cap = finiteDurationMs(policy.maxDelay ?? DEFAULT_RETRY.maxDelay, 'retry', 'maxDelay');
  // `jitter: false` is the policy's own decision and is honoured: the bare floor.
  const floor = Math.min(stated, cap);
  const jittered = (policy.jitter ?? DEFAULT_RETRY.jitter) === true;
  const delayMs = jittered ? jitterStatedDelay(floor, cap, random) : floor;
  return { ...decision, delayMs, stoppedBy: undefined, classification };
}

/**
 * `@ultimat3/http`'s `rateLimited()` — the refusal a declared `rateLimit:` answers on every
 * surface, a job's `.job()`/`llm()` run included. Named, not classified: `retry-after` also covers
 * `X_OVERLOADED`, a shed that should still spend the policy's attempts.
 */
const RATE_LIMITED = 'X_RATE_LIMITED';

/**
 * `@ultimat3/notify`'s refusal of a delivery another attempt holds: the same "not yet", because the
 * holder finishes or its window lapses. Counted, a provider blip and a crash left a third attempt
 * meeting the crashed one's row and dead-lettered a notification nothing sent. A literal, as a tier
 * below names no import above it; a shipped code never changes.
 */
const DELIVERY_HELD = 'X_NOTIFY_DELIVERY_HELD';

/**
 * How long to wait out a rate-limit refusal, or `undefined` when `error` is not one. A refusal is
 * "not yet", never "failed": the bucket refills, so the run is rescheduled with its attempt
 * UNCOUNTED — counted, a backlog of rate-limited jobs spent every attempt waiting and was
 * dead-lettered for it.
 *
 * The stated `Retry-After` is the FLOOR, never clamped: a run woken before the refill is refused
 * again, so clamping a 3600 s refusal to `maxDelay` re-ran the backlog every minute for an hour.
 * With none stated, the policy's own backoff. On top, a spread in `[0, min(wait / 2, maxDelay))`:
 * a backlog refused together and woken at one instant is refused together again, a claim storm
 * that repeats forever. `maxDelay` bounds only that spread.
 */
export function rateLimitDeferralMs(
  policy: RetryPolicy,
  attempt: number,
  error: unknown,
  random: Random = Math.random,
): number | undefined {
  if (!isUltimateError(error)) return undefined;
  if (error.code !== RATE_LIMITED && error.code !== DELIVERY_HELD) return undefined;
  const cap = finiteDurationMs(policy.maxDelay ?? DEFAULT_RETRY.maxDelay, 'retry', 'maxDelay');
  const wait = statedDelayMs(error) ?? Math.min(backoffDelayMs(policy, attempt), cap);
  return jitterStatedDelay(wait, cap, random);
}

/**
 * A thrown value as a job ROW keeps it: core's rendering, plus the error's own `fix:`, plus — after
 * `CALLER_FIX_SEPARATOR` — its declared `callerFix`, the one part `callerFailure` hands a caller.
 *
 * `renderThrowable` answers `<name>: <code>: <title> — <cause>` and stops there, so `lastError` —
 * the one failure field `x jobs show` prints — handed an operator a diagnosis with the instruction
 * cut off. Only a branded error's fixes travel: any other `fix` property is somebody's data. The
 * operator's line is `singleLine`d whole, so a thrown message cannot write the separator's tab.
 */
export function failureForRow(error: unknown): string {
  const rendered = singleLine(renderThrowable(error));
  if (!isUltimateError(error)) return rendered;
  const line = `${rendered} — fix: ${singleLine(error.fix)}`;
  const callerFix = typeof error.callerFix === 'string' ? error.callerFix : undefined;
  return callerFix === undefined ? line : `${line}${CALLER_FIX_SEPARATOR}${singleLine(callerFix)}`;
}

/**
 * What the job ROW records. `lastError` is the one failure field a row carries, so a dead letter
 * that stopped at attempt 1 of 5 has to explain itself there or `x jobs show` reads as a silent
 * early stop. Only the terminal verdict is appended — to the operator's line, ahead of the caller's
 * fix: exhaustion is already legible from `attempt === maxAttempts`.
 */
export function recordedFailure(message: string, decision: JobRetryDecision): string {
  return decision.stoppedBy === 'terminal'
    ? appendToOperatorLine(
        message,
        ' — not retried: this code is classified terminal, so every remaining attempt fails the same way',
      )
    : message;
}
