// `keyset()` on the real embedded engine: the microsecond walk `keyset.live.test.ts` runs on a
// Postgres server, here on PGlite, which every unit run has — so the precision rule is proven
// without services.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DESCENDING, firstPagePlan, seedKeysetTable, walkKeyset } from './keyset-walk-fixture';
import { pgliteClient } from './pglite';

const PGLITE_BOOT_MS = 30_000;

describe('keyset() · the real embedded database', () => {
  const client = pgliteClient();

  beforeAll(async () => {
    await seedKeysetTable(client, 5_000);
  }, PGLITE_BOOT_MS);

  afterAll(async () => {
    await client.close();
  });

  test('desc and asc, one row a page, visit every row inside one millisecond', async () => {
    expect(await walkKeyset(client, 'desc', 1)).toEqual(DESCENDING);
    expect(await walkKeyset(client, 'asc', 1)).toEqual([...DESCENDING].reverse());
  });

  test('a page boundary inside the millisecond neither drops nor repeats a row', async () => {
    expect(await walkKeyset(client, 'desc', 2)).toEqual(DESCENDING);
    expect(await walkKeyset(client, 'asc', 3)).toEqual([...DESCENDING].reverse());
  });

  test('the first page plans on the index, with no sort', async () => {
    const plan = await firstPagePlan(client);
    expect(plan).toContain('Index');
    expect(plan).not.toContain('Sort');
  });
});
