// `entity({ partitionBy })` on a real Postgres: monthly partitions created at apply time, an insert
// routed to its month, a row past every partition refused, retention detaching and dropping whole
// partitions, drift clean on the parent, and adoption on a plain table refused with the code.

import { afterAll, beforeAll, describe, test } from 'bun:test';
import { type PostgresClient, postgresClient } from './client';
import { proveBackfillFrom, provePartitioning } from './generate-partition-fixture';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

describe.skipIf(!hasPostgres)('live · postgres · entity({ partitionBy })', () => {
  let client: PostgresClient;

  beforeAll(() => {
    client = postgresClient({ url: url ?? '' });
  });

  afterAll(async () => {
    await client.close();
  });

  test('monthly partitions are created, an insert routes, retention drops a partition', async () => {
    await provePartitioning(client, 'gp_events_live');
  });

  test('a backfill target gets every partition back to its oldest row (from)', async () => {
    await proveBackfillFrom(client, 'gp_back_live');
  });
});
