// Single responsibility: the embedded development database — Postgres compiled to WASM, running
// inside this process, so `x dev` needs no Docker, no DATABASE_URL and no container to wait for.
// The module is resolved at first query and never at import: it is an OPTIONAL peer, and an image
// that only ever talks to a managed Postgres must not carry 26 MB of WASM it will never load.

import { statementAttribution } from './attribution';
import type { DbConnection, ReservableClient } from './client';
import { DbError, driverError } from './errors';
import { expectedQueryLoopReason } from './expected-loop';
import { statementObserver } from './observe';
import { createTurnQueue } from './pglite-turns';
import type { SqlFragment } from './sql';
import { statementExcerpt } from './statement-excerpt';
import { withStatementSpan } from './statement-span';
import { inLiveTx } from './transaction';

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

// PGlite counts MODIFIED rows, so a SELECT that returned rows still reports `affectedRows: 0` —
// `??` would answer 0 for every read and disagree with `PostgresClient.execute`. A write that
// modified nothing returned no rows either, so falling back to the row count stays 0 there. One
// definition, shared: `execute()` and the observer's event must not disagree about how many rows a
// statement accounted for.
function rowsOf(result: PgliteResult): number {
  return result.affectedRows !== undefined && result.affectedRows > 0
    ? result.affectedRows
    : result.rows.length;
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

  /** The send itself: one statement on the session, every driver failure typed on the way out. */
  async function send(driver: PgliteDriver, fragment: SqlFragment): Promise<PgliteResult> {
    try {
      return await driver.query(fragment.text, fragment.values);
    } catch (error) {
      // `driverError`, as `statement-funnel.ts` already does for Bun's driver: this site passed
      // every failure to `dbUnavailable`, so under `x dev` — which IS this driver when no
      // `DATABASE_URL` is set — a `select` naming a column whose migration had not run answered
      // "cannot reach the database" with the fix "set DATABASE_URL", against a database that was
      // answering fine (measured 2026-09-05). PGlite carries the SQLSTATE on `code`.
      throw driverError(statementExcerpt(fragment.text), error);
    }
  }

  /**
   * The funnel — queued, in-transaction and pinned statements all arrive here, so the observer
   * hangs off this one function and nowhere else. Uninstalled it costs one property read and one
   * branch: no clock read, no span, no event object, and `send` receives exactly the call
   * `statement` made before the seam existed (axiom 6). Same shape as `runOn` in `client.ts`, one
   * driver up.
   */
  async function statement(driver: PgliteDriver, fragment: SqlFragment): Promise<PgliteResult> {
    const observer = statementObserver();
    if (observer === undefined) return send(driver, fragment);
    // Read here for the same reason as `runOn`: the scope is gone by the time a per-request
    // detector judges what it collected, so the reason travels with the statement it defends.
    const expected = expectedQueryLoopReason();
    // And the pair `postgresRepo` left above this frame, for the same reason again: it is what
    // reports a repository loop as "50× findById on members" rather than as fifty rows of SQL.
    const attribution = statementAttribution();
    const started = performance.now();
    let result: PgliteResult;
    try {
      // The span wraps the send and nothing else, so its duration is the statement's and the
      // observer's own work is not charged to the database.
      result = await withStatementSpan(fragment.text, () => send(driver, fragment));
    } catch (error) {
      // The failing path is observed too — the error is already `X_DB_UNAVAILABLE`, and a throw
      // from `onStatement` replaces it, which is why `observe.ts` says a reporting-only observer
      // must not throw.
      observer.onStatement({
        text: fragment.text,
        values: fragment.values,
        durationMs: performance.now() - started,
        rows: 0,
        error,
        attribution,
        expected,
      });
      throw error;
    }
    // Outside the `try` deliberately: a throw from `onStatement` is the observer's, not the
    // database's, and catching it above would report a statement that succeeded as failed.
    observer.onStatement({
      text: fragment.text,
      values: fragment.values,
      durationMs: performance.now() - started,
      rows: rowsOf(result),
      attribution,
      expected,
    });
    return result;
  }

  async function run(fragment: SqlFragment): Promise<PgliteResult> {
    const driver = await connect();
    // A statement issued inside an open transaction is already inside it — there is one
    // connection and that transaction is holding the turn, so waiting for a turn we are already
    // inside of would hang. `handle.enqueue(input, { outbox: false })` within `withTransaction`
    // is the shape that reaches this line; on a pooled server it would get its own connection,
    // and here it joins the caller's transaction because a second connection does not exist.
    //
    // The fence is the transaction's LIVENESS, never the ALS store's presence: the store rides
    // into every promise chain started inside `withTransaction`, so a statement the app forgot to
    // `await` still found one after COMMIT, skipped the queue, and landed inside whichever unit of
    // work held the session next — a stray statement in someone else's transaction, committed or
    // rolled back with it, with no error anywhere. A closed scope falls through and takes its own
    // turn, exactly as `client.ts`'s released pin sends a late statement back to the pool.
    if (inLiveTx()) return statement(driver, fragment);
    return turns.run(() => statement(driver, fragment));
  }

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
      let held = true;
      // Direct only while the turn is held — re-queueing behind ourselves would deadlock. Once
      // released the handle has no claim on the connection, and a leaked `tx` writing straight to
      // it would land inside whatever transaction holds it now, with no error to read; so a late
      // statement queues like any other caller and waits for its own turn.
      const on = (fragment: SqlFragment): Promise<PgliteResult> =>
        held ? statement(driver, fragment) : turns.run(() => statement(driver, fragment));
      // Idempotent for free: `turn.release()` is a settled promise's `resolve`, not a counter, so
      // a second call cannot hand out a second turn (`pglite-turns.ts`). `[Symbol.dispose]` below
      // is that same call.
      const release = (): void => {
        held = false;
        turn.release();
      };
      return {
        query: async <T>(fragment: SqlFragment) => (await on(fragment)).rows as readonly T[],
        one: async <T>(fragment: SqlFragment) =>
          ((await on(fragment)).rows[0] as T | undefined) ?? null,
        execute: async (fragment: SqlFragment) => rowsOf(await on(fragment)),
        release,
        [Symbol.dispose]: release,
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
