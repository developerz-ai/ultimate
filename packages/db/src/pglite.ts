// Single responsibility: the embedded development database — Postgres compiled to WASM, running
// inside this process, so `x dev` needs no Docker, no DATABASE_URL and no container to wait for.
// The module is resolved at first query and never at import: it is an OPTIONAL peer, and an image
// that only ever talks to a managed Postgres must not carry 26 MB of WASM it will never load.

import { statementAttribution } from './attribution';
import { refuseUnsendable } from './bound-parameters';
import type { DbClient, DbConnection, ReservableClient } from './client';
import { refuseRolledBackCommit } from './commit-tag';
import { DbError, driverError } from './errors';
import { expectedQueryLoopReason } from './expected-loop';
import {
  assertListenChannel,
  type DbSubscription,
  type ListeningClient,
  listenUnsupported,
} from './listen';
import { statementObserver } from './observe';
import { PGLITE_INSTANT_PARSERS } from './pg-instant';
import { linkPgliteExtensions, type PgliteExtensionLoader } from './pglite-extensions';
import { PGLITE_PACKAGE } from './pglite-package';
import {
  discardSnapshot,
  pgliteVersion,
  readSnapshot,
  snapshotFile,
  snapshotKey,
  writeSnapshot,
} from './pglite-snapshot';
import { createTurnQueue } from './pglite-turns';
import type { SqlFragment } from './sql';
import { statementExcerpt } from './statement-excerpt';
import { withStatementSpan } from './statement-span';
import { liveTxConnection } from './transaction';

/** What PGlite answers with. `rows` is empty for a write, which is why the count is separate. */
export interface PgliteResult {
  readonly rows: readonly unknown[];
  /** Postgres' command-tag count — the only truthful answer for INSERT/UPDATE/DELETE. */
  readonly affectedRows?: number | undefined;
  /** The command tag's verb. `ROLLBACK` in answer to a `COMMIT` is how an aborted one reads. */
  readonly command?: string | undefined;
}

/** The slice of PGlite we need. Declared structurally — this package has no dependencies. */
export interface PgliteDriver {
  query(text: string, values?: readonly unknown[]): Promise<PgliteResult>;
  exec?(text: string): Promise<unknown>;
  /** `LISTEN` on the one session there is. Resolves to the unsubscribe. */
  listen?(channel: string, callback: (payload: string) => void): Promise<() => Promise<void>>;
  /** The whole data directory as one tarball — what `pglite-snapshot.ts` caches. */
  dumpDataDir?(compression: 'none'): Promise<Blob>;
  close(): Promise<void>;
}

/** The one export taken off `@electric-sql/pglite`. */
export interface PgliteModule {
  readonly PGlite: new (
    dataDir?: string,
    options?: {
      readonly parsers?: Readonly<Record<number, (text: string) => unknown>>;
      /** Keyed by the bundle's own export name; each value is opaque to this package. */
      readonly extensions?: Readonly<Record<string, unknown>>;
      /** A `dumpDataDir()` tarball to start from instead of running `initdb`. */
      readonly loadDataDir?: Blob;
    },
  ) => PgliteDriver;
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
  /**
   * Extensions to make available to `create extension`, by their Postgres names (`citext`,
   * `uuid-ossp`). PGlite links an extension only when it is handed over at boot, so a migration
   * that creates one fails on an instance that was not told. A function, for a caller whose list
   * is read from disk: a client is constructed synchronously and boots on its first statement.
   * A name PGlite ships no bundle for is skipped here and refused by the server at
   * `create extension`, in its own words (`pglite-extensions.ts`).
   */
  readonly extensions?: readonly string[] | (() => Promise<readonly string[]>) | undefined;
  /** Swap the extension bundle loader, by module specifier. Tests use it. */
  readonly loadExtension?: PgliteExtensionLoader | undefined;
  /**
   * A directory to keep the post-`initdb` snapshot in, so an in-memory boot is a restore
   * (`pglite-snapshot.ts`). Read only for `memory://`: a directory on disk is its own snapshot.
   */
  readonly snapshotDir?: string | undefined;
  /** Swap how the installed PGlite version is read. Tests use it; `undefined` disables caching. */
  readonly version?: (() => Promise<string | undefined>) | undefined;
}

export const PGLITE_FIX =
  'bun add @electric-sql/pglite, or set DATABASE_URL to a Postgres server and re-run';

/** Postgres with no filesystem behind it: the default, and what a test wants. */
export const PGLITE_MEMORY = 'memory://';

const PGLITE_URL = 'pglite://';

// Re-exported: `src/index.ts` and `x doctor` read it from here, and the constant itself lives in
// a leaf so the extension linker and the snapshot cache can share it without a cycle.
export { PGLITE_PACKAGE };

/**
 * Why there is no embedded database when that specifier does not resolve. One sentence, shared:
 * `x doctor` reports this condition BEFORE any query reaches this module, and two wordings for one
 * cause are two answers to "what do I do".
 */
export const PGLITE_MISSING = `${PGLITE_PACKAGE} is not installed, so there is no embedded database`;

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

type PgliteConstructor = PgliteModule['PGlite'];

/**
 * A scratch boot from the cache, or `undefined` when there is nothing sound to restore from. The
 * restored instance is asked one statement before it is believed: a tarball can verify against
 * its checksum and still be one this build cannot open, and that must cost a rebuild, never a
 * failed command.
 */
async function restore(
  PGlite: PgliteConstructor,
  base: { readonly extensions?: Readonly<Record<string, unknown>> },
  file: string,
  key: string,
): Promise<PgliteDriver | undefined> {
  const snapshot = await readSnapshot(file, key);
  if (snapshot === undefined) return undefined;
  let driver: PgliteDriver | undefined;
  try {
    driver = new PGlite(PGLITE_MEMORY, {
      parsers: PGLITE_INSTANT_PARSERS,
      ...base,
      loadDataDir: snapshot,
    });
    await driver.query('select 1');
    return driver;
  } catch {
    await driver?.close().catch(() => undefined);
    await discardSnapshot(file, key);
    return undefined;
  }
}

/** Boots one embedded Postgres. Costs seconds — `pgliteClient` calls it exactly once. */
export async function loadPgliteDriver(options: PgliteOptions = {}): Promise<PgliteDriver> {
  if (options.driver !== undefined) return options.driver;
  const dataDir = options.dataDir ?? PGLITE_MEMORY;
  let loaded: unknown;
  try {
    loaded = await (options.load ?? importPglite)();
  } catch (error) {
    throw missing(PGLITE_MISSING, error);
  }
  const PGlite = pgliteConstructor(loaded);
  const names =
    typeof options.extensions === 'function' ? await options.extensions() : options.extensions;
  const { linked } = await linkPgliteExtensions(names ?? [], options.loadExtension);
  // Absent, never `{}`: every boot that names no extension hands PGlite exactly what it did.
  const base = Object.keys(linked).length === 0 ? {} : { extensions: linked };
  const version =
    options.snapshotDir === undefined || dataDir !== PGLITE_MEMORY
      ? undefined
      : await (options.version ?? pgliteVersion)();
  const key = version === undefined ? undefined : snapshotKey(version);
  const file =
    key === undefined || options.snapshotDir === undefined
      ? undefined
      : snapshotFile(options.snapshotDir, key);
  if (file !== undefined && key !== undefined) {
    const restored = await restore(PGlite, base, file, key);
    if (restored !== undefined) return restored;
  }
  let driver: PgliteDriver;
  try {
    // `pg-instant.ts` reads every timestamp: PGlite's own parser took year 0099 for 1999 and an
    // offset with seconds for Invalid Date under any session zone that is not UTC.
    driver = new PGlite(dataDir, { parsers: PGLITE_INSTANT_PARSERS, ...base });
  } catch (error) {
    throw missing(`PGlite could not open its data directory (dataDir=${dataDir})`, error);
  }
  // Taken before the caller's first statement, so what is cached is `initdb`'s output and nothing
  // of the caller's. A dump that fails leaves no cache and a working database.
  if (file !== undefined && key !== undefined && driver.dumpDataDir !== undefined) {
    try {
      // Uncompressed, by measurement: gzip costs the boot that WRITES the snapshot ~0.3 s of
      // CPU and saves nothing on the one that reads it. A fresh CI checkout always writes, so
      // the cache must cost a cold boot nothing; the price is ~40 MB under `.x/cache`.
      await writeSnapshot(file, key, await driver.dumpDataDir('none'));
    } catch {
      // The boot stands; the next one runs `initdb` again.
    }
  }
  return driver;
}

/**
 * Reservable, and that is the whole point of the binding: `withTransaction` and `readOnlyQuery`
 * both pin a connection before they `BEGIN`, and a client that cannot be pinned silently gets a
 * shared one — which on a single-session database is every concurrent transaction at once.
 */
export interface PgliteClient extends ReservableClient, ListeningClient {
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

/** Lazily boots: constructing a client opens nothing, exactly like `postgresClient`. */
export function pgliteClient(options: PgliteOptions = {}): PgliteClient {
  // One in-flight boot, shared. PGlite takes seconds to start, so two concurrent first queries
  // would otherwise build two instances over the same data directory and orphan one of them.
  let booting: Promise<PgliteDriver> | undefined;
  const turns = createTurnQueue();
  // Every reservation this client handed out — the connections a live transaction on THIS
  // session runs on. Weak, so a released reservation is collected with its scope.
  const issued = new WeakSet<DbClient>();

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
    // Above the `try`, as `sendOn` encodes above its own: a value this package refuses to send is
    // not a driver failure.
    refuseUnsendable(fragment.values);
    let result: PgliteResult;
    try {
      result = await driver.query(fragment.text, fragment.values);
    } catch (error) {
      // `driverError`, as `statement-funnel.ts` already does for Bun's driver: this site passed
      // every failure to `dbUnavailable`, so under `x dev` — which IS this driver when no
      // `DATABASE_URL` is set — a `select` naming a column whose migration had not run answered
      // "cannot reach the database" with the fix "set DATABASE_URL", against a database that was
      // answering fine (measured 2026-09-05). PGlite carries the SQLSTATE on `code`.
      throw driverError(statementExcerpt(fragment.text), error);
    }
    // Outside the `try`, as `sendOn` does it: a COMMIT the server answered with ROLLBACK is a
    // refusal of its own, and `driverError` would re-wrap it as unavailability.
    refuseRolledBackCommit(fragment.text, result);
    return result;
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
    // And only a transaction on THIS client's session: one open on another client says nothing
    // about who holds this queue, and skipping it put the statement inside whatever transaction
    // this session was running — rolled back with it (`pglite-two-clients.test.ts`).
    const live = liveTxConnection();
    if (live !== undefined && issued.has(live)) return statement(driver, fragment);
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
      const connection: DbConnection = {
        query: async <T>(fragment: SqlFragment) => (await on(fragment)).rows as readonly T[],
        one: async <T>(fragment: SqlFragment) =>
          ((await on(fragment)).rows[0] as T | undefined) ?? null,
        execute: async (fragment: SqlFragment) => rowsOf(await on(fragment)),
        release,
        [Symbol.dispose]: release,
      };
      issued.add(connection);
      return connection;
    },
    async listen(channel, onNotify, onListening): Promise<DbSubscription> {
      assertListenChannel(channel);
      const driver = await connect();
      const subscribe = driver.listen?.bind(driver);
      if (subscribe === undefined) throw listenUnsupported('this PGlite driver');
      // A turn of its own: the `LISTEN` is a statement on the one session, and issued beside an
      // open transaction it would ride inside it — rolled back with it, and nothing delivered.
      const stop = await turns.run(() => subscribe(channel, onNotify));
      // One session and no socket to lose: established once, for the life of the client.
      onListening?.();
      let ended: Promise<void> | undefined;
      return {
        unlisten: () => {
          // After `close()` the session is gone and so is the subscription: nothing to report.
          ended ??= turns.run(() => stop()).catch(() => undefined);
          return ended;
        },
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
      // A closed PGlite's WASM heap (~0.5 GB) is returned only when the collector finds it, and
      // a test worker that opens one per file held two or three dead ones at a time. One full
      // collection at close hands it back before the next file boots its own.
      if (pending !== undefined) Bun.gc(true);
    },
  };
}
