// Single responsibility: one `DbClient` over a primary and a read replica. It decides nothing about
// SQL (`replica-route.ts`) and nothing about scope (`replica-scope.ts`) — what lives here is which
// handle a statement is sent on, what happens when the replica will not answer, and the counters
// that make both visible to a test that cannot scrape a metrics endpoint.

import { type Clock, finiteCount, logger, renderThrowable, systemClock } from '@ultimat3/core';
import { type DbClient, type DbConnection, isReservable, type ReservableClient } from './client';
import { isPlainRead } from './replica-route';
import { markScopeWrote, replicaScope } from './replica-scope';
import type { SqlFragment } from './sql';

export interface ReplicaStats {
  /** Statements the replica answered. */
  readonly replica: number;
  /** Statements sent to the primary, fallbacks included. */
  readonly primary: number;
  /** Replica attempts that failed and were re-run on the primary. */
  readonly fallbacks: number;
  /** True while the breaker is parked and every read is going to the primary. */
  readonly parked: boolean;
}

export interface ReplicatedClientOptions {
  /** Consecutive replica failures before it is parked. */
  readonly breakerFailures?: number | undefined;
  readonly breakerCooldownMs?: number | undefined;
  /** Injection seam; production passes neither. */
  readonly clock?: Clock | undefined;
}

export interface ReplicatedClient extends DbClient {
  readonly stats: ReplicaStats;
}

/** Three in a row, then a ten-second rest — an outage costs 3 doubled reads, not every read. */
export const BREAKER_FAILURES = 3;
export const BREAKER_COOLDOWN_MS = 10_000;

/**
 * `primary` answers everything that is not provably a replica-safe read inside an open
 * `withReplicaReads` scope. Reservations are ALWAYS the primary's: `withTransaction` pins a
 * connection through `reserve()`, and a BEGIN that landed on a standby is not a transaction, it is
 * `25006` on the first write inside it.
 *
 * `reserve` is present only when the primary has one, so `isReservable()` keeps answering about the
 * database rather than about this wrapper — a wrapper that always exposed `reserve` would make
 * `runRoot` pin a connection out of a client that cannot pin, and one that never exposed it would
 * make `runRoot` run BEGIN, the statements and COMMIT on three different pooled connections.
 */
export function replicatedClient(
  primary: DbClient,
  replica: DbClient,
  options: ReplicatedClientOptions = {},
): ReplicatedClient {
  const clock = options.clock ?? systemClock;
  // Both are comparisons and nothing else — `consecutiveFailures >= limit` opens the breaker,
  // `monotonic() < parkedUntil` holds it open — so a `NaN` in either is a breaker that never trips
  // and never parks, with every read still going to the replica that is failing.
  const limit = finiteCount(
    'replicatedClient',
    'breakerFailures',
    options.breakerFailures ?? BREAKER_FAILURES,
    1,
  );
  const cooldown = finiteCount(
    'replicatedClient',
    'breakerCooldownMs',
    options.breakerCooldownMs ?? BREAKER_COOLDOWN_MS,
    1,
  );
  let replicaCount = 0;
  let primaryCount = 0;
  let fallbackCount = 0;
  let consecutiveFailures = 0;
  let parkedUntil = 0;

  /** Monotonic, never wall clock: a leap second or an NTP step must not un-park the breaker. */
  function parked(): boolean {
    return clock.monotonic() < parkedUntil;
  }

  function nodeIsReplica(text: string): boolean {
    const scope = replicaScope();
    // No scope: nobody declared these reads replica-safe, so this is a single-pool client.
    if (scope === undefined) return false;
    if (!isPlainRead(text)) {
      markScopeWrote();
      return false;
    }
    // Read-your-writes, and the reason the flag is on a mutable scope value rather than computed
    // per statement: once this scope has written, every later read in it is the primary's. A
    // replica is behind by an unbounded amount — streaming lag is not a number this tier can know
    // — so "the row I just inserted" is the one question a standby is guaranteed to answer wrong.
    if (scope.wrote) return false;
    return !parked();
  }

  async function send<T>(fragment: SqlFragment, on: (client: DbClient) => Promise<T>): Promise<T> {
    if (!nodeIsReplica(fragment.text)) {
      primaryCount += 1;
      return on(primary);
    }
    try {
      const answer = await on(replica);
      replicaCount += 1;
      consecutiveFailures = 0;
      return answer;
    } catch (error) {
      // Re-running is exactly-once, not at-least-once: only `isPlainRead` statements reach here,
      // and a statement a standby refused (`25006`) never executed. A replica outage therefore
      // costs latency and never an answer — which is the whole point, since a read replica is a
      // capacity tier and must not become a new way for the app to be down.
      consecutiveFailures += 1;
      if (consecutiveFailures >= limit) parkedUntil = clock.monotonic() + cooldown;
      fallbackCount += 1;
      // `renderThrowable`, never `${error}`: a driver error's `message` getter is app code.
      logger.warn('db.replica_fallback', {
        error: renderThrowable(error),
        consecutiveFailures,
        parked: parked(),
      });
      primaryCount += 1;
      return on(primary);
    }
  }

  const base: ReplicatedClient = {
    get stats(): ReplicaStats {
      return {
        replica: replicaCount,
        primary: primaryCount,
        fallbacks: fallbackCount,
        parked: parked(),
      };
    },
    query: <T>(fragment: SqlFragment) => send(fragment, (client) => client.query<T>(fragment)),
    one: <T>(fragment: SqlFragment) => send(fragment, (client) => client.one<T>(fragment)),
    execute: (fragment: SqlFragment) => send(fragment, (client) => client.execute(fragment)),
  };

  if (!isReservable(primary)) return base;
  const reservable: ReplicatedClient & ReservableClient = {
    ...base,
    get stats(): ReplicaStats {
      return base.stats;
    },
    reserve: (): Promise<DbConnection> => primary.reserve(),
  };
  return reservable;
}
