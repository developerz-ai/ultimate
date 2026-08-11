// Single responsibility: environment → change feed. The one place that decides which `ChangeFeed`
// a boot installs, so `x dev`, a replicator container and any custom host resolve it identically.
// `PgLogicalReplicationFeed` is useless until something constructs it from a connection string;
// this is that something, keyed on env rather than a config field so one image deploys everywhere.

import type { Clock } from '@ultimat3/core';
import { ConfigInvalidError } from '@ultimat3/core';
import type { ChangeFeed } from './changefeed';
import { InMemoryChangeFeed, PgLogicalReplicationFeed } from './changefeed';
import { PgAdvisoryLock } from './pg-advisory-lock';
import type { PgTarget } from './pg-socket';
import { parsePgUrl } from './pg-socket';
import type { PgStream } from './pg-wire';
import type { AdvisoryLock } from './replicator';
import { InMemoryAdvisoryLock } from './replicator';
import type { Rng } from './thundering-herd';

/** The keys read here, and nothing else. Named once so docs and tests cannot drift from the code. */
export const REPLICATION_ENV_KEYS = [
  'DATABASE_URL',
  'REPLICATION_URL',
  'REPLICATION_SLOT',
  'REPLICATION_PUBLICATION',
] as const;

/** The slot one replicator holds, and the publication it decodes, when env names neither. */
export const DEFAULT_REPLICATION_SLOT = 'x_replicator';
export const DEFAULT_REPLICATION_PUBLICATION = 'x_changes';

/** The advisory-lock key for a slot. One database, one replicator, one key — derived, never typed. */
export const replicatorLockKey = (slot: string): string => `x:replicator:${slot}`;

export type ReplicationEnvironment = Readonly<Record<string, string | undefined>>;

export interface ChangeFeedSelection {
  readonly feed: ChangeFeed;
  /** `embedded` is the in-process feed; `external` decodes a real WAL. */
  readonly mode: 'embedded' | 'external';
  /**
   * Why this feed, in one line: the env key that selected it, or what to set to change it. A boot
   * prints it, so "which WAL is this process reading" is never a guess — and it is the env key
   * rather than the URL, because a replication URL carries a password.
   */
  readonly detail: string;
  /** Null in embedded mode: there is no slot to lock, and nothing to be the second replicator of. */
  readonly slot: string | null;
  /**
   * The lock that keeps "one replicator per database" true for this feed. Returned here rather
   * than built by the caller so the connection string stays inside this module — a caller that
   * had to construct the lock itself would need the URL, and the URL carries a password.
   */
  readonly lock: AdvisoryLock;
}

export interface SelectChangeFeedOptions {
  /** Entities to decode. Anything else is skipped before it reaches the matcher. */
  readonly entities: readonly string[];
  /** Retained events in the embedded feed, so a `start({ from })` replays instead of skipping. */
  readonly retain?: number | undefined;
  readonly clock?: Clock | undefined;
  readonly rng?: Rng | undefined;
  readonly stream?: ((target: PgTarget) => Promise<PgStream>) | undefined;
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim().length === 0 ? undefined : value.trim();

/**
 * A feed pointed at a *different* database than the app writes to decodes a WAL in which the app's
 * own transactions never appear: every live query stays on its first snapshot forever and nothing
 * downstream can tell. There is no runtime symptom to debug, so the two URLs are compared at the
 * boundary — the only place both are still in hand.
 */
function assertSameDatabase(replicationUrl: string, databaseUrl: string): void {
  const replication = parsePgUrl(replicationUrl);
  const application = parsePgUrl(databaseUrl);
  const differs =
    replication.host !== application.host ||
    replication.port !== application.port ||
    replication.database !== application.database;
  if (!differs) return;
  throw new ConfigInvalidError({
    cause:
      `REPLICATION_URL names ${replication.host}:${replication.port}/${replication.database} but ` +
      `DATABASE_URL names ${application.host}:${application.port}/${application.database} — the ` +
      'feed would decode a WAL the app never writes to',
    fix: 'point REPLICATION_URL at the same host, port and database as DATABASE_URL, changing only the role',
    meta: { REPLICATION_URL: replication.database, DATABASE_URL: application.database },
  });
}

/**
 * No connection string means the in-process feed — the same "an unset variable means the embedded
 * default" law the db, events and storage bindings follow. `REPLICATION_URL` exists because the
 * app's own role usually lacks `REPLICATION`; it overrides which credentials are used, never which
 * database is read, which is what `assertSameDatabase` holds to.
 */
export function selectChangeFeed(
  env: ReplicationEnvironment,
  options: SelectChangeFeedOptions,
): ChangeFeedSelection {
  const databaseUrl = nonEmpty(env['DATABASE_URL']);
  const replicationUrl = nonEmpty(env['REPLICATION_URL']);
  const url = replicationUrl ?? databaseUrl;

  if (url === undefined) {
    return {
      feed: new InMemoryChangeFeed(options.retain === undefined ? {} : { retain: options.retain }),
      mode: 'embedded',
      detail: 'in-process change feed — set DATABASE_URL to decode a real WAL',
      slot: null,
      // Single-process mutual exclusion, which is all one process needs and all it can enforce.
      lock: new InMemoryAdvisoryLock(replicatorLockKey(DEFAULT_REPLICATION_SLOT)),
    };
  }

  if (replicationUrl !== undefined && databaseUrl !== undefined) {
    assertSameDatabase(replicationUrl, databaseUrl);
  }

  const slot = nonEmpty(env['REPLICATION_SLOT']) ?? DEFAULT_REPLICATION_SLOT;
  return {
    // Slot and publication are validated inside the feed, against the same identifier rule the
    // replication command needs — a second copy of that regex here is a second thing to keep true.
    feed: new PgLogicalReplicationFeed({
      url,
      slot,
      publication: nonEmpty(env['REPLICATION_PUBLICATION']) ?? DEFAULT_REPLICATION_PUBLICATION,
      entities: options.entities,
      clock: options.clock,
      rng: options.rng,
      stream: options.stream,
    }),
    mode: 'external',
    detail: replicationUrl === undefined ? 'DATABASE_URL' : 'REPLICATION_URL',
    slot,
    // Taken on the same database the feed reads, so the lock and the slot cannot end up in
    // different places — which is the only way "exactly one replicator" could quietly become two.
    lock: new PgAdvisoryLock({
      url,
      key: replicatorLockKey(slot),
      stream: options.stream,
      rng: options.rng,
    }),
  };
}
