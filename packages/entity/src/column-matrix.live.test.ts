// Every column kind and every `arrayOf()` element kind, round-tripped through `Bun.SQL` against a
// real Postgres and compared with `memoryDriver()` — the test that would have caught `uuid[]`
// arriving as its array LITERAL (`'{01a1…}'`) and being refused by `arrayOf(uuid())` in production
// while PGlite, which every other suite and `x dev` run on, decoded it. A driver decides per type
// oid and per protocol what a cell is, so the proof is one row of every kind through every read
// path, on the driver production uses. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe } from 'bun:test';
import { type PostgresClient, postgresClient, setDbClient } from '@ultimat3/db';
import { columnMatrixCases, createMatrixTable, dropMatrixTable } from './column-matrix-fixture';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

describe.skipIf(!hasPostgres)('live · postgres · every column kind round-trips on Bun.SQL', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = postgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await createMatrixTable(client);
  });

  afterAll(async () => {
    await dropMatrixTable(client);
    await client.close();
    setDbClient(undefined);
  });

  columnMatrixCases(() => postgresDriver());
});

// Outside the block above and unconditional: bun runs no hook inside a skipped `describe`, and the
// registry is process-wide. `live-registry-cleanup.test.ts` is the rule that keeps it here.
afterAll(() => {
  clearRegistry();
});
