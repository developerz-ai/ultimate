// The four refusals the Postgres replication half raises: the wire, the connection, the slot, and
// the replica identity it warns about.
//
// Split out of `errors.ts` on the one seam this package already draws — these are the only codes
// no browser can reach, thrown by `pg-*.ts` and the replicator and by nothing on the client half.
// The codes themselves stay in `errors.ts`, whose `registerErrorCodes()` is what
// `package.json`'s `sideEffects` names; this module runs nothing at import.

import { RealtimeError } from './realtime-error';

/**
 * The bytes on the replication socket are not the bytes the protocol allows: a truncated message,
 * an unknown pgoutput tag, an auth method we do not speak. Always a version or configuration
 * mismatch rather than a transient fault, so retrying the same connection cannot help.
 */
export class ReplicationProtocolError extends RealtimeError {
  constructor(args: { stage: string; detail: string; fix?: string }) {
    super({
      code: 'X_REPLICATION_PROTOCOL',
      cause: `postgres replication ${args.stage}: ${args.detail}`,
      fix:
        args.fix ??
        'x doctor db — the server must be postgres >= 14 with a pgoutput publication and wal_level=logical',
    });
  }
}

/**
 * The replication connection itself failed — refused credentials, a slot another process holds,
 * an `ErrorResponse` from the server. The server's own message is passed through verbatim
 * because it names the object that has to change.
 */
export class ReplicationFailedError extends RealtimeError {
  constructor(args: { stage: string; detail: string; fix: string }) {
    super({
      code: 'X_REPLICATION_FAILED',
      cause: `postgres replication ${args.stage} failed: ${args.detail}`,
      fix: args.fix,
    });
  }
}

/**
 * A second replicator found the advisory lock held. Distinct from `X_REPLICATION_FAILED` because
 * nothing is wrong with this process: the database already has its one replicator, and a second
 * one that started anyway would publish every change twice. Terminal for a container whose whole
 * job is that role — the scheduler is the thing that has to change, not the connection.
 */
export class ReplicatorSlotHeldError extends RealtimeError {
  constructor(args: { key: string; holder?: string | undefined }) {
    super({
      code: 'X_REPLICATOR_SLOT_HELD',
      cause:
        `advisory lock ${args.key} is held${args.holder === undefined ? '' : ` by ${args.holder}`}` +
        ' — one database has exactly one replicator',
      fix: 'scale the replicator to 1 per database: kubectl scale deploy/replicator --replicas=1',
    });
  }
}

/**
 * A table in the entity list replicates with a replica identity other than FULL, so its `delete`
 * (and any key-changing `update`) carries the KEY COLUMNS ONLY. `toRow` accepts that tuple —
 * it only requires a text `id` — so the live matcher decides "did this row leave the result set"
 * from a one-column row, and a row policy written against `!row.private` reads `undefined`.
 *
 * **Raised at preflight and LOGGED, never thrown.** Every app running today on the default
 * identity would stop booting, and the replicator refusing to start is a worse outcome than the
 * partial rows it is warning about. The runtime half is `ReplicationStreamStats.partialBefore`,
 * which counts the changes this actually affects. Refusing it at `x verify` time is the follow-up.
 *
 * The tables are named because the fix is per table, and they are the entity list's own names —
 * every one has already passed `assertIdentifier`, so the `fix:` is SQL that can be pasted.
 */
export class ReplicaIdentityError extends RealtimeError {
  constructor(args: { tables: readonly string[] }) {
    super({
      code: 'X_LIVE_REPLICA_IDENTITY',
      cause:
        `${args.tables.join(', ')} replicate with a replica identity other than FULL, so a ` +
        'delete carries the key columns only and a live query decides visibility from a partial row',
      fix:
        `${args.tables.map((table) => `ALTER TABLE ${table} REPLICA IDENTITY FULL;`).join(' ')}` +
        ' -- rows already written to the WAL keep the identity they were written with',
    });
  }
}
