// Single responsibility: the embedded development database — Postgres compiled to WASM, running
// inside this process, so `x dev` needs no Docker, no DATABASE_URL and no container to wait for.
// The module is resolved at first query and never at import: it is an OPTIONAL peer, and an image
// that only ever talks to a managed Postgres must not carry 26 MB of WASM it will never load.

import type { DbConnection, ReservableClient } from './client';
import { DbError, dbUnavailable } from './errors';
import { createTurnQueue } from './pglite-turns';
import type { SqlFragment } from './sql';
import { currentTx } from './transaction';

/** What PGlite answers with. `rows` is empty for a write, which is why the count is separate. */
export interface PgliteResult {
  readonly rows: readonly unknown[];
  /** Postgres' command-tag count — the only truthful answer for INSERT/UPDATE/DELETE. */
  readonly affectedRows?: number | undefined;
}

/** The slice of PGlite we need. Declared structurally — this package has no dependencies. */
export interface PgliteDriver {
  query(text: string, values?: readonly unknown[]): Promise<PgliteResult>;
  exec?(text: string): Promise<unknown>;
  close(): Promise<void>;
}

/** The one export taken off `@electric-sql/pglite`. */
export interface PgliteModule {
  readonly PGlite: new (dataDir?: string) => PgliteDriver;
}

/** Returns the module namespace. Unknown, not typed, because it is validated before use. */
export type PgliteLoader = () => Promise<unknown>;

export interface PgliteOptions {
  /** `memory://` (default) or a directory. Branches are a directory per branch. */
  readonly dataDir?: string | undefined;
  /** Inject a driver — tests do this so no test needs the WASM build. */
  readonly driver?: PgliteDriver | undefined;
  /** Swap the module loader. Tests use it; nothing in the framework does. */
  readonly load?: PgliteLoader | undefined;
}

export const PGLITE_FIX =
  'bun add @electric-sql/pglite, or set DATABASE_URL to a Postgres server and re-run';

/** Postgres with no filesystem behind it: the default, and what a test wants. */
export const PGLITE_MEMORY = 'memory://';

const PGLITE_URL = 'pglite://';

const PGLITE_PACKAGE = '@electric-sql/pglite';

/**
 * The specifier is held in a variable on purpose: a literal would make every consumer's `tsc`
 * resolve an optional peer that is legitimately absent, and every bundler inline it.
 */
const importPglite: PgliteLoader = () => import(PGLITE_PACKAGE);

const missing = (cause: string, sourceError?: unknown): DbError =>
  new DbError({ code: 'X_DB_UNAVAILABLE', cause, fix: PGLITE_FIX, sourceError });

/**
 * `pglite://<dir>` and `pglite://memory/<name>` — the URLs `x dev` and the test template already
 * print — read back as the dataDir the driver takes. One parser, so no caller invents a second.
 */
export function pgliteDataDir(url: string): string {
  if (!url.startsWith(PGLITE_URL)) return url;
  const rest = url.slice(PGLITE_URL.length);
  return rest === '' || rest === 'memory' || rest.startsWith('memory/') ? PGLITE_MEMORY : rest;
}

function pgliteConstructor(loaded: unknown): PgliteModule['PGlite'] {
  const exported = (loaded as { readonly PGlite?: unknown } | null | undefined)?.PGlite;
  if (typeof exported !== 'function') {
    throw missing(`${PGLITE_PACKAGE} resolved but exports no PGlite constructor`);
  }
  return exported as PgliteModule['PGlite'];
}

/** Boots one embedded Postgres. Costs seconds — `createPgliteClient` calls it exactly once. */
export async function loadPgliteDriver(options: PgliteOptions = {}): Promise<PgliteDriver> {
  if (options.driver !== undefined) return options.driver;
  const dataDir = options.dataDir ?? PGLITE_MEMORY;
  let loaded: unknown;
  try {
    loaded = await (options.load ?? importPglite)();
  } catch (error) {
    throw missing(`${PGLITE_PACKAGE} is not installed, so there is no embedded database`, error);
  }
  const PGlite = pgliteConstructor(loaded);
  try {
    return new PGlite(dataDir);
  } catch (error) {
    throw missing(`PGlite could not open its data directory (dataDir=${dataDir})`, error);
  }
}

/**
 * Reservable, and that is the whole point of the binding: `withTransaction` and `readOnlyQuery`
 * both pin a connection before they `BEGIN`, and a client that cannot be pinned silently gets a
 * shared one — which on a single-session database is every concurrent transaction at once.
 */
export interface PgliteClient extends ReservableClient {
  /** Pay the boot up front. `x dev` calls it so the first request is not the slow one. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** Lazily boots: constructing a client opens nothing, exactly like `createPostgresClient`. */
export function createPgliteClient(options: PgliteOptions = {}): PgliteClient {
  // One in-flight boot, shared. PGlite takes seconds to start, so two concurrent first queries
  // would otherwise build two instances over the same data directory and orphan one of them.
  let booting: Promise<PgliteDriver> | undefined;
  const turns = createTurnQueue();

  function connect(): Promise<PgliteDriver> {
    booting ??= loadPgliteDriver(options).catch((error: unknown) => {
      // A failed boot must not be cached: the fix is `bun add`, and then this has to work.
      booting = undefined;
      throw error;
    });
    return booting;
  }

  async function statement(driver: PgliteDriver, fragment: SqlFragment): Promise<PgliteResult> {
    try {
      return await driver.query(fragment.text, fragment.values);
    } catch (error) {
      throw dbUnavailable(`statement failed: ${fragment.text.slice(0, 120)}`, error);
    }
  }

  async function run(fragment: SqlFragment): Promise<PgliteResult> {
    const driver = await connect();
    // A statement issued inside an open transaction is already inside it — there is one
    // connection and that transaction is holding the turn, so waiting for a turn we are already
    // inside of would hang. `handle.enqueue(input, { outbox: false })` within `withTransaction`
    // is the shape that reaches this line; on a pooled server it would get its own connection,
    // and here it joins the caller's transaction because a second connection does not exist.
    if (currentTx() !== undefined) return statement(driver, fragment);
    return turns.run(() => statement(driver, fragment));
  }

  const rowsOf = (result: PgliteResult): number => result.affectedRows ?? result.rows.length;

  return {
    async query<T>(fragment: SqlFragment): Promise<readonly T[]> {
      return (await run(fragment)).rows as readonly T[];
    },
    async one<T>(fragment: SqlFragment): Promise<T | null> {
      const { rows } = await run(fragment);
      return (rows[0] as T | undefined) ?? null;
    },
    async execute(fragment: SqlFragment): Promise<number> {
      return rowsOf(await run(fragment));
    },
    async reserve(): Promise<DbConnection> {
      const driver = await connect();
      // Held until `release()`, so every statement between `BEGIN` and `COMMIT` is this caller's
      // and no other unit of work can interleave one of its own.
      const turn = await turns.take();
      return {
        query: async <T>(fragment: SqlFragment) =>
          (await statement(driver, fragment)).rows as readonly T[],
        one: async <T>(fragment: SqlFragment) =>
          ((await statement(driver, fragment)).rows[0] as T | undefined) ?? null,
        execute: async (fragment: SqlFragment) => rowsOf(await statement(driver, fragment)),
        release: turn,
      };
    },
    async ping(): Promise<void> {
      await connect();
    },
    async close(): Promise<void> {
      const pending = booting;
      booting = undefined;
      // A boot that never finished has nothing to close, and re-throwing its failure here would
      // mask whatever the process was actually shutting down for.
      await pending?.then(
        (driver) => driver.close(),
        () => undefined,
      );
    },
  };
}
