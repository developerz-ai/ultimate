// A cache tier is best-effort infrastructure: a refusal must never reach the caller of a
// business read or write, the same rule `invalidateTags` already keeps. `read()` has no report
// to return, so every swallowed refusal lands in one bounded log plus one `warn` — a stack
// running degraded stays answerable instead of merely looking slow.

import { logger, systemClock, UltimateError } from '@ultimat3/core';
import type { TierName } from './tiers';

/** The three tier calls a stack makes on the value path. `invalidateTags` reports its own. */
export type TierOperation = 'get' | 'set' | 'del';

export interface TierFailure {
  /** ISO-8601, from core's `systemClock` — never `new Date()`. */
  readonly at: string;
  readonly tier: TierName;
  readonly op: TierOperation;
  readonly key: string;
  /** The `X_*` code when the tier threw an `UltimateError`; absent for anything else. */
  readonly code?: string;
  readonly message: string;
}

// A dev log, not an audit trail — capped so a long-lived process cannot grow it forever.
const MAX_TIER_FAILURES = 100;

/** Newest first. Module-private; read it through `recentTierFailures()`. */
const failureLog: TierFailure[] = [];

/** What a "is the cache degraded?" question reads: newest first, capped, a copy of the log. */
export function recentTierFailures(): readonly TierFailure[] {
  return [...failureLog];
}

/** Test seam, and `resetTiers()`'s: drops every recorded failure. */
export function resetTierFailures(): void {
  failureLog.length = 0;
}

/**
 * `isolateDeclaredTags()`'s contract over this log — `tags.ts` carries the why. It lives here
 * rather than in a test file because the log has a reader and no writer: from outside this module
 * the entries `resetTierFailures()` drops cannot be put back at all.
 *
 *   const restoreFailures = isolateTierFailures();
 *   afterAll(restoreFailures);
 */
export function isolateTierFailures(): () => void {
  const captured = [...failureLog];
  return () => {
    failureLog.length = 0;
    failureLog.push(...captured);
  };
}

/**
 * Runs one tier call and absorbs its refusal. `undefined` back means the tier declined, which a
 * `get` already reads as a miss and a `set`/`del` as "that tier is unchanged" — so the caller
 * needs no branch. The entry a tier refused to hold expires by TTL, exactly as one an
 * `invalidateTags` failure left behind does.
 */
export async function bestEffort<T>(
  tier: TierName,
  op: TierOperation,
  key: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    record(tier, op, key, error);
    return undefined;
  }
}

function record(tier: TierName, op: TierOperation, key: string, error: unknown): void {
  const failure: TierFailure = {
    at: systemClock.now().toISOString(),
    tier,
    op,
    key,
    ...(error instanceof UltimateError ? { code: error.code } : {}),
    message: error instanceof Error ? error.message : String(error),
  };
  failureLog.unshift(failure);
  failureLog.length = Math.min(failureLog.length, MAX_TIER_FAILURES);
  logger.warn('cache.tier.failed', { ...failure });
}
