// @ultimat3/realtime's SERVER-ONLY codes and their titles, registered at import: raised by the
// replicator, the change feed and the node's boot, never by a page and never inside the frame
// router that writes a refusal onto the wire. Kept out of `error-titles.ts`, which is in every
// island chunk; imported bare by `errors.ts` and `server.ts`, and listed in `sideEffects`.

import { registerErrorCodes } from '@ultimat3/core/page';

/** Codes this package owns that no browser can raise or receive. */
export const REALTIME_SERVER_OWNED_ERROR_CODES = [
  'X_REPLICATION_PROTOCOL',
  'X_REPLICATION_FAILED',
  'X_REPLICATOR_SLOT_HELD',
  'X_LIVE_REPLICA_IDENTITY',
  'X_REALTIME_TOPOLOGY',
  'X_REPLICATION_TLS',
  'X_REALTIME_PRODUCER_CONFLICT',
  'X_REPLICATION_SLOT_INVALIDATED',
  'X_REPLICATION_SLOT_RECREATED',
] as const;

export type RealtimeServerErrorCode = (typeof REALTIME_SERVER_OWNED_ERROR_CODES)[number];

export const REALTIME_SERVER_ERROR_TITLES: Readonly<Record<RealtimeServerErrorCode, string>> = {
  X_REPLICATION_PROTOCOL: 'the WAL stream cannot be decoded',
  X_REPLICATION_FAILED: 'the replication connection was refused',
  X_REPLICATOR_SLOT_HELD: 'another replicator already owns this database',
  X_LIVE_REPLICA_IDENTITY: 'a replicated table has no replica identity',
  X_REALTIME_TOPOLOGY: 'a sync node boots on a real database with no reachable change feed',
  X_REPLICATION_TLS: 'the replication connection failed TLS',
  X_REALTIME_PRODUCER_CONFLICT: 'two kinds of producer carry one table on the change bus',
  X_REPLICATION_SLOT_INVALIDATED: 'the replication slot was invalidated',
  X_REPLICATION_SLOT_RECREATED: 'the replication slot was recreated',
};

// One unconditional call, as in `error-titles.ts`: a second claimant throws X_ERROR_CODE_DUPLICATE.
registerErrorCodes(
  Object.fromEntries(
    Object.entries(REALTIME_SERVER_ERROR_TITLES).map(([code, title]) => [code, { title }]),
  ),
);
