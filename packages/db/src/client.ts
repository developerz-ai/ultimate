// Single responsibility: the pooled Postgres client and the ambient `db()` handle — the lazy
// connect, the reserved-connection pin, and the process-wide client every repository reaches
// through. Sizing lives in `pool-profile.ts`, the connection string in `connection-url.ts`, the
// `Bun.SQL` slice in `bun-sql.ts` and the observed statement funnel in `statement-funnel.ts`, so
// importing this module never opens a socket.

import { logger, type Role, resolveRole, type Scheduler } from '@ultimat3/core';
import {
  type BunSqlDriver,
  type BunSqlReserved,
  bunSqlFactory,
  bunSqlPoolOptions,
  releaseReserved,
} from './bun-sql';
import { connectionUrl } from './connection-url';
// Deliberate cycle, the same shape as `client.ts ⇄ transaction.ts`: nothing here is referenced at
// module evaluation, and both sides are `function` declarations, so hoisting covers the TDZ.
import { defaultClient } from './default-client';
import { DbError, dbUnavailable, drainTimeout, driverError } from './errors';
import type { DbSubscription, ListeningClient } from './listen';
import { freeSlot, type GatedPool, poolGate, takeSlot } from './pool-gate';
import { trackPool } from './pool-gauge';
import { poolListeners } from './pool-listeners';
import { noteAnswered, pinBound, pinDeadlineMs } from './pool-pins';
import { assertPoolProfile, type PoolProfile, poolProfileFor } from './pool-profile';
import { reserveWithin } from './pool-reserve';
import { closeRetiredPool } from './pool-retire';
import { poolSweep, UNANSWERED_GRACE_MS } from './pool-sweep';
import { type PoolerMode, poolerFromEnv, poolerSessionRequired, poolerWaitFor } from './pooler';
import { type SqlFragment, sql } from './sql';
import { watchAbort } from './statement-cancel';
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
  /**
   * The environment this pool is configured from: `DATABASE_POOLER`, `ROLE` and, with no `url`,
   * `DATABASE_URL`. `process.env` when absent. One source per client, so a caller handed an
   * environment cannot get its URL from it and its pooler from the process; `client.pooler` is
   * then the one answer to "is a pooler in the path", for everything that asks afterwards.
   */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /**
   * How long a statement may queue in the pooler for a backend before it counts as unanswered,
   * added to the deadline only when a pooler is named. Default `POOLER_WAIT_MS`, PgBouncer's
   * `query_wait_timeout`; match it to the pooler's own if that one is set.
   */
  readonly poolerWaitMs?: number | undefined;
  /** Injection seam for the pool's deadlines; production passes none. */
  readonly schedule?: Scheduler | undefined;
}

export interface PostgresClient extends ReservableClient, ListeningClient {
  readonly profile: PoolProfile;
  readonly pooler: PoolerMode | undefined;
  ping(): Promise<void>;
  close(): Promise<void>;
}

const PIN_RETIRED =
  'the connection this transaction holds stopped answering and was retired; nothing more is sent on it';

/** Lazily connects: the pool opens on the first statement, never at import. */
export function postgresClient(options: PostgresClientOptions = {}): PostgresClient {
  const env = options.env ?? process.env;
  const role = options.role ?? resolveRole({ env });
  const pooler = poolerFromEnv(env);
  const poolerWaitMs = poolerWaitFor(pooler, options.poolerWaitMs);
  // Here, before a socket: through a transaction pooler `pg_try_advisory_lock` answers true to two
  // migrators on one backend, and a statement could not tell either of them so.
  if (pooler === 'transaction' && (role === 'migrate' || role === 'replicator')) {
    throw poolerSessionRequired(`ROLE=${role}`);
  }
  const profile: PoolProfile = assertPoolProfile({
    ...poolProfileFor(role),
    ...(options.profile ?? {}),
  });
  // The driver and what `db_pool_in_use` / `db_pool_waiting` are derived from (`pool-gauge.ts`),
  // as ONE value: a pool still draining after `close()` settles its own work against its own
  // counter, never against the pool that replaced it. Built only once the driver exists, so a
  // connection string that cannot be built registers no pool in `db_pool_max`.
  // The gate rides on it for the same reason: a pin held on a retired pool is no slot of the new one.
  type LivePool = GatedPool & { readonly pool: BunSqlDriver };
  let driver: LivePool | undefined;
  const listeners = poolListeners(() => connect().pool, options.schedule);
  // Every statement past it is rejected and its pool retired: pooled, or on a pin against the bound
  // in force on that connection (`pool-pins.ts`). `0` (`migrate`, `replicator`): none.
  // Behind a pooler the server's bound starts only once a backend is assigned.
  const beyondBoundMs = UNANSWERED_GRACE_MS + poolerWaitMs;
  const sweep =
    profile.statementTimeoutMs === 0
      ? undefined
      : poolSweep<LivePool>({
          deadlineMs: profile.statementTimeoutMs + beyondBoundMs,
          onMiss: retire,
          schedule: options.schedule,
        });

  function connect(): LivePool {
    if (driver !== undefined) return driver;
    const url = connectionUrl(
      { ...options, url: options.url ?? env['DATABASE_URL'], pooler },
      profile,
    );
    const Factory = bunSqlFactory();
    driver = {
      pool: new Factory(url, bunSqlPoolOptions(profile)),
      demand: trackPool(profile.max),
      gate: poolGate(profile.max, options.schedule),
    };
    return driver;
  }

  /** A statement went unanswered on `missed`. Its stragglers miss too, and retire nothing newer. */
  function retire(missed: LivePool, excerpt: string, waitedMs: number): void {
    if (driver !== missed) return;
    // Read-then-clear, as `close()` does: the next `connect()` opens a fresh pool, never this one.
    driver = undefined;
    missed.demand.close();
    logger.error('db.pool.retired', { statement: excerpt, waitedMs, role });
    closeRetiredPool(missed.pool);
    missed.gate.handOverWaiting();
    listeners.redial();
  }

  async function run(fragment: SqlFragment): Promise<unknown> {
    const slot = takeSlot(connect, profile.acquireTimeoutMs, fragment.text);
    const live = slot instanceof Promise ? await slot : slot;
    // Pooled only: a pin's statement belongs to a transaction, and cancelling it is not ours to do.
    const watch = watchAbort(fragment.text);
    try {
      const sending = runOn(watch === undefined ? live.pool : watch.on(live.pool), fragment);
      return await (sweep === undefined ? sending : sweep.track(live, fragment.text, sending));
    } catch (error) {
      throw watch === undefined ? error : watch.failure(error);
    } finally {
      watch?.end();
      freeSlot(live);
    }
  }

  const client: PostgresClient = {
    profile,
    pooler,
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
      // One gate slot for the life of the pin, so one number counts statements and pins alike.
      const budget = profile.acquireTimeoutMs;
      const started = performance.now();
      const live = await takeSlot(connect, budget, undefined);
      let reserved: BunSqlReserved;
      try {
        // `reserveWithin` keeps its own timer for `Bun.SQL`'s queue, on what the gate left of ONE
        // budget: two full timers made `web` wait 10 s for a pin promised in 5. At least 1 ms, since
        // a budget of 0 means "wait forever" there.
        const left =
          budget === 0 ? 0 : Math.max(1, Math.round(budget - (performance.now() - started)));
        reserved = await reserveWithin(live.pool, profile, left);
      } catch (error) {
        freeSlot(live);
        // Acquiring the pin is the one step that runs outside `runOn`, so an exhausted or
        // unreachable pool would escape as an untyped driver error — and `readOnlyQuery` reaches
        // this line before its first statement, which is how MCP ends up returning something
        // other than X_DB_UNAVAILABLE. Our own deadline is already typed; only the driver's own
        // failure needs classifying, and `53300` from the server lands as X_DB_POOL_EXHAUSTED too.
        if (error instanceof DbError) throw error;
        throw driverError('could not reserve a connection from the pool', error);
      }
      let held = true;
      const pin = pinBound(profile.statementTimeoutMs);
      // Direct only while the pin is held. `release()` hands this physical connection back, and
      // the pool may already have given it to another unit of work mid-transaction — a statement
      // issued on the stale handle would land inside theirs, committed or rolled back with it and
      // no error anywhere to explain the row. So a late statement takes its own connection out of
      // the pool, exactly like any other caller. Same rule as `pglite.ts`, one driver down.
      const on = (fragment: SqlFragment): Promise<unknown> =>
        held ? onPinned(fragment) : run(fragment);
      // A miss retired the pool; this connection is never written to again, so the transaction's
      // ROLLBACK is refused here rather than waiting out a second bound on the same dead path.
      const onPinned = async (fragment: SqlFragment): Promise<unknown> => {
        if (pin.dead) throw dbUnavailable(PIN_RETIRED);
        const sending = runOn(reserved, fragment);
        const deadlineMs = pinDeadlineMs(pin, beyondBoundMs);
        try {
          const answer = await (sweep === undefined
            ? sending
            : sweep.track(live, fragment.text, sending, deadlineMs));
          noteAnswered(pin, fragment, profile.statementTimeoutMs);
          return answer;
        } catch (error) {
          if (error instanceof DbError && error.code === 'X_DB_UNAVAILABLE') pin.dead = true;
          throw error;
        }
      };
      // Idempotent because two owners already exist on one exit path: `withTransaction` releases
      // in a `finally` and `[Symbol.dispose]` fires on the same scope. A second `release()` on a
      // handle already back in the pool frees whoever holds that connection now.
      const release = (): void => {
        if (!held) return;
        held = false;
        freeSlot(live);
        // Total by construction — `releaseReserved` owns the reason (`bun-sql.ts`).
        releaseReserved(reserved);
      };
      return {
        query: async <T>(fragment: SqlFragment) => rowsOf<T>(await on(fragment)),
        one: async <T>(fragment: SqlFragment) => rowsOf<T>(await on(fragment))[0] ?? null,
        execute: async (fragment: SqlFragment) => affectedBy(await on(fragment)),
        release,
        [Symbol.dispose]: release,
      };
    },
    listen(channel, onNotify, onListening): Promise<DbSubscription> {
      return listeners.listen(channel, onNotify, onListening);
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
      const closing = driver;
      driver = undefined;
      listeners.drop();
      if (closing === undefined) return;
      // A queued statement must not outlive this and open a pool in a process shutting down.
      closing.gate.refuseWaiting(
        dbUnavailable('the pool closed while this statement waited for a slot'),
      );
      // Only THIS pool's counter leaves the totals; its in-flight work settles against it.
      closing.demand.close();
      const { pool } = closing;
      // BOUNDED, `As of 2026-08-27`, and through the driver's OWN option rather than a race here.
      // This was a bare `await pool.close()`, and `Bun.SQL`'s `end()` waits on an outstanding
      // reserved connection without ever giving up — measured three runs per case on Bun 1.3.14
      // AND 1.4.0, no database outage involved (#394). So a role whose database went away
      // mid-shutdown never finished shutting down, and the operator's only signal was a container
      // that burned its whole termination grace period before SIGKILL.
      //
      // `BunSqlDriver.close` has declared `{ timeout }` since this port was written and NOTHING
      // ever passed it — the capability was in the seam, unused, exactly like `setOfflineMode` on
      // the CDP port. Measured with a reserve outstanding: `close({ timeout: 1 })` returns in
      // ~1002ms on 1.3.14, 1.4.0 and 1.4.1-canary alike, where a bare `close()` never returns.
      //
      // **The unit is SECONDS**, not milliseconds. `timeout: 5000` would be an eighty-three minute
      // shutdown budget, which is the same hang with extra steps.
      if (profile.drainTimeoutMs === 0) {
        // `migrate` and `replicator`, for `acquireTimeoutMs`' reason: a run-once role cutting off
        // its own session mid-statement is worse than a slow exit.
        await pool.close();
        return;
      }
      // `performance.now()`, never `Date.now()`, and the reason is this repo rather than NTP: the
      // framework preload freezes `Date` for every test in the tree (`installDeterminism`), so a
      // duration subtracted from `Date.now()` is 0 in all of them — the branch below could not
      // fire, and the test asserting it would have been one that cannot fail.
      const started = performance.now();
      await pool.close({ timeout: profile.drainTimeoutMs / 1000 });
      // The driver RESOLVES when it gives up — it does not reject — so the elapsed time is the only
      // thing that separates "drained" from "abandoned". Reporting it is the point: a drain that
      // silently gave up looks exactly like a clean one, and the work still in flight is lost with
      // no line anywhere saying so. The pool is gone either way, which is why this is terminal.
      if (performance.now() - started >= profile.drainTimeoutMs) {
        throw drainTimeout(profile.drainTimeoutMs, role);
      }
    },
  };
  return client;
}

let ambient: DbClient | undefined;
// Separate from `ambient`, which the lazy default also fills: a unit test that sent one statement
// through `db()` must not flip `@ultimat3/entity`'s `testDriver()` onto a pool nobody asked for.
let installed = false;

/** Test/dev seam. `setDbClient(undefined)` restores lazy construction from `DATABASE_URL`. */
export function setDbClient(client: DbClient | undefined): void {
  ambient = client;
  installed = client !== undefined;
}

/**
 * Whether `setDbClient` installed a client that is still in place. Asking never builds the lazy
 * default — `testDriver()` asks on every repository call of every unit test.
 */
export function dbClientInstalled(): boolean {
  return installed;
}

/**
 * The pool, ignoring any open transaction. `withTransaction` must not re-enter `db()`.
 *
 * The role default is layered under `DATABASE_POOL_MAX`, because this is the one place the process
 * builds its own client and therefore the only place an operator's value can reach one:
 * `postgresClient` has always taken a `profile` override and nothing in a running app passed
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
