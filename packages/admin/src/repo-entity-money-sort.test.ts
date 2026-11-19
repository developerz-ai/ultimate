// A `money()` column is a sort: (currency, minor) in the requested direction, the id breaking ties,
// NULL last ascending and first descending — amounts are only comparable within a currency, so the
// currency groups first. Walked to the end and back over the memory driver at page size 3: every
// row exactly once. `repo-entity-money-sort.contract.test.ts` walks the same rows on Postgres.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, database, entity, memoryDriver, money, uuid } from '@ultimat3/entity';
import { walkBackward, walkForward } from './keyset-walk-fixture';
import { MONEY_ROWS, moneyOrder } from './money-sort-fixture';
import type { AdminSort } from './registry';
import { adminRepoFor } from './repo-entity';
import { adminResource } from './resource';

const priced = entity('admin_money_sort', {
  columns: { id: uuid().primaryKey(), price: money().nullable() },
});

afterAll(clearRegistry);

const seeded = async () => {
  const repo = adminRepoFor(priced, database({ priced }, { driver: memoryDriver() }).priced);
  const rows: { id: string; price: { currency: string; minor: number } | null }[] = [];
  for (const price of MONEY_ROWS) {
    rows.push({ id: String((await repo.create({ price }))['id']), price });
  }
  return { rows, resource: adminResource(priced, { pageSize: 3, repo }) };
};

describe('unit · a money column sorts by currency, then minor', () => {
  test('it is offered as a sort, as the manifest has always listed it', async () => {
    const { resource } = await seeded();
    expect(resource.fields.find((field) => field.name === 'price')?.sortable).toBe(true);
  });

  for (const direction of ['asc', 'desc'] as const) {
    test(`a money column sorts by currency then minor, ${direction}, and pages without skipping or repeating a row`, async () => {
      const { rows, resource } = await seeded();
      const sort: AdminSort = { field: 'price', direction };
      const forward = await walkForward(resource, sort);
      expect(forward).toEqual(moneyOrder(rows, direction));
      expect(await walkBackward(resource, sort)).toEqual(forward);
    });
  }
});
