// The failure-store suite over `@ultimat3/db`'s `postgresFailureStore` and a real Postgres
// (`TEST_DATABASE_URL`): the bundle round-trips `x_failures.bundle`, and the save leaves the
// failing request's transaction on another connection of the pool.

import { afterAll, beforeAll, describe } from 'bun:test';
import type { PostgresClient } from '@ultimat3/db';
import { postgresClient, postgresFailureStore, raw, SQL_FAILURES_TABLE } from '@ultimat3/db';
import type { FailureStoreSubject } from './failure-store-conformance';
import { failureStoreConformance } from './failure-store-conformance';
import { behavesLike } from './shared-examples';
import type { WorkerDatabase } from './template-db';
import { acquireWorkerDatabase } from './template-db';
import { testName } from './test-types';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

describe.skipIf(adminUrl === '')(testName('live', 'the postgres failure store'), () => {
  let db: WorkerDatabase | undefined;
  let client: PostgresClient | undefined;
  let subject: FailureStoreSubject | undefined;

  beforeAll(async () => {
    db = await acquireWorkerDatabase({ adminUrl, templateName: 'ultimate_failure_conformance' });
    const pool = postgresClient({ url: db.url, role: 'web', profile: { max: 4 } });
    client = pool;
    for (const statement of SQL_FAILURES_TABLE.split(';')) {
      if (statement.trim().length > 0) await pool.execute(raw(statement));
    }
    const store = postgresFailureStore({ client: pool });
    subject = { store, find: (id) => store.find(id), client: pool };
  });

  // Both run, whatever the first does; the first failure is the one reported.
  afterAll(async () => {
    const failures: unknown[] = [];
    await Promise.resolve(client?.close()).catch((error: unknown) => failures.push(error));
    await Promise.resolve(db?.drop()).catch((error: unknown) => failures.push(error));
    if (failures.length > 0) throw failures[0];
  });

  behavesLike(failureStoreConformance, () => subject as FailureStoreSubject);
});
