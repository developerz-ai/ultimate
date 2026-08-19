// A cache tier is best-effort infrastructure: a refusal must never reach the caller of a
// business read or write, the same rule `invalidateTags` already keeps. `read()` has no report
// to return, so every swallowed refusal lands in one bounded log plus one `warn` — a stack
// running degraded stays answerable instead of merely looking slow.

import { logger, renderThrowable, systemClock, UltimateError } from '@ultimat3/core';
import type { TierLabel } from './tiers';

/** The three tier calls a stack makes on the value path. `invalidateTags` reports its own. */
export type TierOperation = 'get' | 'set' | 'del';

export interface TierFailure {
  /** ISO-8601, from core's `systemClock` — never `new Date()`. */
  readonly at: string;
  readonly tier: TierLabel;
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
 *
 * Public, and the only sanctioned way to swallow a cache refusal: a store outside this package
 * (`@ultimat3/query`'s read cache) that wrapped its own `try/catch` would degrade invisibly, and
 * a second failure log nobody reads is what this one exists to prevent. Pass the store's
 * `TierLabel` — it is closed for that reason.
 */
export async function bestEffort<T>(
  tier: TierLabel,
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

/**
 * The `X_*` code when the tier threw an `UltimateError`, and `undefined` for every other answer —
 * "the probe itself threw" included. `instanceof` RUNS a `Proxy`'s `getPrototypeOf` trap and the
 * read past it is a getter call, both on a value this package did not build; the one place the
 * question is asked is the catch block absorbing a refusal, which has nothing left to answer with
 * if asking it raises. Core's `isThrownError` is this guard for `Error` and `stringField` is it for
 * a loose field — neither fits here, because a driver error's `code` is a SQLSTATE and must never
 * be reported as an `X_*` one.
 */
function ultimateCode(error: unknown): string | undefined {
  try {
    if (!(error instanceof UltimateError)) return undefined;
    return typeof error.code === 'string' ? error.code : undefined;
  } catch {
    return undefined;
  }
}

function record(tier: TierLabel, op: TierOperation, key: string, error: unknown): void {
  const code = ultimateCode(error);
  const failure: TierFailure = {
    at: systemClock.now().toISOString(),
    tier,
    op,
    key,
    ...(code === undefined ? {} : { code }),
    // Never `error.message`: a rendering that throws replaces the absorbed refusal with a
    // `TypeError` on the business read this function exists to keep alive.
    message: renderThrowable(error),
  };
  failureLog.unshift(failure);
  failureLog.length = Math.min(failureLog.length, MAX_TIER_FAILURES);
  logger.warn('cache.tier.failed', { ...failure });
}
