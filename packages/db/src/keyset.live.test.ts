// `keyset()` against a real Postgres: rows a millisecond `Date` cannot tell apart, walked across a
// page boundary both ways, and the plan the measured query gets — an index scan, no sort.
// `keyset-embedded.test.ts` is the same walk on PGlite.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type PostgresClient, postgresClient } from './client';
import {
  DESCENDING,
  firstPagePlan,
  KEYSET_TABLE,
  seedKeysetTable,
  walkKeyset,
} from './keyset-walk-fixture';
import { raw } from './sql';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

describe.skipIf(!hasPostgres)('live · postgres · keyset()', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = postgresClient({ url: adminUrl ?? '' });
    await seedKeysetTable(client, 50_000);
  });

  afterAll(async () => {
    await client.execute(raw(`drop table if exists ${KEYSET_TABLE}`));
    await client.close();
  });

  test('desc, one row a page, visits every row inside one millisecond', async () => {
    expect(await walkKeyset(client, 'desc', 1)).toEqual(DESCENDING);
  });

  test('asc, one row a page, visits every row inside one millisecond', async () => {
    expect(await walkKeyset(client, 'asc', 1)).toEqual([...DESCENDING].reverse());
  });

  test('a page boundary inside the millisecond neither drops nor repeats a row', async () => {
    expect(await walkKeyset(client, 'desc', 2)).toEqual(DESCENDING);
    expect(await walkKeyset(client, 'asc', 3)).toEqual([...DESCENDING].reverse());
  });

  test('the first page plans on the index, with no sort', async () => {
    const plan = await firstPagePlan(client);
    expect(plan).toContain(`Index Only Scan using ${KEYSET_TABLE}_order`);
    expect(plan).not.toContain('Sort');
  });
});
