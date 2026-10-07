// The conformance suite over the pg driver and a real Postgres (`TEST_DATABASE_URL`): the memory
// run proves the checks, this one proves the statements meet them. One worker database, the queue
// DDL applied once; every check claims only from a queue it named, so they share it.

import { afterAll, beforeAll, describe } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { postgresClient, raw } from '@ultimat3/db';
import { postgresJobDriver, SQL_JOBS_TABLE } from '@ultimat3/jobs';
import { jobDriverConformance } from './job-driver-conformance';
import { behavesLike } from './shared-examples';
import type { WorkerDatabase } from './template-db';
import { acquireWorkerDatabase } from './template-db';
import { testName } from './test-types';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

describe.skipIf(adminUrl === '')(testName('live', 'the pg job driver'), () => {
  let db: WorkerDatabase | undefined;
  let client: PostgresClient | undefined;

  beforeAll(async () => {
    db = await acquireWorkerDatabase({ adminUrl, templateName: 'ultimate_job_conformance' });
    client = postgresClient({ url: db.url });
    await client.execute(raw(SQL_JOBS_TABLE));
  });

  // Both run, whatever the first does; the first failure is the one reported.
  afterAll(async () => {
    const failures: unknown[] = [];
    await Promise.resolve(client?.close()).catch((error: unknown) => failures.push(error));
    await Promise.resolve(db?.drop()).catch((error: unknown) => failures.push(error));
    if (failures.length > 0) throw failures[0];
  });

  // The executor the boot builds (`pgExecutorFor`, `@ultimat3/cli`): the db client's own query.
  const executor: PgExecutor = {
    query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
      (client as PostgresClient).query<R>({ text, values }),
  };

  behavesLike(jobDriverConformance, () => postgresJobDriver({ executor }));
});
