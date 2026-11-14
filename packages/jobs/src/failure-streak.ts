// A polling loop's failures as a STREAK: one `error` line when the first tick fails, nothing for
// the ticks after it, one `info` line carrying the count when a tick passes again — a database
// restart wrote 154 identical lines, burying the one that said why.
// Local until core ships a limiter for it; the call sites are the only thing that would change.

import { logger } from '@ultimat3/core';
import { failureFields } from './scheduler-upkeep';

export interface FailureStreak {
  /** A tick failed: logged when it opens a streak, counted otherwise. */
  failed(error: unknown, fields?: Record<string, unknown>): void;
  /** A tick passed: ends a streak, if one was open, with one line counting it. */
  passed(): void;
}

export function failureStreak(failedEvent: string, recoveredEvent: string): FailureStreak {
  let failures = 0;
  let context: Record<string, unknown> = {};
  return {
    failed(error, fields = {}) {
      failures += 1;
      if (failures > 1) return;
      context = fields;
      logger.error(failedEvent, { ...fields, ...failureFields(error) });
    },
    passed() {
      if (failures === 0) return;
      logger.info(recoveredEvent, { ...context, failures });
      failures = 0;
      context = {};
    },
  };
}

/** One streak as a claim loop's two hooks (`ClaimLoopOptions.onError` / `onPassed`). */
export function streakHooks(
  failedEvent: string,
  recoveredEvent: string,
  fields: Record<string, unknown>,
): { readonly onError: (error: unknown) => void; readonly onPassed: () => void } {
  const streak = failureStreak(failedEvent, recoveredEvent);
  return { onError: (error) => streak.failed(error, fields), onPassed: () => streak.passed() };
}
