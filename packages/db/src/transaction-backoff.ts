// Single responsibility: how long a lost serialization race waits before `withTransaction` re-runs
// `fn`. The curve is `@ultimat3/core`'s — this file is the two constants, and the case for them.

import { backoffDelay, type Random } from '@ultimat3/core';

/**
 * A serialization conflict is CONTENTION, not overload, and the constants say so.
 *
 * `base: 10` — the transaction that won the race is already committing, and one round trip to a
 * Postgres in the same network is under 2ms. A provider-outage base (`@ultimat3/ai` uses 500ms,
 * `@ultimat3/jobs` a second) would put a `retry: 8` budget seconds past the deadline of the request
 * it is serving, which turns a recovered transaction into a timed-out one.
 *
 * `max: 500` — this loop runs on a request's critical path, holding a connection nothing else can
 * use. The eight-attempt worst case is under a second of waiting; a minute-long ceiling would be a
 * queue's, and a queue can afford one because nobody is waiting on the other end.
 *
 * `full` jitter — the only mode that decorrelates. Two transactions that just deadlocked are, by
 * construction, two callers whose retries would otherwise be scheduled at the same offset from the
 * same event, and re-colliding is the failure this wait exists to prevent. `equal` keeps a latency
 * floor for a client that must not be starved, which is not this.
 */
export const TRANSACTION_RETRY_BACKOFF = {
  base: 10,
  max: 500,
  curve: 'exponential',
  jitter: 'full',
} as const;

/**
 * Milliseconds before attempt `attempt + 1`. 1-based, like core's, and `random` is injected so the
 * schedule is a list a test can assert rather than a range it can only sample.
 */
export function serializationRetryDelayMs(attempt: number, random?: Random): number {
  return backoffDelay({
    attempt,
    base: TRANSACTION_RETRY_BACKOFF.base,
    max: TRANSACTION_RETRY_BACKOFF.max,
    curve: TRANSACTION_RETRY_BACKOFF.curve,
    jitter: TRANSACTION_RETRY_BACKOFF.jitter,
    random,
  });
}
