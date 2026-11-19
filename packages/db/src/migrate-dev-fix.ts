// Single responsibility: the `fix:` a migration refusal names on the embedded development database,
// where a deploy's lines cannot run: no image to roll forward to, no `DATABASE_URL` for psql, no git
// history for a migration written a minute ago. Its own module — an environment probe is not a
// refusal — at the cost of one module on `ROLE=migrate`'s pinned graph (`MIGRATE_CEILING`).

import { tryResolveEnvironment } from '@ultimat3/core';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Development, and no `DATABASE_URL`: the database is PGlite under the checkout's `.x/`, which is
 * what `x db reset` rebuilds. The non-throwing read on purpose — this runs while an error is being
 * built, and a typo in `ULTIMATE_ENV` must not replace that error; it reads as "not development".
 * `test` is not development either: a suite's database is the suite's to rebuild.
 */
export function embeddedDev(env: Env = Bun.env): boolean {
  return (
    tryResolveEnvironment({ env }) === 'development' && (env['DATABASE_URL'] ?? '').trim() === ''
  );
}

/**
 * The one command that always ends a ledger this checkout cannot reconcile: rebuild the embedded
 * database from the migrations on disk. `x stop` first because `x db reset` refuses beside a
 * running `x dev` (it holds the data directory), and it exits 0 when none is running — so the line
 * runs as pasted either way. `why` is the caller's: what made the ledger irreconcilable, and what
 * to do instead when the rows matter.
 */
export const embeddedResetFix = (why: string): string =>
  `x stop --json && x db reset   # development: rebuilds the embedded database from the migrations on disk, and its rows are lost (x db seed refills them) — ${why}; then x dev`;
