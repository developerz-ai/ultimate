// Which store backs a framework seam in this process — the in-memory one or the database — decided
// once. Three apps each wrote the ternary with a different predicate, and under `x dev` one seam
// sat in memory while every repository read the embedded Postgres. A process that knows better than
// its environment — `x exercise`, a test process on a migrated scratch database — declares it.

import { resolveEnvironment } from './environment';

export const STORE_MODES = ['memory', 'database'] as const;

export type StoreMode = (typeof STORE_MODES)[number];

/**
 * The process slot `withStoreMode` writes. On `globalThis` under a registered symbol rather than a
 * module `let`: an app's modules and the CLI may hold two copies of core, and both must read it.
 */
const DECLARED: unique symbol = Symbol.for('ultimate.store-mode');

/**
 * The mode `withStoreMode` declared, if any; else `memory` under `test`, `database` everywhere else. The environment and never `DATABASE_URL`:
 * `x dev` installs the embedded PGlite as the process client and sets no URL, and a container
 * gets its pool from the URL — both are `database`. `bun test` installs no client at all, so a
 * statement there would have nothing to reach; that is the one carve-out. An unknown
 * `ULTIMATE_ENV` throws `X_ENVIRONMENT_INVALID`, as `resolveEnvironment` does.
 *
 * `env` is required: the store a module picks at load must be testable without mutating the
 * process environment, so the caller passes `Bun.env`.
 */
export function storeMode(env: Readonly<Record<string, string | undefined>>): StoreMode {
  const declared = Reflect.get(globalThis, DECLARED);
  if (declared === 'memory' || declared === 'database') return declared;
  return resolveEnvironment({ env }) === 'test' ? 'memory' : 'database';
}

/**
 * `mode` as `storeMode`'s answer for the length of `work`, whatever the environment says — for a
 * process whose stores a module picks at LOAD, so it is process-wide and not async-scoped. Only
 * `x exercise` calls it: a test process (`ULTIMATE_ENV=test`) on a migrated scratch database,
 * where a seam left in memory would make every reach writing it prove nothing. Restored after,
 * thrown or not; nested, the inner one wins until it returns.
 */
export async function withStoreMode<T>(mode: StoreMode, work: () => Promise<T>): Promise<T> {
  const before: unknown = Reflect.get(globalThis, DECLARED);
  Reflect.set(globalThis, DECLARED, mode);
  try {
    return await work();
  } finally {
    Reflect.set(globalThis, DECLARED, before);
  }
}
