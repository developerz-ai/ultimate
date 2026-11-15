// Which store backs a framework seam in this process — the in-memory one or the database — decided
// once. Three apps each wrote the ternary with a different predicate, and under `x dev` one seam
// sat in memory while every repository read the embedded Postgres. A process that knows better than
// its environment — `x exercise`, a test process on a migrated scratch database — declares it.

import { assert } from './assert';
import { asyncContext } from './async-context';
import { resolveEnvironment } from './environment';

export const STORE_MODES = ['memory', 'database'] as const;

export type StoreMode = (typeof STORE_MODES)[number];

/**
 * The process slot `withStoreMode` writes: the declared mode and the call that declared it. On
 * `globalThis` under a registered symbol rather than a module `let`: an app's modules and the CLI
 * may hold two copies of core, and both must read it.
 */
const DECLARED: unique symbol = Symbol.for('ultimate.store-mode');

interface Declared {
  readonly mode: StoreMode;
  /** The declaring call's identity, in flight in its `work`: what a nested call is inside. */
  readonly owner: object;
}

/** Which declaration the caller's async context is inside — `undefined` outside every one. */
const inside = asyncContext<object>('the declared store mode');

const declared = (): Declared | undefined => {
  const value: unknown = Reflect.get(globalThis, DECLARED);
  if (typeof value !== 'object' || value === null) return undefined;
  const mode: unknown = Reflect.get(value, 'mode');
  const owner: unknown = Reflect.get(value, 'owner');
  if (mode !== 'memory' && mode !== 'database') return undefined;
  return typeof owner === 'object' && owner !== null ? { mode, owner } : undefined;
};

/**
 * The mode `withStoreMode` declared, if any; else `memory` under `test`, `database` everywhere
 * else. The environment and never `DATABASE_URL`:
 * `x dev` installs the embedded PGlite as the process client and sets no URL, and a container
 * gets its pool from the URL — both are `database`. `bun test` installs no client at all, so a
 * statement there would have nothing to reach; that is the one carve-out. An unknown
 * `ULTIMATE_ENV` throws `X_ENVIRONMENT_INVALID`, as `resolveEnvironment` does.
 *
 * `env` is required: the store a module picks at load must be testable without mutating the
 * process environment, so the caller passes `Bun.env`.
 */
export function storeMode(env: Readonly<Record<string, string | undefined>>): StoreMode {
  const active = declared();
  if (active !== undefined) return active.mode;
  return resolveEnvironment({ env }) === 'test' ? 'memory' : 'database';
}

/**
 * `mode` as `storeMode`'s answer for the length of `work`, whatever the environment says — for a
 * process whose stores a module picks at LOAD, so it is process-wide and not async-scoped. Only
 * `x exercise` calls it: a test process (`ULTIMATE_ENV=test`) on a migrated scratch database,
 * where a seam left in memory would make every reach writing it prove nothing. Restored after,
 * thrown or not; nested inside the in-flight one's `work`, the inner one wins until it returns.
 *
 * Any other overlap is refused (`X_INVARIANT`): two declarations side by side restore out of order
 * — A ends and restores nothing, B ends and restores A's — and the process keeps a mode nobody
 * declares any more. One process has one answer, so a second must wait for the first.
 */
export async function withStoreMode<T>(mode: StoreMode, work: () => Promise<T>): Promise<T> {
  const before = declared();
  assert(
    before === undefined || inside.get() === before.owner,
    `withStoreMode('${mode}') started while withStoreMode('${before?.mode ?? mode}') is in flight and not inside its work: the two would restore out of order`,
    `await withStoreMode('${mode}', work)   // after the in-flight one resolves, or from inside its work`,
  );
  const owner = {};
  Reflect.set(globalThis, DECLARED, { mode, owner } satisfies Declared);
  try {
    return await inside.run(owner, work);
  } finally {
    Reflect.set(globalThis, DECLARED, before);
  }
}
