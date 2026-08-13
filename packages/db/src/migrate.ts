// Single responsibility: apply pending migrations and keep the `x_migrations` ledger honest.
// An advisory lock serialises concurrent migrators; a checksum pins already-applied SQL; the
// app-version fence is the `migrate` role's contract — a pod must refuse to migrate a database
// another build already owns, because the alternative is two schemas racing during a rollout.

import { baseClient, type DbClient, type DbConnection, isReservable } from './client';
import { migrationConflict } from './errors';
import { expectedQueryLoop } from './expected-loop';
import type { SchemaDescription } from './introspect';
import { raw, sql } from './sql';
import { withTransaction } from './transaction';

export const LEDGER_TABLE = 'x_migrations';

/** Stable, arbitrary: every Ultimate migrator contends on this one key. */
export const MIGRATION_LOCK_KEY = 4_919_202_607;

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
}

export function checksumOf(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text.trim()).digest('hex').slice(0, 32);
}

export function migrationChecksum(migration: Migration): string {
  return migration.checksum ?? checksumOf(migration.up);
}

export function runningAppVersion(explicit?: string | undefined): string {
  return explicit ?? process.env['APP_VERSION'] ?? 'dev';
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

  const foreign = ledger.filter((row) => !known.has(row.id) && row.app_version !== appVersion);
  const first = foreign[0];
  if (first !== undefined) {
    throw migrationConflict(
      `the ledger records migration "${first.id}" applied by app version "${first.app_version}" ` +
        `but this build is "${appVersion}" and does not ship it`,
      `x db status --json   # then deploy app version "${first.app_version}", or roll the ledger`,
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
async function withAdvisoryLock<T>(
  client: DbClient,
  enabled: boolean,
  fn: (session: DbClient) => Promise<T>,
): Promise<T> {
  if (!enabled) return fn(client);
  // Held by a `using` declaration, like every other pin in this package: the lock is taken after
  // the guard exists, so a rejecting `pg_advisory_lock` gives the connection back too.
  using pinned: DbConnection | undefined = isReservable(client)
    ? await client.reserve()
    : undefined;
  const session: DbClient = pinned ?? client;
  await session.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
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

export async function migrate(options: MigrateOptions): Promise<MigrationReport> {
  const client = options.client ?? baseClient();
  const appVersion = runningAppVersion(options.appVersion);
  const started = performance.now();

  return withAdvisoryLock(client, options.lock !== false, async (session) => {
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
              await tx.execute(raw(migration.up));
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
  });
}

export interface RollbackOptions {
  readonly migrations: readonly Migration[];
  readonly client?: DbClient | undefined;
  readonly steps?: number | undefined;
  /** Skip the advisory lock. Only `x db branch` does this, against a private database. */
  readonly lock?: boolean | undefined;
}

/** Reverse the newest `steps` applied migrations. `x db rollback`. */
export async function rollback(options: RollbackOptions): Promise<readonly string[]> {
  const client = options.client ?? baseClient();
  const steps = options.steps ?? 1;
  const known = new Map(options.migrations.map((migration) => [migration.id, migration]));

  // The same lock `migrate` takes, because the race is the same one: a rollback reversing the id a
  // migrator is applying leaves a ledger that describes neither, and the ledger read below decides
  // what to reverse — outside the lock it can be stale before the first `down` runs.
  return withAdvisoryLock(client, options.lock !== false, async (session) => {
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
              `x db status --json   # deploy the build that shipped "${row.id}" and roll back there`,
            );
          }
          await withTransaction(
            async (tx) => {
              await tx.execute(raw(migration.down));
              await tx.execute(sql`delete from ${raw(LEDGER_TABLE)} where id = ${row.id}`);
            },
            { client: session },
          );
          reverted.push(row.id);
        }
        return reverted;
      },
    );
  });
}
