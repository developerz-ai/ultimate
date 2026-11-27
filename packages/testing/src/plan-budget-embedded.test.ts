// `expectPlanWithin` against the embedded Postgres: a real plan, real parameters, a read-only
// transaction. Costs are PGlite's: a budget set here is for this engine, not for a server.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgliteClient } from '@ultimat3/db';
import { pgliteClient, raw, sql } from '@ultimat3/db';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import { expectPlanWithin } from './plan-budget';
import { testName } from './test-types';

const pbItems = entity('pb_items', {
  columns: { id: uuid().primaryKey(), owner: text({ max: 40 }), title: text({ max: 40 }) },
});

let client: PgliteClient;
beforeAll(async () => {
  client = pgliteClient();
  await client.execute(raw('create table pb_items (id uuid primary key, owner text, title text)'));
  await client.execute(
    raw(
      "insert into pb_items select gen_random_uuid(), 'o' || (i % 50), md5(i::text) from generate_series(1, 5000) i",
    ),
  );
  await client.execute(raw('analyze pb_items'));
}, 60_000);
afterAll(async () => {
  await client.close();
  clearRegistry();
});

const byOwner = (owner: string) => sql`select * from pb_items where owner = ${owner}`;
const sortedBy = sql`select * from pb_items order by title limit 10`;

describe(testName('unit', 'expectPlanWithin · embedded'), () => {
  test('a keyed read inside a generous budget passes', async () => {
    await expectPlanWithin(
      byOwner('o1'),
      { maxCost: 1_000_000, maxSortRows: 1_000_000 },
      { client },
    );
  }, 60_000);

  test('the cost budget refuses, with the numbers in meta and analyze as the fix', async () => {
    const error = await expectPlanWithin(
      byOwner('o1'),
      { maxCost: 1, maxSortRows: 1_000_000 },
      { client },
    ).then(
      () => expect.unreachable('the budget of 1 must refuse a scan of 5000 rows'),
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'X_QUERY_PLAN_OVER_BUDGET' });
    const meta = (error as { meta: Record<string, unknown> }).meta;
    expect(meta['table']).toBe('pb_items');
    expect(meta['totalCost']).toBeGreaterThan(1);
    expect((error as { fix: string }).fix).toContain('analyze pb_items');
  }, 60_000);

  test('the sort budget refuses a sort over more rows, and names the index when entities are given', async () => {
    const error = await expectPlanWithin(
      sortedBy,
      { maxCost: 1_000_000, maxSortRows: 10 },
      { client, entities: [pbItems] },
    ).then(
      () => expect.unreachable('a top-N sort over 5000 rows must break a sort budget of 10'),
      (e: unknown) => e,
    );
    const meta = (error as { meta: Record<string, unknown> }).meta;
    expect(meta['node']).toBe('Sort');
    expect(meta['sortRows']).toBeGreaterThan(10);
    expect((error as { fix: string }).fix).toContain("indexes: [{ on: ['title'] }]");
  }, 60_000);

  test('it never executes the statement: a write is refused by the read-only transaction', async () => {
    const before = await client.one<{ n: string }>(sql`select count(*)::text as n from pb_items`);
    await expect(
      expectPlanWithin(
        sql`delete from pb_items where owner = ${'o1'}`,
        { maxCost: 1_000_000, maxSortRows: 1_000_000 },
        { client },
      ),
    ).resolves.toBeUndefined();
    const after = await client.one<{ n: string }>(sql`select count(*)::text as n from pb_items`);
    expect(after?.n).toBe(before?.n);
  }, 60_000);
});
