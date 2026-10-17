// What the shared rate-limit store does when the DATABASE is down: decide from this process's
// memory instead, and say so once per window. Before, `take` rethrew `X_DB_UNAVAILABLE` and every
// request a web pod served — a prerendered `GET /` included — answered 500 for the whole blip.
//
// WHY degrade rather than refuse: a per-process bucket still limits. Behind N replicas it is N ×
// the declared number for the length of the outage, which is a weaker limit, never no limit; the
// alternative was a total outage of every route to protect a counter. Every method degrades, auth
// routes included — "per pod instead of shared" is the whole of the weakening.
//
// WHY only connection-class failures: a store that answers WRONGLY (bad SQL, a missing table, an
// executor bug) is not a store that is down, and silently switching it to memory would hide that
// forever. Those still refuse, exactly as before.

import { isUltimateError, logger } from '@ultimat3/core';
import type { RateLimitStore } from './rate-limit';
import { memoryRateLimitStore } from './rate-limit';

/** Codes `@ultimat3/db` raises when no connection could run the statement at all. */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set(['X_DB_UNAVAILABLE', 'X_DB_POOL_EXHAUSTED']);

/**
 * SQLSTATEs that mean "this connection, right now", carried on `meta.sqlState` of an
 * `X_DB_STATEMENT_FAILED`: class 08 (connection exception), `57P01`–`57P03` (the server is
 * shutting down, crashed, or not yet accepting — a failover), `53300` (too many connections).
 */
const isConnectionSqlState = (state: string): boolean =>
  state.startsWith('08') || ['57P01', '57P02', '57P03', '53300'].includes(state);

/** Read by the store's `catch`: true only for a failure that says the database is unreachable. */
export function isRateLimitStoreUnreachable(error: unknown): boolean {
  if (!isUltimateError(error)) return false;
  if (UNREACHABLE_CODES.has(error.code)) return true;
  const state = error.meta?.['sqlState'];
  return typeof state === 'string' && isConnectionSqlState(state);
}

/** How often a still-degraded store says so again: a long outage stays visible, a blip is one line. */
export const DEGRADED_WARN_EVERY_MS = 60_000;

export interface DegradedFallback {
  /** The per-process store a degraded decision is taken from — one per shared store. */
  readonly store: RateLimitStore;
  /** Log the degradation, at most once per `DEGRADED_WARN_EVERY_MS` of the caller's clock. */
  note(error: unknown, nowMs: number): void;
}

/**
 * One fallback per shared store: an empty memory store costs a `Map` until the first degraded
 * decision. The warn is throttled on the CALLER's clock — the one every take is measured against —
 * so a frozen test clock and a real one both get one line per window, never one per request.
 */
export function degradedFallback(): DegradedFallback {
  const store = memoryRateLimitStore();
  let lastWarnMs: number | undefined;
  return {
    store,
    note(error, nowMs) {
      if (lastWarnMs !== undefined && nowMs - lastWarnMs < DEGRADED_WARN_EVERY_MS) return;
      lastWarnMs = nowMs;
      logger.warn('http.rate_limit.degraded', {
        code: isUltimateError(error) ? error.code : 'unknown',
        cause:
          'the shared rate-limit store could not reach the database, so this pod is counting limits in its own memory until it can — each limit is per pod, not per fleet, meanwhile',
        fix: 'x doctor --json   # names the database binding this pod cannot reach',
      });
    },
  };
}
