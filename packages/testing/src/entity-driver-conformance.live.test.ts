// The entity driver suite over `postgresDriver()` and a real Postgres (`TEST_DATABASE_URL`): PGlite
// proves the driver's meaning on one connection, this proves it on a pool — real row locks, real
// advisory locks, `Bun.SQL`'s own decoding. One worker database; each check re-creates its tables.

import { afterAll, beforeAll, describe } from 'bun:test';
import type { PostgresClient } from '@ultimat3/db';
import { postgresClient, setDbClient } from '@ultimat3/db';
import { sqlSubject } from './entity-conformance-sql-fixture';
import { entityDriverConformance } from './entity-driver-conformance';
import { behavesLike } from './shared-examples';
import type { WorkerDatabase } from './template-db';
import { acquireWorkerDatabase } from './template-db';
import { testName } from './test-types';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

describe.skipIf(adminUrl === '')(testName('live', 'the postgres entity driver'), () => {
  let db: WorkerDatabase | undefined;
  let client: PostgresClient | undefined;

  beforeAll(async () => {
    db = await acquireWorkerDatabase({ adminUrl, templateName: 'ultimate_entity_conformance' });
    client = postgresClient({ url: db.url });
    setDbClient(client);
  });

  // Both run, whatever the first does; the first failure is the one reported.
  afterAll(async () => {
    setDbClient(undefined);
    const failures: unknown[] = [];
    await Promise.resolve(client?.close()).catch((error: unknown) => failures.push(error));
    await Promise.resolve(db?.drop()).catch((error: unknown) => failures.push(error));
    if (failures.length > 0) throw failures[0];
  });

  behavesLike(entityDriverConformance, () => sqlSubject(() => client as PostgresClient));
});
