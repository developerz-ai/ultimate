// The database and the job queue, started together and released together. Split from
// `dev-runtime.ts` because `x jobs` needs exactly this pair and nothing else — and because a
// process that installs ambient accessors (`db()`, `jobDriver()`, the jobs facade, the event bus)
// must have one place that takes them all back, or the next command in the same process inherits
// a driver over a closed socket.

import {
  type PostgresIdempotencyStore,
  postgresIdempotencyStore,
  resetIdempotency,
  SQL_AUDIT_TABLE,
  SQL_IDEMPOTENCY_TABLE,
  setIdempotencyStore,
} from '@ultimat3/action';
import { SQL_AUTH_LIMIT_TABLES } from '@ultimat3/auth';
import type { DbClient, PgliteClient, PostgresClient, SqlFragment } from '@ultimat3/db';
import {
  createPgliteClient,
  createPostgresClient,
  currentTx,
  pgliteDataDir,
  raw,
  setDbClient,
} from '@ultimat3/db';
import type { Tx } from '@ultimat3/entity';
import { SQL_RATE_LIMIT_TABLE } from '@ultimat3/http';
import type { EventBus, JobDriver, OutboxStore, PgExecutor } from '@ultimat3/jobs';
import {
  createJobsFacade,
  createPgDriver,
  createPgEventBus,
  createPgOutboxStore,
  resetJobDriver,
  resetJobsFacade,
  SQL_JOBS_TABLE,
  setEventBus,
  setJobDriver,
  setJobsFacade,
} from '@ultimat3/jobs';
import { attachReplica, type ReplicaEnv, replicaUrlFor } from './dev-replica';
import type { DevServices } from './dev-services';
import type { RuntimeOverrides } from './runtime-overrides';

/** Both embedded and external clients boot lazily and close explicitly. */
export type DevDbClient = PgliteClient | PostgresClient;

/** The primary this boot owns, plus the standby pool it opened — `stop()` closes both. */
interface StartedDb {
  readonly client: DevDbClient;
  readonly replica: PostgresClient | undefined;
}

export interface RunningQueue {
  readonly db: DevDbClient;
  readonly jobs: JobDriver;
  /**
   * The `x_outbox` store this boot installed behind `handle.enqueue()`. Returned because the
   * relay that drains it is a ROLE's decision, not the queue's — `dev-roles.ts` starts one.
   */
  readonly outbox: OutboxStore;
  /** The `x_job_events` bus a `step.waitForEvent` resumes from. Durable, not per-process. */
  readonly events: EventBus;
  /**
   * The `x_idempotency` store this boot installed behind `idempotent: true`. Returned for the
   * reason `outbox` is: the retention sweep over that table is a ROLE's work, not the queue's,
   * and it has to sweep the store that was INSTALLED — a second one built beside it would purge
   * on the default window even where this boot had configured another.
   */
  readonly idempotency: PostgresIdempotencyStore;
  stop(): Promise<void>;
}

/**
 * The boot's own client, and the AMBIENT one, which are deliberately not always the same object.
 *
 * `setDbClient` receives the replicated pair when `DATABASE_REPLICA_URL` names a standby, so an
 * app repository reading through `db()` inside an open `withReplicaReads` scope can be served by
 * it. Everything this file does itself — `applySchema`, the `PgExecutor` behind the queue, the
 * outbox, `ping()`, `close()` — keeps the PRIMARY: DDL, a claim and a migration are writes by
 * definition, and routing one would be `25006` at best.
 *
 * Before this, `defaultClient()` was the only composer of a replicated pair in the framework and
 * it runs only from `baseClient()` — the client an app installed NONE for. This line installs one,
 * so `DATABASE_REPLICA_URL` was read by no booted process at all.
 */
function startDb(services: DevServices, env: ReplicaEnv = process.env): StartedDb {
  const binding = services.db;
  const client =
    binding.mode === 'embedded'
      ? // `pgliteDataDir` is `@ultimat3/db`'s own reader of the `pglite://` form; a second parser
        // here is a second thing to keep right when the form changes.
        createPgliteClient({ dataDir: pgliteDataDir(binding.url) })
      : createPostgresClient({ url: binding.url });
  const attached = attachReplica(client, replicaUrlFor(binding, env));
  setDbClient(attached.client);
  return { client, replica: attached.replica };
}

/**
 * `@ultimat3/jobs` deliberately depends on no database package: Postgres reaches it as an
 * injected `PgExecutor`. Boot code is what supplies one, and this is the boot.
 *
 * The fragment is assembled by hand rather than through `sql`` ` because the driver hands over
 * `$1..$n` text it wrote itself plus already-bound values — there is no interpolation to guard.
 */
export function pgExecutorFor(client: DbClient): PgExecutor {
  return {
    query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
      client.query<R>({ text, values } satisfies SqlFragment),
  };
}

/**
 * Every table this process's framework packages own, applied before anything reads one.
 *
 * PGlite speaks the extended protocol, which carries one statement per round trip, so the DDL is
 * applied statement by statement. Safe to split on `;`: every constant is fixed, with no semicolon
 * inside a literal, and each package's own SQL test is where that stays true.
 *
 * `SQL_IDEMPOTENCY_TABLE`, `SQL_RATE_LIMIT_TABLE` and `SQL_AUTH_LIMIT_TABLES` are here and not in
 * `@ultimat3/action`, `@ultimat3/http` or `@ultimat3/auth` because a package that holds no
 * database dependency cannot apply its own schema
 * — the same reason `SQL_JOBS_TABLE` is applied here. Each one absent is the same failure at a
 * different door: a retried `POST /api/payments/charge` charges the card twice, and the FIRST
 * request a `rateLimitStore` deployment serves dies on a missing `x_rate_limit` relation. The
 * table is installed whether or not this boot passes `runtime.rateLimitStore` — `create table if
 * not exists` on an unused table costs one round trip at boot, and a store installed later must
 * not be the thing that discovers the schema was never applied. The auth pair is the strongest
 * case for that rule: `defineAuth` builds its limiter when the APP's modules import, which is
 * after this, so the first failed sign-in would otherwise be what discovers the missing relation.
 */
async function applySchema(client: DevDbClient): Promise<void> {
  for (const ddl of [
    SQL_JOBS_TABLE,
    SQL_IDEMPOTENCY_TABLE,
    // The DDL only, and deliberately NO `setAuditSink` beside `setIdempotencyStore` below: there
    // is no default audit sink on purpose, so `X_AUDIT_SINK_MISSING` keeps firing at boot for an
    // app that declares `audit: true` and installs none. Applying the table without installing a
    // sink is the same call `SQL_RATE_LIMIT_TABLE` already makes — one round trip at boot on a
    // possibly-unused table, against `postgresAuditSink` failing its first write with
    // `relation "x_audit" does not exist`.
    SQL_AUDIT_TABLE,
    SQL_RATE_LIMIT_TABLE,
    SQL_AUTH_LIMIT_TABLES,
  ]) {
    for (const statement of ddl.split(';')) {
      if (statement.trim().length > 0) await client.execute(raw(statement));
    }
  }
}

/**
 * The dev queue is the real Postgres queue on the embedded Postgres — claiming, leases and the
 * one-live-job-per-key index all behave here exactly as in production. A memory queue in dev
 * would hide every bug this driver exists to make impossible.
 *
 * Three ambient installs, not one, and they go in together because they are one decision:
 *
 * - `setJobDriver` is what `jobDriver()` answers and what a worker claims from.
 * - `setJobsFacade` is what `handle.enqueue()` routes through, so an enqueue inside a request's
 *   transaction STAGES a row that commits or vanishes with the business rows. Without it the
 *   fallback facade publishes straight to the driver, and a job for a transaction that rolled
 *   back still runs. `currentTx()` resolves the executor because a `DbTx` IS a client on the
 *   transaction's own connection, while the `Tx` token `@ultimat3/entity` hands over is not that
 *   object — so the token is a key and the ALS is the lookup.
 * - `setEventBus` makes `step.waitForEvent` durable. The memory bus this replaced forgot every
 *   pending correlation on restart, which is a job that waits forever.
 * - `setIdempotencyStore` makes `idempotent: true` mean it across replicas. The memory default is
 *   one process' worth of keys, so a client retrying `POST /api/payments/charge` after a timeout
 *   lands on a replica that has never seen the key and charges the card a second time.
 *
 * The idempotency store is installed HERE and not from the app, even though
 * `@ultimat3/action` documents `postgresIdempotencyStore({ executor: Bun.sql })`: `Bun.sql` has no
 * `.query(text, values)` — it is a tagged template whose positional form is `unsafe` — so that
 * line does not satisfy `PgExecutor` at all, and a second executor would open a second pool
 * against a URL this boot already resolved. Boot owns the connection, so boot supplies it.
 * `startServices` runs before `loadApp`, so the store is in place before `registerAction`
 * evaluates a `scope: 'shared'` declaration against it.
 */
async function startJobs(
  client: DevDbClient,
  replica: PostgresClient | undefined,
  overrides?: RuntimeOverrides,
): Promise<RunningQueue> {
  await applySchema(client);
  const executor = pgExecutorFor(client);
  const driver = overrides?.jobs ?? createPgDriver({ executor });
  setJobDriver(driver);
  const outbox = createPgOutboxStore({
    executor,
    // The open transaction is a client on its own connection; the `Tx` token is not that object.
    txExecutor: () => pgExecutorFor(currentTx() ?? client),
  });
  setJobsFacade(
    createJobsFacade({ store: outbox, driver }, () => currentTx() as unknown as Tx | undefined),
  );
  const events = createPgEventBus({ executor });
  setEventBus(events);
  const idempotency = postgresIdempotencyStore({ executor });
  setIdempotencyStore(idempotency);
  return {
    db: client,
    jobs: driver,
    outbox,
    events,
    idempotency,
    stop: () => releaseQueue(client, driver, replica),
  };
}

/**
 * Release every ambient accessor, then the resources behind them, in that order: a driver reset
 * after its database is closed leaves a window where `jobDriver()` answers over a dead socket.
 * A stale driver is worse than none — the next command sees one installed and skips queue
 * startup entirely, so every query it makes fails on a connection this process already dropped.
 *
 * The facade goes with the driver for the same reason: an enqueue routed through a store bound to
 * a closed client is a staged row nothing will ever publish.
 */
async function releaseQueue(
  db: DevDbClient,
  jobs: JobDriver | undefined,
  replica?: PostgresClient,
): Promise<void> {
  // The idempotency store goes back to the memory default for the same reason the facade does: it
  // holds this client, and the next command in this process would reserve keys over a closed one.
  resetIdempotency();
  resetJobsFacade();
  resetJobDriver();
  setDbClient(undefined);
  await jobs?.close?.();
  await db.close();
  // After the primary, and never instead of it: a standby pool left open is a connection slot on
  // the other server that nothing in this process can reach again.
  await replica?.close();
}

/**
 * The db + jobs half of `startServices`, alone: `x jobs` needs a real queue and nothing else —
 * no transport, no storage, no mail — and booting those for a command that never reports on them
 * would pay for services it cannot even use. `startServices` builds on this so there is one boot
 * path for "which database" and "which queue", not two.
 */
export async function startQueue(
  services: DevServices,
  overrides?: RuntimeOverrides,
): Promise<RunningQueue> {
  const { client: db, replica } = startDb(services);
  try {
    // Pay the Postgres boot here, so the first request is not the slow one and a broken database
    // fails at boot rather than on some later query.
    await db.ping();
    return await startJobs(db, replica, overrides);
  } catch (error) {
    // `db.ping()` or `startJobs` is where a broken database is supposed to fail. Without this,
    // the caller exits holding the PGlite lock and the ambient accessors, and nothing is left to
    // release them. The rejection that started the unwind is the one worth reporting.
    try {
      await releaseQueue(db, undefined, replica);
    } catch {
      // Cleanup noise never replaces the boot failure.
    }
    throw error;
  }
}
