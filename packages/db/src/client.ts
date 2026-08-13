// Single responsibility: the Postgres connection and the ambient `db()` handle. Pool size and
// statement timeout are chosen by runtime ROLE — a `worker` draining a queue must not size its
// pool like a `web` process behind a CDN. `Bun.SQL` is reached lazily so importing this module
// never opens a socket (the CLI imports it to print help).

import { type Role, resolveRole } from '@ultimat3/core';
import { dbUnavailable } from './errors';
import { statementObserver } from './observe';
import { type SqlFragment, sql } from './sql';
import { currentTx } from './transaction';

export interface DbClient {
  query<T>(fragment: SqlFragment): Promise<readonly T[]>;
  one<T>(fragment: SqlFragment): Promise<T | null>;
  /** Rows affected. */
  execute(fragment: SqlFragment): Promise<number>;
}

/**
 * A connection pinned out of the pool. `withTransaction` needs one so BEGIN/COMMIT agree.
 * `Disposable`, so `using connection = await client.reserve()` gives the pin back on every exit
 * path — the hand-rolled `finally` is what forgets it on the one path nobody wrote a test for.
 */
export interface DbConnection extends DbClient, Disposable {
  /** Idempotent, and `[Symbol.dispose]` is the same call: releasing twice releases once. */
  release(): void;
}

export interface ReservableClient extends DbClient {
  reserve(): Promise<DbConnection>;
}

export function isReservable(client: DbClient): client is ReservableClient {
  return typeof (client as Partial<ReservableClient>).reserve === 'function';
}

export interface PoolProfile {
  readonly max: number;
  /** 0 disables the timeout — only `migrate`, which is allowed to take as long as it takes. */
  readonly statementTimeoutMs: number;
  readonly idleTimeoutMs: number;
}

/** Sized per role because the failure modes differ: RPS bursts vs. queue depth vs. run-once. */
export const POOL_PROFILES: Readonly<Record<Role, PoolProfile>> = Object.freeze({
  web: { max: 20, statementTimeoutMs: 10_000, idleTimeoutMs: 30_000 },
  sync: { max: 10, statementTimeoutMs: 10_000, idleTimeoutMs: 60_000 },
  worker: { max: 8, statementTimeoutMs: 120_000, idleTimeoutMs: 30_000 },
  scheduler: { max: 2, statementTimeoutMs: 15_000, idleTimeoutMs: 60_000 },
  migrate: { max: 1, statementTimeoutMs: 0, idleTimeoutMs: 10_000 },
  replicator: { max: 4, statementTimeoutMs: 0, idleTimeoutMs: 60_000 },
});

export function poolProfileFor(role: Role = resolveRole()): PoolProfile {
  return POOL_PROFILES[role];
}

/** One connection pinned out of `Bun.SQL`'s pool, released back by hand. */
interface BunSqlReserved {
  unsafe(text: string, values?: readonly unknown[]): Promise<unknown>;
  release(): void;
}

/** The slice of `Bun.SQL` we use. Declared structurally so this package has no dependency. */
interface BunSqlDriver {
  unsafe(text: string, values?: readonly unknown[]): Promise<unknown>;
  reserve(): Promise<BunSqlReserved>;
  close(options?: { readonly timeout?: number }): Promise<void>;
}

type BunSqlFactory = new (url: string, options?: Readonly<Record<string, unknown>>) => BunSqlDriver;

function bunSqlFactory(): BunSqlFactory {
  const host = globalThis as unknown as { readonly Bun?: { readonly SQL?: unknown } };
  const factory = host.Bun?.SQL;
  if (typeof factory !== 'function') {
    throw dbUnavailable('Bun.SQL is unavailable — this package requires Bun >= 1.3');
  }
  return factory as BunSqlFactory;
}

export interface PostgresClientOptions {
  readonly url?: string | undefined;
  readonly role?: Role | undefined;
  readonly profile?: Partial<PoolProfile> | undefined;
  readonly applicationName?: string | undefined;
}

function connectionUrl(options: PostgresClientOptions, profile: PoolProfile): string {
  const raw = options.url ?? process.env['DATABASE_URL'];
  if (raw === undefined || raw === '') {
    throw dbUnavailable('DATABASE_URL is not set, so there is no database to connect to');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw dbUnavailable(`DATABASE_URL is not a valid url: ${raw}`, error);
  }
  // libpq `options` is the portable way to pin a statement timeout for every pooled connection.
  if (profile.statementTimeoutMs > 0) {
    url.searchParams.set('options', `-c statement_timeout=${profile.statementTimeoutMs}`);
  }
  url.searchParams.set('application_name', options.applicationName ?? 'ultimate');
  return url.toString();
}

function rowsOf<T>(result: unknown): readonly T[] {
  return Array.isArray(result) ? (result as readonly T[]) : [];
}

function affectedBy(result: unknown): number {
  if (!Array.isArray(result)) return 0;
  const count = (result as { count?: unknown }).count;
  return typeof count === 'number' ? count : result.length;
}

export interface PostgresClient extends ReservableClient {
  readonly profile: PoolProfile;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** Lazily connects: the pool opens on the first statement, never at import. */
export function createPostgresClient(options: PostgresClientOptions = {}): PostgresClient {
  const role = options.role ?? resolveRole();
  const profile: PoolProfile = { ...poolProfileFor(role), ...(options.profile ?? {}) };
  let driver: BunSqlDriver | undefined;

  function connect(): BunSqlDriver {
    if (driver !== undefined) return driver;
    const url = connectionUrl(options, profile);
    const Factory = bunSqlFactory();
    driver = new Factory(url, { max: profile.max, idleTimeout: profile.idleTimeoutMs / 1000 });
    return driver;
  }

  /** The send itself: one statement on one handle, every driver failure typed on the way out. */
  async function sendOn(
    driver: Pick<BunSqlDriver, 'unsafe'>,
    fragment: SqlFragment,
  ): Promise<unknown> {
    try {
      return await driver.unsafe(fragment.text, fragment.values);
    } catch (error) {
      throw dbUnavailable(`statement failed: ${fragment.text.slice(0, 120)}`, error);
    }
  }

  /**
   * The funnel — pooled and pinned statements both arrive here, which is why the observer hangs
   * off this one function and nowhere else. Uninstalled it costs one property read and one
   * branch: no clock read, no event object, and `sendOn` receives exactly the call `runOn` made
   * before the seam existed (axiom 6).
   */
  async function runOn(
    driver: Pick<BunSqlDriver, 'unsafe'>,
    fragment: SqlFragment,
  ): Promise<unknown> {
    const observer = statementObserver();
    if (observer === undefined) return sendOn(driver, fragment);
    const started = performance.now();
    let result: unknown;
    try {
      result = await sendOn(driver, fragment);
    } catch (error) {
      // A statement that failed is still a statement: fifty identical timeouts are an N+1 of
      // timeouts. The error is already `X_DB_UNAVAILABLE`, so the event carries what the caller
      // is about to be thrown — and an observer that throws here replaces it, which is why
      // `observe.ts` says a reporting-only observer must not throw.
      observer.onStatement({
        text: fragment.text,
        values: fragment.values,
        durationMs: performance.now() - started,
        rows: 0,
        error,
      });
      throw error;
    }
    // Outside the `try` deliberately: a throw from `onStatement` is the observer's, not the
    // database's, and catching it above would report a statement that succeeded as failed.
    observer.onStatement({
      text: fragment.text,
      values: fragment.values,
      durationMs: performance.now() - started,
      rows: affectedBy(result),
    });
    return result;
  }

  async function run(fragment: SqlFragment): Promise<unknown> {
    return runOn(connect(), fragment);
  }

  const client: PostgresClient = {
    profile,
    async query<T>(fragment: SqlFragment): Promise<readonly T[]> {
      return rowsOf<T>(await run(fragment));
    },
    async one<T>(fragment: SqlFragment): Promise<T | null> {
      const rows = rowsOf<T>(await run(fragment));
      return rows[0] ?? null;
    },
    async execute(fragment: SqlFragment): Promise<number> {
      return affectedBy(await run(fragment));
    },
    async reserve(): Promise<DbConnection> {
      // A real pin, not a seam: `Bun.SQL` refuses a bare BEGIN on a pooled handle
      // (`ERR_POSTGRES_UNSAFE_TRANSACTION`), and a BEGIN that landed on a different connection
      // than the statement after it would not be a transaction at all — which is exactly what
      // `withTransaction` and `readOnlyQuery` depend on being true.
      const pool = connect();
      let reserved: BunSqlReserved;
      try {
        reserved = await pool.reserve();
      } catch (error) {
        // Acquiring the pin is the one step that runs outside `runOn`, so an exhausted or
        // unreachable pool would escape as an untyped driver error — and `readOnlyQuery` reaches
        // this line before its first statement, which is how MCP ends up returning something
        // other than X_DB_UNAVAILABLE.
        throw dbUnavailable('could not reserve a connection from the pool', error);
      }
      let held = true;
      // Direct only while the pin is held. `release()` hands this physical connection back, and
      // the pool may already have given it to another unit of work mid-transaction — a statement
      // issued on the stale handle would land inside theirs, committed or rolled back with it and
      // no error anywhere to explain the row. So a late statement takes its own connection out of
      // the pool, exactly like any other caller. Same rule as `pglite.ts`, one driver down.
      const on = (fragment: SqlFragment): Promise<unknown> =>
        held ? runOn(reserved, fragment) : run(fragment);
      // Idempotent because two owners already exist on one exit path: `withTransaction` releases
      // in a `finally` and `[Symbol.dispose]` fires on the same scope. A second `release()` on a
      // handle already back in the pool frees whoever holds that connection now.
      const release = (): void => {
        if (!held) return;
        held = false;
        reserved.release();
      };
      return {
        query: async <T>(fragment: SqlFragment) => rowsOf<T>(await on(fragment)),
        one: async <T>(fragment: SqlFragment) => rowsOf<T>(await on(fragment))[0] ?? null,
        execute: async (fragment: SqlFragment) => affectedBy(await on(fragment)),
        release,
        [Symbol.dispose]: release,
      };
    },
    async ping(): Promise<void> {
      await client.query(sql`select 1`);
    },
    async close(): Promise<void> {
      // Read-then-clear, the same shape as `pglite.ts`: a `close()` that rejects has still torn
      // the pool down, so caching it would hand the next `connect()` a corpse and every statement
      // after it would fail for a reason no caller can see. Clearing first also means a
      // `connect()` racing the await opens a fresh pool instead of joining the one draining. The
      // rejection still reaches the caller — a shutdown that could not drain wants to know.
      const pool = driver;
      driver = undefined;
      await pool?.close();
    },
  };
  return client;
}

let ambient: DbClient | undefined;

/** Test/dev seam. `setDbClient(undefined)` restores lazy construction from `DATABASE_URL`. */
export function setDbClient(client: DbClient | undefined): void {
  ambient = client;
}

/** The pool, ignoring any open transaction. `withTransaction` must not re-enter `db()`. */
export function baseClient(): DbClient {
  if (ambient === undefined) ambient = createPostgresClient();
  return ambient;
}

/**
 * The ambient client. Inside `withTransaction` this is the transaction, so a repository
 * written against `db()` joins the caller's transaction without knowing it exists.
 */
export function db(): DbClient {
  return currentTx() ?? baseClient();
}

/** Named `Db*` because `@ultimat3/core` already exports a `HealthReport` for the lifecycle. */
export interface DbHealthReport {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error?: string | undefined;
}

/** Backs `/readyz` for every role. Never throws — the probe wants a report, not an exception. */
export async function checkDb(client: DbClient = baseClient()): Promise<DbHealthReport> {
  const started = performance.now();
  try {
    await client.query(sql`select 1`);
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
