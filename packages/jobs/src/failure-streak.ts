// A polling loop's failures as a STREAK: one `error` line when the first tick fails, nothing for
// the ticks after it, one `info` line carrying the count when a tick passes again — a database
// restart wrote 154 identical lines, burying the one that said why.
// Local until core ships a limiter for it; the call sites are the only thing that would change.

import { isUltimateError, logger, renderThrowable } from '@ultimat3/core';
import { failureFields } from './scheduler-upkeep';

export interface FailureStreak {
  /**
   * A tick failed: logged when it opens a streak or changes its cause, counted otherwise. A new
   * cause — a restart's refusal giving way to a missing column — is news: its line carries the
   * streak it ends (`previous`, with that streak's count).
   */
  failed(error: unknown, fields?: Record<string, unknown>): void;
  /** A tick passed: ends a streak, if one was open, with one line counting it. */
  passed(): void;
  /** The loop (re)started: whatever streak a stopped run left open is not this run's. */
  reset(): void;
}

/** What makes two failures the same one: the code, or, uncoded, the rendered message. */
function causeOf(error: unknown): { readonly key: string; readonly label: Record<string, string> } {
  if (isUltimateError(error)) return { key: `code:${error.code}`, label: { code: error.code } };
  const message = renderThrowable(error);
  return { key: `error:${message}`, label: { error: message } };
}

export function failureStreak(failedEvent: string, recoveredEvent: string): FailureStreak {
  let failures = 0;
  let cause: ReturnType<typeof causeOf> | undefined;
  let context: Record<string, unknown> = {};
  const reset = (): void => {
    failures = 0;
    cause = undefined;
    context = {};
  };
  return {
    failed(error, fields = {}) {
      const next = causeOf(error);
      if (cause !== undefined && cause.key === next.key) {
        failures += 1;
        return;
      }
      const previous = cause === undefined ? {} : { previous: { ...cause.label, failures } };
      failures = 1;
      cause = next;
      context = fields;
      logger.error(failedEvent, { ...fields, ...failureFields(error), ...previous });
    },
    passed() {
      if (failures === 0) return;
      logger.info(recoveredEvent, { ...context, failures });
      reset();
    },
    reset,
  };
}

/** One streak as a claim loop's hooks (`ClaimLoopOptions.onError` / `onPassed` / `onStart`). */
export function streakHooks(
  failedEvent: string,
  recoveredEvent: string,
  fields: Record<string, unknown>,
): {
  readonly onError: (error: unknown) => void;
  readonly onPassed: () => void;
  readonly onStart: () => void;
} {
  const streak = failureStreak(failedEvent, recoveredEvent);
  return {
    onError: (error) => streak.failed(error, fields),
    onPassed: () => streak.passed(),
    onStart: () => streak.reset(),
  };
}
