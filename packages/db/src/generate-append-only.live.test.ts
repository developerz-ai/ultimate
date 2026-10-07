// `entity({ appendOnly: true })` on a real Postgres: the generated trigger refuses a raw UPDATE, a
// raw DELETE and an upsert's conflict arm with the stable message and SQLSTATE, drift sees it go
// missing or disabled, the finding's repair restores it, and turning the flag off releases the rows.

import { afterAll, beforeAll, describe, test } from 'bun:test';
import { type PostgresClient, postgresClient } from './client';
import { proveAppendOnlyTrigger } from './generate-append-only-fixture';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

describe.skipIf(!hasPostgres)('live · postgres · the append-only trigger', () => {
  let client: PostgresClient;

  beforeAll(() => {
    client = postgresClient({ url: url ?? '' });
  });

  afterAll(async () => {
    await client.close();
  });

  test('refuses raw UPDATE and DELETE, is seen by drift, and goes with appendOnly', async () => {
    await proveAppendOnlyTrigger(client, 'aot_ledger_live');
  });
});
