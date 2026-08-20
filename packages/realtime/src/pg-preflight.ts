// Single responsibility: the four questions asked of a database BEFORE `START_REPLICATION`, and
// the identifier charset every one of them interpolates through. Three refuse the boot with the
// exact statement that fixes them; the fourth warns, because refusing it would stop every app on
// the default replica identity from starting.

import { logger } from '@ultimat3/core';
import { ReplicaIdentityError, ReplicationFailedError } from './errors';
import type { PgConnection } from './pg-connection';

/** Identifiers reach a simple query unparameterised, so the charset is the injection boundary. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * The one gate between a caller-supplied name and a simple query. Exported because
 * `PgReplicationStream` checks its slot, publication and entity names in its CONSTRUCTOR — a
 * mistyped `REPLICATION_SLOT` is a boot-time fact, and finding it at the first WAL read means a
 * replicator that reported itself started and then never delivered a change.
 */
export const assertIdentifier = (kind: string, value: string): string => {
  if (IDENTIFIER.test(value)) return value;
  throw new ReplicationFailedError({
    stage: 'preflight',
    detail: `${kind} "${value}" is not a lower-case postgres identifier`,
    fix: `rename the ${kind} to match [a-z_][a-z0-9_]* — it is interpolated into a replication command`,
  });
};

/**
 * The four things that are always misconfigured. Three produce an unreadable server message if
 * left to the server, so each gets its own `fix:` line; the fourth is `warnPartialIdentity` and
 * only warns. `slot` and `publication` are interpolated into simple queries, so the `IDENTIFIER`
 * charset is the injection boundary; re-asserted here rather than trusted, so the guarantee
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
      fix: "ALTER SYSTEM SET wal_level = 'logical'; -- then restart postgres",
    });
  }
  const publications = await connection.query(
    `SELECT 1 FROM pg_publication WHERE pubname = '${publication}'`,
  );
  if (publications.length === 0) {
    throw new ReplicationFailedError({
      stage: 'preflight',
      detail: `no publication named "${publication}" exists`,
      fix: `CREATE PUBLICATION ${publication} FOR ALL TABLES;`,
    });
  }
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
 * The fourth preflight question, and the one that does NOT refuse. A live query decides whether a
 * row left its result set from `change.before`, and under any replica identity but FULL that tuple
 * is the key columns alone — which `toRow` accepts, since it only requires a text `id`.
 *
 * It runs BEFORE `pg_create_logical_replication_slot`: a slot decodes with the identity the
 * catalog held when the rows were written, so asking after the slot exists answers about a stream
 * nobody is reading yet. It WARNS rather than throws because every app on the default identity
 * would otherwise stop booting, and a replicator that will not start is worse than the partial
 * rows it is complaining about — `ReplicationStreamStats.partialBefore` is the running half.
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
  const rows = await connection.query(
    `SELECT relname FROM pg_class WHERE relkind = 'r' AND relreplident <> 'f' ` +
      `AND relname IN (${names})`,
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
