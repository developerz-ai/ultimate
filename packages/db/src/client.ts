// Single responsibility: the pooled Postgres client and the ambient `db()` handle — the lazy
// connect, the reserved-connection pin, and the process-wide client every repository reaches
// through. Sizing lives in `pool-profile.ts`, the connection string in `connection-url.ts`, the
// `Bun.SQL` slice in `bun-sql.ts` and the observed statement funnel in `statement-funnel.ts`, so
// importing this module never opens a socket.

import { type Role, resolveRole } from '@ultimat3/core';
import { type BunSqlDriver, type BunSqlReserved, bunSqlFactory } from './bun-sql';
import { connectionUrl } from './connection-url';
// Deliberate cycle, the same shape as `client.ts ⇄ transaction.ts`: nothing here is referenced at
// module evaluation, and both sides are `function` declarations, so hoisting covers the TDZ.
import { defaultClient } from './default-client';
import { DbError, driverError } from './errors';
import { assertPoolProfile, type PoolProfile, poolProfileFor } from './pool-profile';
import { reserveWithin } from './pool-reserve';
import { type SqlFragment, sql } from './sql';
import { affectedBy, rowsOf, runOn } from './statement-funnel';
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

export interface PostgresClientOptions {
  readonly url?: string | undefined;
  readonly role?: Role | undefined;
  readonly profile?: Partial<PoolProfile> | undefined;
  readonly applicationName?: string | undefined;
}

export interface PostgresClient extends ReservableClient {
  readonly profile: PoolProfile;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** Lazily connects: the pool opens on the first statement, never at import. */
export function createPostgresClient(options: PostgresClientOptions = {}): PostgresClient {
  const role = options.role ?? resolveRole();
  const profile: PoolProfile = assertPoolProfile({
    ...poolProfileFor(role),
    ...(options.profile ?? {}),
  });
  let driver: BunSqlDriver | undefined;

  function connect(): BunSqlDriver {
    if (driver !== undefined) return driver;
    const url = connectionUrl(options, profile);
    const Factory = bunSqlFactory();
    driver = new Factory(url, { max: profile.max, idleTimeout: profile.idleTimeoutMs / 1000 });
    return driver;
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
        reserved = await reserveWithin(pool, profile);
      } catch (error) {
        // Acquiring the pin is the one step that runs outside `runOn`, so an exhausted or
        // unreachable pool would escape as an untyped driver error — and `readOnlyQuery` reaches
        // this line before its first statement, which is how MCP ends up returning something
        // other than X_DB_UNAVAILABLE. Our own deadline is already typed; only the driver's own
        // failure needs classifying, and `53300` from the server lands as X_DB_POOL_EXHAUSTED too.
        if (error instanceof DbError) throw error;
        throw driverError('could not reserve a connection from the pool', error);
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

/**
 * The pool, ignoring any open transaction. `withTransaction` must not re-enter `db()`.
 *
 * The role default is layered under `DATABASE_POOL_MAX`, because this is the one place the process
 * builds its own client and therefore the only place an operator's value can reach one:
 * `createPostgresClient` has always taken a `profile` override and nothing in a running app passed
 * it, so `POOL_PROFILES` was the last word in a deployed image. `default-client.ts` owns what gets
 * built — one pool, or a primary and a replica when `DATABASE_REPLICA_URL` names one.
 */
export function baseClient(): DbClient {
  if (ambient === undefined) ambient = defaultClient();
  return ambient;
}

/**
 * The ambient client. Inside `withTransaction` this is the transaction, so a repository
 * written against `db()` joins the caller's transaction without knowing it exists.
 */
export function db(): DbClient {
  return currentTx() ?? baseClient();
}
