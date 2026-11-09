// A cache tier is best-effort infrastructure: a refusal must never reach the caller of a
// business read or write, the same rule `invalidateTags` already keeps. `read()` has no report
// to return, so every swallowed refusal is one `cache.tier_failure` event plus one `warn` — a
// stack running degraded stays answerable instead of merely looking slow.

import { instrument, logger, renderThrowable, UltimateError } from '@ultimat3/core';
import type { TierLabel } from './tiers';

/** The three tier calls a stack makes on the value path. `invalidateTags` reports its own. */
export type TierOperation = 'get' | 'set' | 'del';

/**
 * Runs one tier call and absorbs its refusal. `undefined` back means the tier declined, which a
 * `get` already reads as a miss and a `set`/`del` as "that tier is unchanged" — so the caller
 * needs no branch. The entry a tier refused to hold expires by TTL, exactly as one an
 * `invalidateTags` failure left behind does.
 *
 * Public, and the only sanctioned way to swallow a cache refusal: a store outside this package
 * (`@ultimat3/query`'s read cache) that wrapped its own `try/catch` would degrade invisibly, and
 * a second failure stream nobody subscribes to is what this one exists to prevent. Pass the store's
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
  // `CacheTierFailureEvent`, core's shape: no `at` — a subscriber that keeps a log reads its clock.
  const failure = {
    tier,
    op,
    key,
    ...(code === undefined ? {} : { code }),
    // Never `error.message`: a rendering that throws replaces the absorbed refusal with a
    // `TypeError` on the business read this function exists to keep alive.
    message: renderThrowable(error),
  };
  logger.warn('cache.tier.failed', { ...failure });
  // A subscriber's throw is contained by the bus (logged once as `instrument.subscriber_failed`):
  // observability can never turn a degraded cache into a failed business read.
  instrument('cache.tier_failure', failure);
}
