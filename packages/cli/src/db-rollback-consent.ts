// What `x db rollback` asks before the first `down` runs, under the migrate lock, of the exact rows
// about to be reversed: every one has a `-- down` half on disk, and outside development the operator
// named each id in `ROLLBACK_ALLOW_DESTRUCTIVE` — the migrate role's own written override.

// why: Bun exposes no path-join primitive.
import { join } from 'node:path';

import { renderFixShellArg, tryResolveEnvironment } from '@ultimat3/core';
import type { LedgerRow, Migration } from '@ultimat3/db';
import { DbError, migrationIrreversible, ROLLBACK_ALLOW_DESTRUCTIVE_ENV } from '@ultimat3/db';
import { MIGRATIONS_DIR, parseMigrationSql } from './migrations';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Development and test reverse freely: the database is the developer's own. Everything else needs
 * the names — staging included, which exists to fail the way production fails — and so does an
 * `ULTIMATE_ENV` that is not an environment: a typo must not read as "not production".
 */
export function rollbackNeedsConsent(env: Env): boolean {
  const environment = tryResolveEnvironment({ env });
  return environment !== 'development' && environment !== 'test';
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
function assertNamed(targets: readonly LedgerRow[], env: Env, steps: number): void {
  if (!rollbackNeedsConsent(env)) return;
  const named = namedIn(env[ROLLBACK_ALLOW_DESTRUCTIVE_ENV]);
  const unnamed = targets.filter((row) => !named.has(row.id)).map((row) => row.id);
  if (unnamed.length === 0) return;
  const all = targets.map((row) => row.id).join(',');
  throw new DbError({
    code: 'X_MIGRATION_ROLLBACK_DESTRUCTIVE',
    cause: `x db rollback would reverse ${String(targets.length)} applied migration(s) outside development, and ${ROLLBACK_ALLOW_DESTRUCTIVE_ENV} does not name ${unnamed.join(', ')} — a down drops what its up added, rows included, under a build that still reads it`,
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

/** `rollback()`'s `confirm`: reversibility first (it is true in every environment), then consent. */
export function rollbackConfirm(
  unmarked: ReadonlySet<string>,
  env: Env,
  steps: number,
): (targets: readonly LedgerRow[]) => void {
  return (targets) => {
    assertReversible(targets, unmarked);
    assertNamed(targets, env, steps);
  };
}
