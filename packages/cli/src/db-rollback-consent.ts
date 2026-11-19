// What `x db rollback` asks before the first `down` runs, under the migrate lock, of the exact rows
// about to be reversed: every one has a `-- down` half on disk, and on a deploy — or a database on
// another machine — the operator named each id in `ROLLBACK_ALLOW_DESTRUCTIVE`.

// why: Bun exposes no path-join primitive.
import { join } from 'node:path';

import { renderFixShellArg, tryResolveEnvironment } from '@ultimat3/core';
import type { LedgerRow, Migration } from '@ultimat3/db';
import { DbError, migrationIrreversible, ROLLBACK_ALLOW_DESTRUCTIVE_ENV } from '@ultimat3/db';
import { namedDeployed } from './framework-env';
import { isLoopbackHostname } from './loopback-host';
import { MIGRATIONS_DIR, parseMigrationSql } from './migrations';
import type { ServiceBinding } from './runtime-bindings';

type Env = Readonly<Record<string, string | undefined>>;

/** The database the rollback runs against: `resolveServices(root, env).db`. */
export type RollbackDatabase = Pick<ServiceBinding, 'mode' | 'url'>;

/**
 * Is `url` a Postgres on another machine? A local socket (no host, or a `host=` that is a path) and
 * a loopback name are this machine's; a URL that does not parse is another's — fail closed.
 */
function remoteDatabase(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  const host = parsed.hostname || (parsed.searchParams.get('host') ?? '');
  if (host === '' || host.startsWith('/')) return false;
  return !isLoopbackHostname(host);
}

/**
 * Who needs the names. A NAMED deploy — `namedDeployed`, framework-env's own predicate: staging
 * included, which exists to fail the way production fails — and an `ULTIMATE_ENV` that is no
 * environment: a typo must not read as "not production". And, whatever the environment resolves
 * to, an external database on another machine: `DATABASE_URL=<prod> x db rollback` from a shell
 * that names nothing resolves development, and reversed production unasked. A developer's own
 * database (embedded, loopback, a local socket) reverses freely.
 */
export function rollbackNeedsConsent(env: Env, database?: RollbackDatabase): boolean {
  if (namedDeployed(env) || tryResolveEnvironment({ env }) === undefined) return true;
  return database?.mode === 'external' && remoteDatabase(database.url);
}

const namedIn = (allow: string | undefined): ReadonlySet<string> =>
  new Set(
    (allow ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== ''),
  );

/**
 * A `down` is the destructive half by construction — reversing `add column` drops it, with every
 * value written since — and the build still serving reads what it removes. So every id is named,
 * not only those whose `up` was destructive: the consent `ledgerAheadOfBuild` takes for an older
 * image over a newer schema, asked here of the schema change itself.
 */
function assertNamed(
  targets: readonly LedgerRow[],
  env: Env,
  steps: number,
  database: RollbackDatabase | undefined,
): void {
  if (!rollbackNeedsConsent(env, database)) return;
  const named = namedIn(env[ROLLBACK_ALLOW_DESTRUCTIVE_ENV]);
  const unnamed = targets.filter((row) => !named.has(row.id)).map((row) => row.id);
  if (unnamed.length === 0) return;
  const all = targets.map((row) => row.id).join(',');
  throw new DbError({
    code: 'X_MIGRATION_ROLLBACK_DESTRUCTIVE',
    cause: `x db rollback would reverse ${String(targets.length)} applied migration(s) on a deployed or remote database, and ${ROLLBACK_ALLOW_DESTRUCTIVE_ENV} does not name ${unnamed.join(', ')} — a down drops what its up added, rows included, under a build that still reads it`,
    fix: `${ROLLBACK_ALLOW_DESTRUCTIVE_ENV}=${renderFixShellArg(all, '<migration id>')} x db rollback --steps ${String(steps)} --json   # names each migration it reverses; first deploy a build that no longer reads what they added`,
    meta: { refused: unnamed, steps },
  });
}

/**
 * The migrations whose file carries no `-- down` marker at all. An EMPTY down under the marker is a
 * reversal that needs no statement — `x db gen` writes one for a deferred `validate constraint` —
 * so the two are told apart by the one reader of the marker: with none, `up` is the whole file.
 */
export async function withoutDown(
  root: string,
  migrations: readonly Migration[],
): Promise<ReadonlySet<string>> {
  const unmarked = new Set<string>();
  for (const migration of migrations) {
    if (migration.down.trim() !== '') continue;
    const text = await Bun.file(join(root, MIGRATIONS_DIR, `${migration.id}.sql`)).text();
    if (parseMigrationSql(migration.id, text).up === text.trim()) unmarked.add(migration.id);
  }
  return unmarked;
}

/** A hand-written migration with no `-- down` half: unrecording it would reverse nothing. */
function assertReversible(targets: readonly LedgerRow[], unmarked: ReadonlySet<string>): void {
  for (const row of targets) {
    // Not on disk at all is `rollback()`'s own refusal (`X_MIGRATION_CONFLICT`), with its fix.
    if (!unmarked.has(row.id)) continue;
    const file = `${MIGRATIONS_DIR}/${renderFixShellArg(row.id, '<id>')}.sql`;
    throw migrationIrreversible(
      `migration "${row.id}" has no "-- down" half, so rolling it back would delete its ledger row and reverse nothing`,
      `edit ${file} — add a line "-- down" and, below it, the SQL that reverses the statements above; then x db rollback`,
    );
  }
}

/**
 * `rollback()`'s `confirm`: reversibility first (it is true in every environment), then consent.
 * `database` is the binding the pass runs against; absent, only the environment is asked.
 */
export function rollbackConfirm(
  unmarked: ReadonlySet<string>,
  env: Env,
  steps: number,
  database?: RollbackDatabase,
): (targets: readonly LedgerRow[]) => void {
  return (targets) => {
    assertReversible(targets, unmarked);
    assertNamed(targets, env, steps, database);
  };
}
