// Single responsibility: a WAL position — parsed from the wire, read off the primary after a write,
// and compared against how far a standby has replayed. Read-your-writes across requests is this
// one comparison: a request that carries the position its own write produced is served by a
// replica only once the replica has replayed past it.

import type { Clock } from '@ultimat3/core';
import type { DbClient } from './client';
import { sql } from './sql';

/** A `pg_lsn` is two hex words, `X/Y`, each at most 32 bits. Anything else is not one. */
const LSN = /^([0-9A-Fa-f]{1,8})\/([0-9A-Fa-f]{1,8})$/;

/** How long one answer to "how far has the replica replayed" is reused, per process. */
export const POSITION_CACHE_MS = 50;

/**
 * The position as a 64-bit number, or `undefined` for anything that is not a `pg_lsn`. A value off
 * a cookie or a header is the sender's to choose, so it is parsed and never echoed: a forged one
 * costs its sender a primary read, and nothing it writes reaches SQL or a response.
 */
export function parsePosition(value: string | null | undefined): bigint | undefined {
  if (value === null || value === undefined) return undefined;
  const match = LSN.exec(value.trim());
  if (match === null) return undefined;
  const [, high = '', low = ''] = match;
  return (BigInt(`0x${high}`) << 32n) | BigInt(`0x${low}`);
}

/** The canonical `X/Y` spelling, the one Postgres prints. Only ever applied to a parsed value. */
export function formatPosition(position: bigint): string {
  const high = (position >> 32n).toString(16).toUpperCase();
  const low = (position & 0xffffffffn).toString(16).toUpperCase();
  return `${high}/${low}`;
}

interface PositionRow {
  readonly lsn: string | null;
}

/**
 * The primary's WAL INSERT position, read once after a request that wrote has committed. Not
 * `pg_current_wal_lsn()`, the WRITE position: under `synchronous_commit = off` it trails the
 * commit just made, so a standby replayed exactly that far looked caught up without the row
 * (measured on the test services' standby: write 0/3029ED0, insert 0/302AE80).
 */
export async function primaryPosition(primary: DbClient): Promise<bigint | undefined> {
  const row = await primary.one<PositionRow>(sql`select pg_current_wal_insert_lsn()::text as lsn`);
  return parsePosition(row?.lsn);
}

export interface ReplayReader {
  /** Whether the replica has replayed at least `required`. Unknown answers `false`. */
  caughtUp(required: bigint): Promise<boolean>;
}

interface Sample {
  readonly at: number;
  readonly replayed: Promise<bigint | undefined>;
}

/**
 * One reader per replicated client, so the cache is per process and per standby. A sample is the
 * PROMISE, published before it settles: twenty reads arriving in one tick ask the standby once.
 * `pg_last_wal_replay_lsn()` is `null` on a server that is not in recovery and the query fails on a
 * standby that is down; both are "unknown", which is the primary's — never a guess that it caught up.
 */
export function replayReader(replica: DbClient, clock: Clock, cacheMs: number): ReplayReader {
  let sample: Sample | undefined;
  const read = async (): Promise<bigint | undefined> => {
    try {
      const row = await replica.one<PositionRow>(sql`select pg_last_wal_replay_lsn()::text as lsn`);
      return parsePosition(row?.lsn);
    } catch {
      // Deliberate: a standby that cannot say how far it is serves no read that needs to know. The
      // read goes to the primary, and the breaker hears about the outage from the next plain read.
      return undefined;
    }
  };
  return {
    async caughtUp(required: bigint): Promise<boolean> {
      const now = clock.monotonic();
      if (sample === undefined || now - sample.at >= cacheMs) {
        sample = { at: now, replayed: read() };
      }
      const replayed = await sample.replayed;
      return replayed !== undefined && replayed >= required;
    },
  };
}
