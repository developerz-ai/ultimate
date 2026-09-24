// Single responsibility: the four questions asked of a database BEFORE `START_REPLICATION`. Two
// refuse the boot with the exact statement that fixes them, one — the publication — is answered by
// ensuring it (`pg-publication.ts`), and the fourth warns, because refusing it would stop every app
// on the default replica identity from starting.

import { logger } from '@ultimat3/core';
import { ReplicaIdentityError, ReplicationFailedError } from './errors';
import type { PgConnection } from './pg-connection';
import { assertIdentifier } from './pg-identifier';
import { ensurePublication } from './pg-publication';

/**
 * The four things that are always misconfigured. `wal_level` and the slot produce an unreadable
 * server message if left to the server, so each gets its own `fix:` line; the publication is
 * created or extended here, and refused with its statement only when this role may not; the
 * fourth is `warnPartialIdentity` and only warns. `slot` and `publication` are interpolated into
 * simple queries, so the identifier charset is the injection boundary; re-asserted here rather than trusted, so the guarantee
 * travels with the function instead of living only in `start()`.
 */
export async function preflight(
  connection: PgConnection,
  slot: string,
  publication: string,
  entities: ReadonlySet<string>,
): Promise<void> {
  assertIdentifier('slot', slot);
  assertIdentifier('publication', publication);
  const [walLevel] = await connection.query('SHOW wal_level');
  if (walLevel?.[0] !== 'logical') {
    throw new ReplicationFailedError({
      stage: 'preflight',
      detail: `wal_level is "${walLevel?.[0] ?? 'unknown'}", so the server writes no logical WAL`,
      // Not `ALTER SYSTEM`: managed and operator-run Postgres refuse it, and the setting lives in
      // the provider's configuration. The setting, where it goes, and that it needs a restart.
      fix: "set wal_level=logical in the server configuration — postgresql.conf, your managed provider's database flags, or `postgres -c wal_level=logical` on a container — then restart postgres",
    });
  }
  await ensurePublication(connection, publication, entities);
  await warnPartialIdentity(connection, entities);
  const [existing] = await connection.query(
    `SELECT plugin FROM pg_replication_slots WHERE slot_name = '${slot}'`,
  );
  if (existing === undefined) {
    // Plain SQL rather than CREATE_REPLICATION_SLOT: the replication command exports a snapshot
    // that pins xmin for the session, and its option syntax changed in postgres 15.
    await connection.query(`SELECT pg_create_logical_replication_slot('${slot}', 'pgoutput')`);
    return;
  }
  if (existing[0] !== 'pgoutput') {
    throw new ReplicationFailedError({
      stage: 'preflight',
      detail: `slot "${slot}" decodes with "${existing[0] ?? 'unknown'}", not pgoutput`,
      fix: `SELECT pg_drop_replication_slot('${slot}'); -- then start the replicator again`,
    });
  }
}

/**
 * The fourth preflight question, and the one that does NOT refuse: which entity tables have NO
 * replica identity. Once such a table is in the publication, Postgres refuses its UPDATE and
 * DELETE outright, and a change could not be keyed if it did not. A table with a primary key is
 * not named: under DEFAULT a delete carries its key, and a live query decides against the whole
 * row its shared window holds, never against `change.before` alone.
 *
 * It runs BEFORE `pg_create_logical_replication_slot`: a slot decodes with the identity the
 * catalog held when the rows were written, so asking after the slot exists answers about a stream
 * nobody is reading yet. It WARNS rather than throws, as it always has — a replicator that will
 * not start is worse than the tables it is naming.
 *
 * Entity names are the ones the constructor already put through `assertIdentifier`, which is what
 * makes both the interpolation and the `fix:` safe; a name postgres answers with that is not in
 * that set is dropped rather than rendered.
 */
async function warnPartialIdentity(
  connection: PgConnection,
  entities: ReadonlySet<string>,
): Promise<void> {
  if (entities.size === 0) return;
  const names = [...entities].map((name) => `'${name}'`).join(', ');
  // NO identity, not "not FULL": `n` (NOTHING), or `d` (DEFAULT) on a table with no primary key.
  // A keyed table replicates correctly under DEFAULT — a delete names its key, and the shared
  // window holds the whole row a live query decides on — so naming it was noise on every boot.
  const rows = await connection.query(
    `SELECT c.relname FROM pg_class c WHERE c.relkind = 'r' AND c.relname IN (${names}) ` +
      `AND (c.relreplident = 'n' OR (c.relreplident = 'd' AND NOT EXISTS ` +
      `(SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary)))`,
  );
  const tables = [
    ...new Set(
      rows
        .map((row) => row[0])
        .filter((name): name is string => typeof name === 'string' && entities.has(name)),
    ),
  ].sort();
  if (tables.length === 0) return;
  const warning = new ReplicaIdentityError({ tables });
  // FIELDS, never interpolation, and the message is the CODE alone — the same rule
  // `@ultimat3/http`'s error-map stage follows, so a log index can be alerted on by code.
  logger.warn(warning.code, { cause: warning.cause, fix: warning.fix, tables });
}
