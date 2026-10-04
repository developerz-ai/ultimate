// Which store backs a framework seam in this process — the in-memory one or the database — decided
// once. Three apps each wrote the ternary with a different predicate, and under `x dev` one seam
// sat in memory while every repository read the embedded Postgres.

import { resolveEnvironment } from './environment';

export const STORE_MODES = ['memory', 'database'] as const;

export type StoreMode = (typeof STORE_MODES)[number];

/**
 * `memory` under `test`, `database` everywhere else. The environment and never `DATABASE_URL`:
 * `x dev` installs the embedded PGlite as the process client and sets no URL, and a container
 * gets its pool from the URL — both are `database`. `bun test` installs no client at all, so a
 * statement there would have nothing to reach; that is the one carve-out. An unknown
 * `ULTIMATE_ENV` throws `X_ENVIRONMENT_INVALID`, as `resolveEnvironment` does.
 *
 * `env` is required: the store a module picks at load must be testable without mutating the
 * process environment, so the caller passes `Bun.env`.
 */
export function storeMode(env: Readonly<Record<string, string | undefined>>): StoreMode {
  return resolveEnvironment({ env }) === 'test' ? 'memory' : 'database';
}
