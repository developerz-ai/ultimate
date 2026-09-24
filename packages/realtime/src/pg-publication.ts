// Single responsibility: the replicator's publication, ensured at boot — created FOR every entity
// table when missing, extended by the entity tables it lacks when present, never shrunk. The one
// way an app gets it: a migration is `x db gen`'s, and `FOR ALL TABLES` needs a superuser.

import { logger, stringField } from '@ultimat3/core';
import { ReplicationFailedError } from './errors';
import type { PgConnection } from './pg-connection';
import { assertIdentifier } from './pg-identifier';
import { REPLICATION_GRANT_WARNING } from './pg-wire';

/** What `ensurePublication` did — `added` is sorted, and empty when the publication was complete. */
export interface PublicationOutcome {
  readonly created: boolean;
  readonly added: readonly string[];
}

/**
 * Ensures `publication` carries every table in `entities`.
 *
 * `FOR TABLE`, because a table's OWNER may publish it without a superuser — and the app role that
 * ran the migrations owns every entity table. Membership is read through `pg_publication_tables`,
 * which also expands `FOR ALL TABLES` and `FOR TABLES IN SCHEMA`, so an operator's broader
 * publication is recognised as complete rather than ALTERed into an error. Cast through `regclass`
 * so a table on the search path compares by the bare name the entity list uses.
 *
 * Never `DROP TABLE` from it: a table the operator added is theirs. A statement the role may not
 * run is refused with the exact statement to run as a role that may — the refusal preflight always
 * raised, now reached only when the boot could not fix it itself.
 */
export async function ensurePublication(
  connection: Pick<PgConnection, 'query'>,
  publication: string,
  entities: ReadonlySet<string>,
): Promise<PublicationOutcome> {
  assertIdentifier('publication', publication);
  const tables = [...entities].map((name) => assertIdentifier('entity', name)).sort();
  const exists = await connection.query(
    `SELECT 1 FROM pg_publication WHERE pubname = '${publication}'`,
  );
  if (exists.length === 0) {
    const create = `CREATE PUBLICATION ${publication} FOR TABLE ${tables.join(', ')}`;
    await attempt(connection, create, `no publication named "${publication}" exists`);
    logger.info('realtime.publication.created', { publication, tables });
    return { created: true, added: tables };
  }
  const members = await connection.query(
    `SELECT (quote_ident(schemaname) || '.' || quote_ident(tablename))::regclass::text ` +
      `FROM pg_publication_tables WHERE pubname = '${publication}'`,
  );
  const present = new Set(members.map((row) => row[0]));
  const missing = tables.filter((name) => !present.has(name));
  if (missing.length === 0) return { created: false, added: [] };
  const alter = `ALTER PUBLICATION ${publication} ADD TABLE ${missing.join(', ')}`;
  await attempt(connection, alter, `publication "${publication}" lacks ${missing.join(', ')}`);
  logger.info('realtime.publication.extended', { publication, tables: missing });
  return { created: false, added: missing };
}

/**
 * Runs `statement`, or refuses with it. Only a server's ErrorResponse is this function's to
 * explain — a dead socket is not a privilege question, so anything else propagates unchanged.
 */
async function attempt(
  connection: Pick<PgConnection, 'query'>,
  statement: string,
  why: string,
): Promise<void> {
  try {
    await connection.query(statement);
  } catch (error) {
    if (!(error instanceof ReplicationFailedError)) throw error;
    const server = stringField(error, 'cause') ?? 'the server refused it';
    const [role] = await connection.query('SELECT current_user');
    throw new ReplicationFailedError({
      stage: 'preflight',
      detail: `${why}, and this role could not ${statement.split(' ')[0]?.toLowerCase()} it: ${server}`,
      fix: statementFix(statement, role?.[0]),
    });
  }
}

/**
 * The statement to run as a role that owns the tables, plus the `REPLICATION` role attribute
 * streaming needs — which no fix line named until one did. Every name in `statement` already
 * passed `assertIdentifier`; the role is quoted, because a role name is whatever the operator chose.
 */
function statementFix(statement: string, role: string | null | undefined): string {
  const who =
    typeof role === 'string' && role !== '' ? `"${role.replaceAll('"', '""')}"` : 'CURRENT_USER';
  return (
    `${statement}; -- as a role that owns those tables and holds CREATE on the database, then restart the replicator. ` +
    `And, if the role cannot stream yet: ALTER ROLE ${who} WITH REPLICATION; -- ` +
    REPLICATION_GRANT_WARNING
  );
}
