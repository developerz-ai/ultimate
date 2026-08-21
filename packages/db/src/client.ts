// Single responsibility: the Postgres connection and the ambient `db()` handle. Pool size and
// statement timeout are chosen by runtime ROLE — a `worker` draining a queue must not size its
// pool like a `web` process behind a CDN. `Bun.SQL` is reached lazily so importing this module
// never opens a socket (the CLI imports it to print help).

import { type Role, renderThrowable, resolveRole } from '@ultimat3/core';
import { statementAttribution } from './attribution';
import { DbError, dbUnavailable, driverError, poolAcquireTimeout, poolMaxInvalid } from './errors';
import { expectedQueryLoopReason } from './expected-loop';
import { declaresLibpqOption, mergeLibpqOptions } from './libpq-options';
import { statementObserver } from './observe';
import { type SqlFragment, sql } from './sql';
import { withStatementSpan } from './statement-span';
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
  /**
   * How long a statement may **wait for a lock** before `55P03`, distinct from how long it may run.
   * 0 everywhere but `migrate`, which is the only role that takes `ACCESS EXCLUSIVE`: an `alter
   * table` queued behind a long `SELECT` puts every later query on that table behind it too,
   * because Postgres' lock queue is FIFO — and `migrate` runs `statement_timeout = 0`, so nothing
   * else would ever end the wait. Read by `migrate()` as a `SET LOCAL`, never by the pool.
   */
  readonly lockTimeoutMs: number;
  /**
   * How long `reserve()` may wait for a free connection before `X_DB_POOL_EXHAUSTED`. 0 waits
   * forever, which is what a run-once role wants and what a request-serving one must never do:
   * queueing turns exhaustion into a hang, `/readyz`'s `select 1` joins the same queue, the kubelet
   * kills the pod, and the replacement inherits the same saturated database.
   */
  readonly acquireTimeoutMs: number;
}

/** Sized per role because the failure modes differ: RPS bursts vs. queue depth vs. run-once. */
export const POOL_PROFILES = Object.freeze<Record<Role, PoolProfile>>({
  web: {
    max: 20,
    statementTimeoutMs: 10_000,
    idleTimeoutMs: 30_000,
    lockTimeoutMs: 0,
    acquireTimeoutMs: 5_000,
  },
  sync: {
    max: 10,
    statementTimeoutMs: 10_000,
    idleTimeoutMs: 60_000,
    lockTimeoutMs: 0,
    acquireTimeoutMs: 5_000,
  },
  worker: {
    max: 8,
    statementTimeoutMs: 120_000,
    idleTimeoutMs: 30_000,
    lockTimeoutMs: 0,
    acquireTimeoutMs: 10_000,
  },
  scheduler: {
    max: 2,
    statementTimeoutMs: 15_000,
    idleTimeoutMs: 60_000,
    lockTimeoutMs: 0,
    acquireTimeoutMs: 10_000,
  },
  // `migrate` waits: its pool is `max: 1` and the advisory-lock pin holds it for the whole run, so
  // a deadline here would refuse the migration's own session. The wait that needed bounding is the
  // advisory lock's, and `MIGRATION_LOCK_WAIT_MS` bounds it.
  migrate: {
    max: 1,
    statementTimeoutMs: 0,
    idleTimeoutMs: 10_000,
    lockTimeoutMs: 3_000,
    acquireTimeoutMs: 0,
  },
  replicator: {
    max: 4,
    statementTimeoutMs: 0,
    idleTimeoutMs: 60_000,
    lockTimeoutMs: 0,
    acquireTimeoutMs: 0,
  },
});

export function poolProfileFor(role: Role = resolveRole()): PoolProfile {
  return POOL_PROFILES[role];
}

/** The one pool knob an operator can turn without a rebuild. Layered over the role default. */
export const POOL_MAX_ENV = 'DATABASE_POOL_MAX';

/**
 * `DATABASE_POOL_MAX`, or nothing. `POOL_PROFILES` is frozen into the build, so before this the
 * only way to change a fleet's connection count was to ship a new image — and 400 `web` pods at
 * `max: 20` is 8,000 backends against a `max_connections` of 450. An unparseable value **refuses**
 * rather than falling back: a fleet that ignored the number it was given is the failure the
 * variable exists to prevent, and it would only be found in `pg_stat_activity` at 3am.
 */
function poolMaxFromEnv(): Partial<PoolProfile> {
  const raw = process.env[POOL_MAX_ENV];
  if (raw === undefined || raw.trim() === '') return {};
  const max = Number(raw);
  if (!Number.isSafeInteger(max) || max < 1) throw poolMaxInvalid(raw);
  return { max };
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
  // libpq `options` is the portable way to pin a statement timeout for every pooled connection —
  // MERGED into the operator's own, never assigned over it, and emitted for every role including
  // the two whose bound is 0. `set` here dropped a `?options=-c search_path=app` on `web`, `sync`,
  // `worker` and `scheduler` and kept it on `migrate` and `replicator`, so the role that runs the
  // migrations and the role that serves the traffic read different schemas. 0 is a value, not a
  // silence: it is `migrate` saying it may take as long as it takes, and left unsaid a server-side
  // `alter database ... set statement_timeout` kills the one role that must outlive it.
  // `application_name` is a LABEL, not a bound: 'ultimate' is a DEFAULT, and a default may not
  // overwrite what the operator wrote — `?application_name=billing-api` is the filter their
  // `pg_stat_activity` query, their pooler rule and their audit rule all match on, and losing it
  // is silent. Both spellings count, or the URL parameter and a `-c application_name=` in
  // `options` disagree and which one the backend honours is argument order nobody here measured.
  const named = options.applicationName;
  const settings: Record<string, string> = {
    statement_timeout: String(profile.statementTimeoutMs),
  };
  const inOptions = declaresLibpqOption(url.searchParams.get('options'), 'application_name');
  // An explicit `applicationName` is a deliberate call by the role that opened the pool, so it
  // wins. Only then is the setting named to the merge, and only when the operator wrote the other
  // spelling: `mergeLibpqOptions` drops their assignment before appending, so the two cannot
  // disagree — and a URL with no assignment in it keeps the exact `options` it always had.
  if (named !== undefined && inOptions) settings['application_name'] = named;
  const declared = url.searchParams.has('application_name') || inOptions;
  url.searchParams.set('options', mergeLibpqOptions(url.searchParams.get('options'), settings));
  if (named !== undefined) url.searchParams.set('application_name', named);
  else if (!declared) url.searchParams.set('application_name', 'ultimate');
  return url.toString();
}

function rowsOf<T>(result: unknown): readonly T[] {
  return Array.isArray(result) ? (result as readonly T[]) : [];
}

// The command tag only when it counted something, exactly like `rowsOf` in `pglite.ts` — one rule
// across both drivers, so `execute()` and the observer's event cannot answer differently for the
// same statement depending on which database is behind them. A driver that tags a read `0` while
// returning rows would otherwise report 0 here and the row count there.
function affectedBy(result: unknown): number {
  if (!Array.isArray(result)) return 0;
  const count = (result as { count?: unknown }).count;
  return typeof count === 'number' && count > 0 ? count : result.length;
}

/**
 * `pool.reserve()` under a deadline. Without one an exhausted pool does not fail, it **queues** —
 * so a slow endpoint filling all 20 slots turns every later request, `/readyz`'s `select 1`
 * included, into a wait with no end and no error, and the pod is killed for being unready rather
 * than answering 503 for the requests it cannot serve.
 *
 * The losing reservation is released, never dropped: the pool hands out a connection whenever one
 * frees, deadline or no deadline, and a pin nobody holds is a connection nobody gets back. That is
 * the whole reason this is not a bare `Promise.race`.
 */
async function reserveWithin(
  pool: Pick<BunSqlDriver, 'reserve'>,
  profile: PoolProfile,
): Promise<BunSqlReserved> {
  const budget = profile.acquireTimeoutMs;
  if (budget <= 0) return pool.reserve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const pending = pool.reserve();
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(poolAcquireTimeout(budget, profile.max));
        }, budget);
        // The deadline must not be what keeps a finished process alive.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Attached unconditionally so a rejection arriving after we gave up is handled, not unhandled.
    void pending.then(
      (late) => {
        if (expired) late.release();
      },
      () => undefined,
    );
  }
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
      // `driverError`, not `dbUnavailable`: the SQLSTATE has always been on this error and nothing
      // read it, so a `23505` from two clicks racing a signup told the operator the database was
      // unreachable and paged on-call for an outage that never happened. Everything the table does
      // not classify is still `X_DB_UNAVAILABLE`, byte for byte.
      throw driverError(`statement failed: ${fragment.text.slice(0, 120)}`, error);
    }
  }

  /**
   * The funnel — pooled and pinned statements both arrive here, which is why the observer hangs
   * off this one function and nowhere else. Uninstalled it costs one property read and one
   * branch: no clock read, no span, no event object, and `sendOn` receives exactly the call `runOn`
   * made before the seam existed (axiom 6).
   */
  async function runOn(
    driver: Pick<BunSqlDriver, 'unsafe'>,
    fragment: SqlFragment,
  ): Promise<unknown> {
    const observer = statementObserver();
    if (observer === undefined) return sendOn(driver, fragment);
    // Read here, not by the consumer: the scope is gone by the time a per-request detector judges
    // what it collected, so the reason has to be captured with the statement it defends.
    const expected = expectedQueryLoopReason();
    // Same moment, same argument: `postgresRepo` is several frames and a microtask above this one,
    // and what it knows — the entity and the operation — is what turns fifty identical `select`s
    // into "50× findById on members". Absent for hand-written SQL, a migration, a health probe.
    const attribution = statementAttribution();
    const started = performance.now();
    let result: unknown;
    try {
      // The span wraps the send and nothing else, so its duration is the statement's and the
      // observer's own work is not charged to the database.
      result = await withStatementSpan(fragment.text, () => sendOn(driver, fragment));
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
      rows: affectedBy(result),
      attribution,
      expected,
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
 * it, so `POOL_PROFILES` was the last word in a deployed image.
 */
export function baseClient(): DbClient {
  if (ambient === undefined) ambient = createPostgresClient({ profile: poolMaxFromEnv() });
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
      // `renderThrowable`, never `error.message`: the probe wants a report, and a render that
      // throws is an exception out of `/readyz` — the one caller that cannot catch it.
      error: renderThrowable(error),
    };
  }
}
