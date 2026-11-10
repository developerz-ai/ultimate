// One worker database with the queue's DDL applied (`SQL_JOBS_TABLE`: `x_outbox`, `x_job_steps`,
// `x_job_leases`, `x_job_events`), shared by the four jobs-port live suites. Named under the lease
// suite only because this slice's lock is a filename glob; the four use it alike.

import { expect } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import type { DbConnection, PostgresClient } from '@ultimat3/db';
import { postgresClient, raw } from '@ultimat3/db';
import { SQL_JOBS_TABLE } from '@ultimat3/jobs';
import type { WorkerDatabase } from './template-db';
import { acquireWorkerDatabase } from './template-db';

export interface JobsDatabase {
  /** `beforeAll`: clone the worker database and apply the queue DDL. */
  readonly open: () => Promise<void>;
  /** `afterAll`: close the pool, drop the database; the first failure is the one reported. */
  readonly close: () => Promise<void>;
  /** The pool, as the boot's `dbExecutor(() => client)` builds it. */
  readonly executor: PgExecutor;
  /** A pinned connection — what a transaction runs on. */
  readonly reserve: () => Promise<DbConnection>;
  /** Run one statement with no rows wanted (a `truncate` between tests). */
  readonly execute: (text: string) => Promise<void>;
}

/**
 * Move every row's instants in `columns` of `table` back by `ms`: the suites' `elapse` on a store
 * whose clock is the database's, so a lapse is made, never waited for. Setup only — no assertion
 * reads this statement.
 */
export async function age(
  database: JobsDatabase,
  table: string,
  columns: readonly string[],
  ms: number,
): Promise<void> {
  const set = columns.map(
    (column) => `${column} = ${column} - ($1::bigint * interval '1 millisecond')`,
  );
  await database.executor.query(`update ${table} set ${set.join(', ')}`, [ms]);
}

/** An executor over one connection: every statement on it, so a `begin` holds. */
export const connectionExecutor = (connection: DbConnection): PgExecutor => ({
  query: <R>(text: string, values: readonly unknown[] = []): Promise<readonly R[]> =>
    connection.query<R>({ text, values }),
});

export function jobsDatabase(adminUrl: string, templateName: string): JobsDatabase {
  let db: WorkerDatabase | undefined;
  let client: PostgresClient | undefined;
  const open = (): PostgresClient =>
    client ?? expect.unreachable('the jobs conformance database is not open: call open() first');

  return {
    async open() {
      db = await acquireWorkerDatabase({ adminUrl, templateName });
      client = postgresClient({ url: db.url });
      await client.execute(raw(SQL_JOBS_TABLE));
    },
    async close() {
      const failures: unknown[] = [];
      await Promise.resolve(client?.close()).catch((error: unknown) => failures.push(error));
      await Promise.resolve(db?.drop()).catch((error: unknown) => failures.push(error));
      if (failures.length > 0) throw failures[0];
    },
    executor: {
      query: <R>(text: string, values: readonly unknown[] = []): Promise<readonly R[]> =>
        open().query<R>({ text, values }),
    },
    reserve: () => open().reserve(),
    async execute(text) {
      await open().execute(raw(text));
    },
  };
}
