// Single responsibility: the positions a replication stream speaks — the change lsn it delivers
// under, the commit position a resume restarts from, and the standby status update that tells the
// walsender how far it got. Bytes and spellings only; when to send one is `pg-replication.ts`'s.

import { ByteWriter, epochMsToPgTimestamp } from './pg-bytes';

/** `r` — the standby status update, the only frontend message a walsender listens for. */
const STANDBY_STATUS = 0x72;

/**
 * `<commit lsn><position in transaction>`, both zero-padded hex, so string order is stream order.
 *
 * The commit lsn alone is not enough: every row of one transaction shares it, and the replicator
 * drops anything that does not strictly increase — a five-row insert would deliver one row. The
 * per-record WAL position is not enough either: logical decoding emits *transactions* in commit
 * order, so a later-committing transaction can carry lower record positions than an earlier one.
 * The pair is monotonic in the order changes are delivered and identical on replay, which is what
 * makes an at-least-once redelivery deduplicate instead of duplicating.
 */
export const changeLsn = (commitLsn: bigint, sequence: number): string =>
  commitLsn.toString(16).padStart(16, '0') + sequence.toString(16).padStart(8, '0');

/** The commit position inside a change lsn — where a resume asks the server to restart. */
export const commitPositionOf = (lsn: string): bigint => BigInt(`0x${lsn.slice(0, 16) || '0'}`);

/**
 * Written, flushed and applied all at `position`. `requestReply` asks the walsender to answer at
 * once with a keepalive — what lets the stream measure silence (`pg-replication-liveness.ts`).
 */
export const standbyStatus = (
  position: bigint,
  epochMs: number,
  requestReply: boolean,
): Uint8Array =>
  new ByteWriter(34)
    .uint8(STANDBY_STATUS)
    .int64(position)
    .int64(position)
    .int64(position)
    .int64(epochMsToPgTimestamp(epochMs))
    .uint8(requestReply ? 1 : 0)
    .finish();
