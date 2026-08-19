// Single responsibility: apply pending migrations and keep the `x_migrations` ledger honest.
// An advisory lock serialises concurrent migrators; a checksum pins already-applied SQL; the
// app-version fence is the `migrate` role's contract — a pod must refuse to migrate a database
// another build already owns, because the alternative is two schemas racing during a rollout.

import { appVersion } from '@ultimat3/core';
import {
  baseClient,
  type DbClient,
  type DbConnection,
  isReservable,
  poolProfileFor,
} from './client';
import { migrateConcurrent, migrationConflict, rollbackStepsInvalid } from './errors';
import { expectedQueryLoop } from './expected-loop';
import type { SchemaDescription } from './introspect';
import { raw, sql } from './sql';
import { SQLSTATE, sqlState } from './sqlstate';
import { statementsOf } from './statement-split';
import { type DbTx, withTransaction } from './transaction';

export const LEDGER_TABLE = 'x_migrations';

/** Stable, arbitrary: every Ultimate migrator contends on this one key. */
export const MIGRATION_LOCK_KEY = 4_919_202_607;

/**
 * How long a migrator waits for the lock before refusing. A deploy hook must fail rather than
 * hang: `pg_advisory_lock` blocks with no timeout, so a wedged predecessor held `helm upgrade
 * --wait` inside one statement with nothing in the logs and `backoffLimit` never reached. Long
 * enough that a genuinely slow migration ahead of us is waited out, short enough that a stuck one
 * becomes an exit code inside a deploy window.
 */
export const MIGRATION_LOCK_WAIT_MS = 60_000;

/** One poll per half-second: cheap against a lock that is usually free on the first try. */
export const MIGRATION_LOCK_POLL_MS = 500;

export interface Migration {
  /** Sort key and primary key. `20260726120000_add_publish_at`. */
  readonly id: string;
  readonly name: string;
  readonly up: string;
  readonly down: string;
  /** Computed from `up` when absent. */
  readonly checksum?: string | undefined;
  /** The schema this migration leaves behind. `drift.ts` compares the live DB against it. */
  readonly snapshot?: SchemaDescription | undefined;
}

export interface LedgerRow {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: string;
  readonly app_version: string;
  readonly duration_ms: number;
}

export interface AppliedMigration {
  readonly id: string;
  readonly name: string;
  readonly durationMs: number;
}

/** The `--json` payload of `x db migrate`. */
export interface MigrationReport {
  readonly applied: readonly AppliedMigration[];
  readonly skipped: readonly string[];
  readonly durationMs: number;
  readonly appVersion: string;
}

export interface MigrateOptions {
  readonly migrations: readonly Migration[];
  /** The running build. Defaults to `APP_VERSION`, then `dev`. */
  readonly appVersion?: string | undefined;
  readonly client?: DbClient | undefined;
  /** Skip the advisory lock. Only `x db branch` does this, against a private database. */
  readonly lock?: boolean | undefined;
  /** How long to wait for the lock before `X_MIGRATE_CONCURRENT`. Defaults to 60s. */
  readonly lockWaitMs?: number | undefined;
  /** `SET LOCAL lock_timeout` per migration. Defaults to the `migrate` role's profile. */
  readonly lockTimeoutMs?: number | undefined;
}

export function checksumOf(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text.trim()).digest('hex').slice(0, 32);
}

export function migrationChecksum(migration: Migration): string {
  return migration.checksum ?? checksumOf(migration.up);
}

/**
 * Core's, never a second read of the key: `x_migrations.app_version` and `x_backfills.app_version`
 * are two durable columns an operator reads side by side, and a package defaulting `APP_VERSION`
 * its own way would put two names on one build.
 */
export function runningAppVersion(explicit?: string | undefined): string {
  return explicit ?? appVersion();
}

export async function ensureLedger(client: DbClient): Promise<void> {
  await client.execute(sql`
    create table if not exists ${raw(LEDGER_TABLE)} (
      id text primary key,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null default now(),
      app_version text not null,
      duration_ms integer not null
    )
  `);
}

/**
 * Whether `error` is "the ledger table does not exist" and nothing else.
 *
 * Everything else — a permission denied, a server in recovery, a timeout — is a failure to read the
 * ledger, not an empty one, and a caller treating the two alike reports every migration as pending
 * against a database it cannot see.
 *
 * The SQLSTATE comes from `sqlState()` and from nowhere else: this function used to read
 * `sourceError.code` itself, which is the SQLSTATE on PGlite and the literal string
 * `ERR_POSTGRES_SERVER_ERROR` on `Bun.SQL`, so it answered `false` for a genuinely missing ledger
 * on every production driver. One reader, one answer (axiom 1).
 */
export function isLedgerMissing(error: unknown): boolean {
  return sqlState(error) === SQLSTATE.undefinedTable;
}

export async function readLedger(client: DbClient): Promise<readonly LedgerRow[]> {
  return client.query<LedgerRow>(sql`
    select id, name, checksum, applied_at, app_version, duration_ms
    from ${raw(LEDGER_TABLE)}
    order by id
  `);
}

/**
 * Every reason a migrator must stop before touching the schema. Pure, so `x db status` can
 * report the same verdict without holding the lock.
 */
export function auditLedger(
  ledger: readonly LedgerRow[],
  migrations: readonly Migration[],
  appVersion: string,
): void {
  const known = new Map(migrations.map((migration) => [migration.id, migration]));

  // The predicate is "this build does not ship it" and NOTHING else. It used to also require
  // `row.app_version !== appVersion`, which switched the audit off wherever the two agree —
  // `runningAppVersion()` answers `dev` for every development build, so a migration applied by an
  // earlier `dev` build and since deleted was invisible here, and `expectedSchema` then dropped
  // its table from the drift comparison: `ok: true` against a database that still has the table.
  // The version is a detail of the ANSWER, so it moved into the cause.
  const foreign = ledger.filter((row) => !known.has(row.id));
  const first = foreign[0];
  if (first !== undefined) {
    throw migrationConflict(
      `the ledger records migration "${first.id}" applied by app version "${first.app_version}" ` +
        `but this build is "${appVersion}" and does not ship it`,
      // `x db status` has never existed — the subcommands are gen, migrate, reset, studio, branch
      // and backfill — and this is one of the two errors most likely to fire during a real deploy.
      // A `fix:` is copied and run verbatim, so it names the ledger read that works anywhere psql
      // does, and the one edit that resolves the disagreement.
      `deploy app version "${first.app_version}" — or, if that build is gone, drop its row: ` +
        `psql "$DATABASE_URL" -c "delete from ${LEDGER_TABLE} where id = '${first.id}'"`,
    );
  }

  for (const row of ledger) {
    const migration = known.get(row.id);
    if (migration === undefined) continue;
    const checksum = migrationChecksum(migration);
    if (checksum === row.checksum) continue;
    throw migrationConflict(
      `migration "${row.id}" was applied with checksum ${row.checksum} but now hashes ${checksum}`,
      `x db gen "fix ${migration.name}"   # never edit an applied migration, add a new one`,
    );
  }
}

export function pendingMigrations(
  ledger: readonly LedgerRow[],
  migrations: readonly Migration[],
): readonly Migration[] {
  const applied = new Set(ledger.map((row) => row.id));
  return [...migrations]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .filter((migration) => !applied.has(migration.id));
}

/**
 * Hold the migration lock on **one** session for the whole of `fn`, which runs on that session.
 *
 * `pg_advisory_lock` is scoped to a Postgres session, not to a statement, so taking it on a pooled
 * handle locks whichever connection the pool lent for that one statement and then hands the
 * session back. Two things follow, and both were live: the unlock lands on a *different*
 * connection, answers `false` and leaves the lock held until that backend dies — so the next
 * migrator waits forever rather than for the migration; and the locking session, now idle for the
 * whole run, is closed by the pool's idle timeout (`migrate`'s is 10s), which releases the lock
 * mid-migration and lets a second deploy in. `ROLE=migrate` hid the first half by accident — its
 * pool is `max: 1`, so every statement found the same connection. No other role and no test has
 * that.
 *
 * `fn` receives the pinned session and must run every statement on it, for the same `max: 1`
 * reason read the other way: a statement sent to the pool while the pin is held waits for a
 * connection that cannot come back until the migration blocking on it has finished.
 */

/**
 * Take the lock, or refuse — never block forever.
 *
 * `pg_advisory_lock` has no timeout, and that is a deploy outage waiting for its trigger: a
 * predecessor OOM-killed on a network partition keeps its backend, and with it the lock, for hours.
 * The new `ROLE=migrate` pod then sits inside one statement printing nothing, `helm upgrade --wait`
 * blocks on a pod that is `Running` and healthy, and because the job never *fails*, `backoffLimit`
 * never fires. `pg_try_advisory_lock` answers immediately, so the wait becomes ours to bound and
 * the wedge becomes an exit code carrying the lock key and the pid to terminate.
 *
 * Declared as an expected loop: a poll is a loop the framework argued for, and a diagnostic that
 * reported it would teach an author to ignore the ones nobody argued for.
 */
async function acquireLock(session: DbClient, waitMs: number): Promise<void> {
  const started = performance.now();
  await expectedQueryLoop(
    'the migration lock is polled, not waited on, so a wedged migrator fails a deploy instead of hanging it',
    async () => {
      for (;;) {
        const row = await session.one<{ locked: boolean }>(
          sql`select pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) as locked`,
        );
        if (row?.locked === true) return;
        const remaining = waitMs - (performance.now() - started);
        if (remaining <= 0) {
          throw migrateConcurrent(MIGRATION_LOCK_KEY, Math.round(performance.now() - started));
        }
        await Bun.sleep(Math.min(MIGRATION_LOCK_POLL_MS, remaining));
      }
    },
  );
}

async function withAdvisoryLock<T>(
  client: DbClient,
  enabled: boolean,
  waitMs: number,
  fn: (session: DbClient) => Promise<T>,
): Promise<T> {
  if (!enabled) return fn(client);
  // Held by a `using` declaration, like every other pin in this package: the lock is taken after
  // the guard exists, so a rejecting `pg_advisory_lock` gives the connection back too.
  using pinned: DbConnection | undefined = isReservable(client)
    ? await client.reserve()
    : undefined;
  const session: DbClient = pinned ?? client;
  await acquireLock(session, waitMs);
  try {
    return await fn(session);
  } finally {
    // Best-effort, and only here: an unlock that rejects would mask the failure that ended the
    // migration, and it can only reject on a session that is already broken — whose locks Postgres
    // drops when it ends. It runs before the pin is disposed, so the unlock reaches the session
    // that took the lock.
    await session
      .execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`)
      .catch(() => undefined);
  }
}

/**
 * A migration's `up` and `down` are **scripts**, and one send is one statement — because the two
 * drivers disagree about anything else. PGlite's `query()` is the extended protocol always and
 * answers `cannot insert multiple commands into a prepared statement`; `Bun.SQL.unsafe` degrades
 * to the simple protocol when no value is bound and applies the same script, which is a fact about
 * bun 1.3.14 and not a contract. `createTable` emits the table *and* every index it carries, and
 * `x dev` runs on the embedded driver, so the refusing side was the common path.
 *
 * No `expectedQueryLoop` of its own: both call sites already run inside the one declared for the
 * migration loop, and nesting here would replace that reason with a narrower one for no gain. An
 * empty script sends nothing at all, which is how a no-op migration reaches its ledger row.
 */
async function applyScript(tx: DbTx, script: string): Promise<void> {
  for (const statement of statementsOf(script)) await tx.execute(raw(statement));
}

/**
 * Bound how long this migration will queue behind a lock it cannot take.
 *
 * `alter table … add column` needs `ACCESS EXCLUSIVE`. A long `SELECT` holding `ACCESS SHARE`
 * makes it wait — and because Postgres' lock queue is FIFO, **every subsequent query on that table
 * queues behind the ALTER**. The `migrate` profile runs `statement_timeout = 0` deliberately, so
 * without this the migrator waits forever and the app is down on one table for as long as the
 * reporting query runs. `lock_timeout` bounds the *wait* alone and never the work, which is why it
 * is the right knob where `statement_timeout` is not.
 *
 * `SET LOCAL`, inside the migration's own transaction: it reverts at COMMIT, so a value chosen for
 * DDL never leaks onto the session the ledger insert or the next migration runs on. A 0 disables
 * it, exactly like `statementTimeoutMs`. The failure it produces is `55P03`, typed as
 * `X_DB_LOCK_TIMEOUT` by `driverError` with the `pg_stat_activity` read as its fix.
 */
async function setLockTimeout(tx: DbTx, lockTimeoutMs: number): Promise<void> {
  if (lockTimeoutMs <= 0) return;
  // `SET LOCAL` takes no parameter placeholder, and the value is a validated integer of ours.
  await tx.execute(raw(`SET LOCAL lock_timeout = ${Math.round(lockTimeoutMs)}`));
}

/**
 * `migrate` role's profile whatever role is running, because the statement is a migration whatever
 * process issues it: `x db migrate` from a laptop, `x dev`'s boot and `ROLE=migrate` all take the
 * same `ACCESS EXCLUSIVE` locks against the same tables.
 */
function migrationLockTimeoutMs(explicit: number | undefined): number {
  return explicit ?? poolProfileFor('migrate').lockTimeoutMs;
}

export async function migrate(options: MigrateOptions): Promise<MigrationReport> {
  const client = options.client ?? baseClient();
  const appVersion = runningAppVersion(options.appVersion);
  const lockTimeoutMs = migrationLockTimeoutMs(options.lockTimeoutMs);
  const started = performance.now();

  return withAdvisoryLock(
    client,
    options.lock !== false,
    options.lockWaitMs ?? MIGRATION_LOCK_WAIT_MS,
    async (session) => {
      await ensureLedger(session);
      const ledger = await readLedger(session);
      auditLedger(ledger, options.migrations, appVersion);

      const pending = pendingMigrations(ledger, options.migrations);
      // A statement per migration and a transaction per migration is the point, not an N+1 to batch:
      // one failed `up` must leave the ledger describing exactly the migrations that did run, and a
      // batch commits or loses all of them together. Declared here so a diagnostic reports the loops
      // nobody argued for and stays quiet about this one.
      const applied = await expectedQueryLoop(
        'each migration applies in its own transaction, so a failure leaves an exact ledger',
        async () => {
          const done: AppliedMigration[] = [];
          for (const migration of pending) {
            const at = performance.now();
            await withTransaction(
              async (tx) => {
                await setLockTimeout(tx, lockTimeoutMs);
                await applyScript(tx, migration.up);
                const durationMs = Math.round(performance.now() - at);
                await tx.execute(sql`
                insert into ${raw(LEDGER_TABLE)} (id, name, checksum, app_version, duration_ms)
                values (${migration.id}, ${migration.name}, ${migrationChecksum(migration)},
                        ${appVersion}, ${durationMs})
              `);
              },
              // The lock's own session: a migration applied on another connection is not covered by
              // the lock at all, and on `ROLE=migrate` there is no other connection to apply it on.
              { client: session },
            );
            done.push({
              id: migration.id,
              name: migration.name,
              durationMs: Math.round(performance.now() - at),
            });
          }
          return done;
        },
      );

      return {
        applied,
        skipped: ledger.map((row) => row.id),
        durationMs: Math.round(performance.now() - started),
        appVersion,
      };
    },
  );
}

export interface RollbackOptions {
  readonly migrations: readonly Migration[];
  readonly client?: DbClient | undefined;
  /** How many applied migrations to reverse, newest first. A positive integer; defaults to 1. */
  readonly steps?: number | undefined;
  /** Skip the advisory lock. Only `x db branch` does this, against a private database. */
  readonly lock?: boolean | undefined;
  /** How long to wait for the lock before `X_MIGRATE_CONCURRENT`. Defaults to 60s. */
  readonly lockWaitMs?: number | undefined;
  /** `SET LOCAL lock_timeout` per reversal. Defaults to the `migrate` role's profile. */
  readonly lockTimeoutMs?: number | undefined;
}

/** Reverse the newest `steps` applied migrations. `x db rollback`. */
export async function rollback(options: RollbackOptions): Promise<readonly string[]> {
  const client = options.client ?? baseClient();
  const steps = options.steps ?? 1;
  // Before the lock and before the ledger read: `slice(0, -1)` is "all but the newest", not
  // "one fewer", so an unvalidated count reverses migrations nobody asked about.
  if (!Number.isSafeInteger(steps) || steps < 1) throw rollbackStepsInvalid(steps);
  const lockTimeoutMs = migrationLockTimeoutMs(options.lockTimeoutMs);
  const known = new Map(options.migrations.map((migration) => [migration.id, migration]));

  // The same lock `migrate` takes, because the race is the same one: a rollback reversing the id a
  // migrator is applying leaves a ledger that describes neither, and the ledger read below decides
  // what to reverse — outside the lock it can be stale before the first `down` runs.
  return withAdvisoryLock(
    client,
    options.lock !== false,
    options.lockWaitMs ?? MIGRATION_LOCK_WAIT_MS,
    async (session) => {
      const ledger = await readLedger(session);
      const targets = [...ledger].reverse().slice(0, steps);

      // The same deliberate loop as `migrate`, read backwards: one transaction per `down`, newest
      // first, so a `down` that fails leaves every migration before it still applied and recorded.
      return expectedQueryLoop(
        'each migration reverses in its own transaction, newest first, so a failure stops exactly there',
        async () => {
          const reverted: string[] = [];
          for (const row of targets) {
            const migration = known.get(row.id);
            if (migration === undefined) {
              throw migrationConflict(
                `migration "${row.id}" is in the ledger but not in this build, so its down SQL is unknown`,
                // Same reason as `auditLedger`'s: `x db status` does not exist. The `down` SQL only
                // exists in the build that shipped it, so the fix is the read that names that build.
                `psql "$DATABASE_URL" -c "select id, app_version from ${LEDGER_TABLE} ` +
                  `order by id desc limit 5"   # deploy the build that shipped "${row.id}", ` +
                  'and roll back there — its down SQL exists nowhere else',
              );
            }
            await withTransaction(
              async (tx) => {
                await setLockTimeout(tx, lockTimeoutMs);
                await applyScript(tx, migration.down);
                await tx.execute(sql`delete from ${raw(LEDGER_TABLE)} where id = ${row.id}`);
              },
              { client: session },
            );
            reverted.push(row.id);
          }
          return reverted;
        },
      );
    },
  );
}
