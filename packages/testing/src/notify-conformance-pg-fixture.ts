// One worker database for a store conformance suite over real Postgres (`TEST_DATABASE_URL`): the
// framework tables' DDL applied once, the executor the boot builds (`@ultimat3/db`'s client), and
// the drop in `afterAll`. Shared by the notify and push live suites; every check names its own rows.

import { afterAll, beforeAll, expect } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { postgresClient, raw } from '@ultimat3/db';
import type { WorkerDatabase } from './template-db';
import { acquireWorkerDatabase } from './template-db';

export const CONFORMANCE_ADMIN_URL = Bun.env['TEST_DATABASE_URL'] ?? '';

export interface ConformanceDatabase {
  /** The boot's executor shape over this worker's database. */
  readonly executor: PgExecutor;
  /** The worker database's URL, for a check that needs a connection of its own. */
  url(): string;
}

/** Registers the hooks; call at describe scope, inside a `describe.skipIf(admin url unset)`. */
export function conformanceDatabase(
  templateName: string,
  ddl: readonly string[],
): ConformanceDatabase {
  let db: WorkerDatabase | undefined;
  let client: PostgresClient | undefined;

  beforeAll(async () => {
    db = await acquireWorkerDatabase({ adminUrl: CONFORMANCE_ADMIN_URL, templateName });
    client = postgresClient({ url: db.url });
    for (const statement of ddl.flatMap((each) => each.split(';'))) {
      if (statement.trim().length > 0) await client.execute(raw(statement));
    }
  }, 60_000);

  // Both run, whatever the first does; the first failure is the one reported.
  afterAll(async () => {
    const failures: unknown[] = [];
    await Promise.resolve(client?.close()).catch((error: unknown) => failures.push(error));
    await Promise.resolve(db?.drop()).catch((error: unknown) => failures.push(error));
    if (failures.length > 0) throw failures[0];
  }, 60_000);

  return {
    executor: {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        client === undefined
          ? expect.unreachable('beforeAll opened no database')
          : client.query<R>({ text, values }),
    },
    url: () => db?.url ?? expect.unreachable('beforeAll opened no database'),
  };
}
