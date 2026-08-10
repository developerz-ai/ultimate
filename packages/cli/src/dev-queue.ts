// The database and the job queue, started together and released together. Split from
// `dev-runtime.ts` because `x jobs` needs exactly this pair and nothing else — and because a
// process that installs two ambient accessors (`db()`, `jobDriver()`) must have one place that
// takes both back, or the next command in the same process inherits a driver over a closed socket.

import type { PgliteClient, PostgresClient, SqlFragment } from '@ultimat3/db';
import {
  createPgliteClient,
  createPostgresClient,
  pgliteDataDir,
  raw,
  setDbClient,
} from '@ultimat3/db';
import type { JobDriver, PgExecutor } from '@ultimat3/jobs';
import { createPgDriver, resetJobDriver, SQL_JOBS_TABLE, setJobDriver } from '@ultimat3/jobs';
import type { DevServices } from './dev-services';

/** Both embedded and external clients boot lazily and close explicitly. */
export type DevDbClient = PgliteClient | PostgresClient;

export interface RunningQueue {
  readonly db: DevDbClient;
  readonly jobs: JobDriver;
  stop(): Promise<void>;
}

function startDb(services: DevServices): DevDbClient {
  const binding = services.db;
  const client =
    binding.mode === 'embedded'
      ? // `pgliteDataDir` is `@ultimat3/db`'s own reader of the `pglite://` form; a second parser
        // here is a second thing to keep right when the form changes.
        createPgliteClient({ dataDir: pgliteDataDir(binding.url) })
      : createPostgresClient({ url: binding.url });
  setDbClient(client);
  return client;
}

/**
 * `@ultimat3/jobs` deliberately depends on no database package: Postgres reaches it as an
 * injected `PgExecutor`. Boot code is what supplies one, and this is the boot.
 *
 * The fragment is assembled by hand rather than through `sql`` ` because the driver hands over
 * `$1..$n` text it wrote itself plus already-bound values — there is no interpolation to guard.
 */
function executorFor(client: DevDbClient): PgExecutor {
  return {
    query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
      client.query<R>({ text, values } satisfies SqlFragment),
  };
}

/**
 * The dev queue is the real Postgres queue on the embedded Postgres — claiming, leases and the
 * one-live-job-per-key index all behave here exactly as in production. A memory queue in dev
 * would hide every bug this driver exists to make impossible.
 *
 * PGlite speaks the extended protocol, which carries one statement per round trip, so the DDL
 * is applied statement by statement. Safe to split on `;`: `SQL_JOBS_TABLE` is a fixed constant
 * with no semicolon inside a literal, and `driver-pg-sql.test.ts` is where that stays true.
 */
async function startJobs(client: DevDbClient): Promise<JobDriver> {
  for (const statement of SQL_JOBS_TABLE.split(';')) {
    if (statement.trim().length > 0) await client.execute(raw(statement));
  }
  const driver = createPgDriver({ executor: executorFor(client) });
  setJobDriver(driver);
  return driver;
}

/**
 * Release both ambient accessors, then the resources behind them, in that order: a driver reset
 * after its database is closed leaves a window where `jobDriver()` answers over a dead socket.
 * A stale driver is worse than none — the next command sees one installed and skips queue
 * startup entirely, so every query it makes fails on a connection this process already dropped.
 */
async function releaseQueue(db: DevDbClient, jobs: JobDriver | undefined): Promise<void> {
  resetJobDriver();
  setDbClient(undefined);
  await jobs?.close?.();
  await db.close();
}

/**
 * The db + jobs half of `startServices`, alone: `x jobs` needs a real queue and nothing else —
 * no transport, no storage, no mail — and booting those for a command that never reports on them
 * would pay for services it cannot even use. `startServices` builds on this so there is one boot
 * path for "which database" and "which queue", not two.
 */
export async function startQueue(services: DevServices): Promise<RunningQueue> {
  const db = startDb(services);
  try {
    // Pay the Postgres boot here, so the first request is not the slow one and a broken database
    // fails at boot rather than on some later query.
    await db.ping();
    const jobs = await startJobs(db);
    return { db, jobs, stop: () => releaseQueue(db, jobs) };
  } catch (error) {
    // `db.ping()` or `startJobs` is where a broken database is supposed to fail. Without this,
    // the caller exits holding the PGlite lock and the ambient accessors, and nothing is left to
    // release them. The rejection that started the unwind is the one worth reporting.
    try {
      await releaseQueue(db, undefined);
    } catch {
      // Cleanup noise never replaces the boot failure.
    }
    throw error;
  }
}
