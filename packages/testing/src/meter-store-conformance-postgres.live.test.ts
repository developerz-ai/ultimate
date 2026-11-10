// The meter-store suite over `postgresMeterStore` and a real Postgres (`TEST_DATABASE_URL`), on a
// pool of eight connections: the parallel draws really do race on the row.

import { afterAll, beforeAll, describe } from 'bun:test';
import { postgresMeterStore, SQL_METER_TABLE } from '@ultimat3/action';
import type { MeterStore } from '@ultimat3/action/adapter';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import { meterStoreConformance } from './meter-store-conformance';
import { behavesLike } from './shared-examples';
import type { WorkerDatabase } from './template-db';
import { acquireWorkerDatabase } from './template-db';
import { testName } from './test-types';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

describe.skipIf(adminUrl === '')(testName('live', 'the postgres meter store'), () => {
  let db: WorkerDatabase | undefined;
  let client: PostgresClient | undefined;
  let store: MeterStore | undefined;

  beforeAll(async () => {
    db = await acquireWorkerDatabase({ adminUrl, templateName: 'ultimate_meter_conformance' });
    const pool = postgresClient({ url: db.url, role: 'web', profile: { max: 8 } });
    client = pool;
    await pool.execute(raw(SQL_METER_TABLE));
    store = postgresMeterStore({ executor: dbExecutor(() => pool) });
  });

  // Both run, whatever the first does; the first failure is the one reported.
  afterAll(async () => {
    const failures: unknown[] = [];
    await Promise.resolve(client?.close()).catch((error: unknown) => failures.push(error));
    await Promise.resolve(db?.drop()).catch((error: unknown) => failures.push(error));
    if (failures.length > 0) throw failures[0];
  });

  behavesLike(meterStoreConformance, () => store as MeterStore);
});
