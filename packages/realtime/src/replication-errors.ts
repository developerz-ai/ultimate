// The five refusals the Postgres replication half raises: the wire, the connection, its TLS, the
// slot, and the replica identity it warns about.
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
 * The replication connection failed TLS: the certificate failed the verification the `sslmode`
 * asked for, `sslrootcert` named nothing readable, or the handshake itself failed. Its own code
 * because the fix is a TLS setting, never the network — a certificate refusal used to surface as
 * `X_REPLICATION_FAILED` "the socket refused a 139-byte write", one step after a silent close.
 */
export class ReplicationTlsError extends RealtimeError {
  constructor(args: { detail: string; fix: string }) {
    super({
      code: 'X_REPLICATION_TLS',
      cause: `postgres replication tls failed: ${args.detail}`,
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
 * A table in the entity list has NO replica identity — no primary key under DEFAULT, or
 * `REPLICA IDENTITY NOTHING`. Once it is in the publication Postgres refuses its UPDATE and DELETE
 * (`cannot update table … because it does not have a replica identity and publishes updates`),
 * and a change the replicator did see could not be keyed. A keyed table under DEFAULT is correct
 * and is never named: the shared window holds the whole row a live query decides on.
 *
 * **Raised at preflight and LOGGED, never thrown**, as it always was: a replicator that will not
 * start is worse than the tables it names. The tables are the entity list's own names — every one
 * has already passed `assertIdentifier`, so the `fix:` is SQL that can be pasted.
 */
export class ReplicaIdentityError extends RealtimeError {
  constructor(args: { tables: readonly string[] }) {
    super({
      code: 'X_LIVE_REPLICA_IDENTITY',
      cause:
        `${args.tables.join(', ')} have no replica identity (no primary key, or REPLICA IDENTITY ` +
        'NOTHING), so once published an UPDATE or DELETE on them fails and a change cannot be keyed',
      fix:
        `${args.tables.map((table) => `ALTER TABLE ${table} REPLICA IDENTITY FULL;`).join(' ')}` +
        ' -- or give each a primary key; rows already in the WAL keep the identity they were written with',
    });
  }
}
