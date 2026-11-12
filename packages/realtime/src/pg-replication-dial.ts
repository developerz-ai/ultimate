// Single responsibility: bring one replication stream up — open the walsender session, preflight
// it, and START_REPLICATION from the right place — and say whether the resume position it was
// handed still means anything. Reading the stream once it is up is `pg-replication.ts`'s.

import { logger } from '@ultimat3/core';
import type { PostgresChangeFeedOptions } from './changefeed';
import { ReplicationSlotRecreatedError } from './errors';
import { printLsn } from './pg-bytes';
import { PgConnection } from './pg-connection';
import { paramsChannelTables } from './pg-identity-tables';
import { preflight, slotConfirmed } from './pg-preflight';
import { changeLsn, commitPositionOf } from './pg-replication-position';
import { bunPgStream, parsePgUrl } from './pg-socket';

/** The identifiers the stream already put through `assertIdentifier`. */
export interface StreamNames {
  readonly slot: string;
  readonly publication: string;
  readonly entities: ReadonlySet<string>;
}

/**
 * A slot this stream created under a resume position, carried until a dial gets through. A dial
 * that created it and then failed (START_REPLICATION refused, the socket dropped) leaves the next
 * one finding it EXISTING — and the gap no smaller. Owned by the stream, written here.
 */
export interface SlotGap {
  createdUnder: string | null;
}

export interface DialedStream {
  readonly connection: PgConnection;
  /** Where START_REPLICATION began — what the stream confirms until its first commit. */
  readonly confirmed: bigint;
  /** The resume filter for this run: `undefined` once the slot it pointed into is gone. */
  readonly from: string | undefined;
  /** Why every reader must re-read now, or `null` when the stream is continuous. */
  readonly resync: string | null;
  /**
   * The stream delivers every change above this (`ChangeFeedStartOptions.onResume`): the resume
   * filter, or the slot's confirmed position as a change lsn. `null` for a new slot — it begins at
   * the server's current WAL, and what came before it was never streamed.
   */
  readonly resumed: string | null;
}

/**
 * Open, preflight, START_REPLICATION. On any failure after the socket opened, the session is closed
 * before the failure is rethrown: the dial failure explains the boot, a close that also failed
 * does not, and nothing is left holding the slot.
 */
export async function dialReplication(
  options: PostgresChangeFeedOptions,
  names: StreamNames,
  from: string | undefined,
  gap: SlotGap,
): Promise<DialedStream> {
  const target = parsePgUrl(options.url);
  const stream = await (options.stream ?? bunPgStream)(target);
  const connection = await PgConnection.open({
    stream,
    user: target.user,
    password: target.password,
    database: target.database,
    replication: 'database',
    applicationName: `ultimate-replicator:${names.slot}`,
    rng: options.rng,
    ssl: target.ssl,
  });
  try {
    const full = new Set(options.fullIdentityTables ?? paramsChannelTables());
    const slot = await preflight(connection, names.slot, names.publication, names.entities, full);
    // A NEW slot under a resume position is a gap: it starts at the server's current WAL, so the
    // changes between the old confirm and now were never streamed — and after a failover the old
    // position is another server's WAL, so it must neither start the stream nor filter it.
    if (slot === 'created' && from !== undefined) gap.createdUnder ??= from;
    const under = from === undefined ? null : gap.createdUnder;
    const recreated = under !== null;
    const resumeFrom = recreated ? undefined : from;
    if (recreated) {
      const said = new ReplicationSlotRecreatedError({ slot: names.slot, from: under });
      // FIELDS, never interpolation; the message is the CODE alone (`pg-preflight.ts`).
      logger.warn(said.code, { cause: said.cause, fix: said.fix, slot: names.slot, from: under });
    }
    // No resume position on an existing slot: it restarts at its confirmed position, read so the
    // run can say so. Asked for explicitly, which Postgres treats exactly as `0/0`.
    const fromSlot =
      resumeFrom === undefined && slot === 'existing'
        ? await slotConfirmed(connection, names.slot)
        : null;
    const confirmed = resumeFrom === undefined ? (fromSlot ?? 0n) : commitPositionOf(resumeFrom);
    // `<commit>00000000`: no row has sequence 0, so every change of a transaction committing at or
    // after the slot's position is above it — and those are the ones the server sends.
    const resumed = resumeFrom ?? (fromSlot === null ? null : changeLsn(fromSlot, 0));
    await connection.startCopyBoth(
      `START_REPLICATION SLOT ${names.slot} LOGICAL ${printLsn(confirmed)} ` +
        `(proto_version '1', publication_names '${names.publication}', messages 'true')`,
    );
    // Through: the gap is the caller's to say now, and no later dial owes it again.
    gap.createdUnder = null;
    const resync = recreated
      ? `replication slot "${names.slot}" was recreated under resume position ${under}: ` +
        'the changes in between were never streamed'
      : null;
    return { connection, confirmed, from: resumeFrom, resync, resumed };
  } catch (failure) {
    await connection.close().catch(() => undefined);
    throw failure;
  }
}
