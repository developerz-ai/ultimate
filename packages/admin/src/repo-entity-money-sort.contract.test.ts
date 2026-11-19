// The money sort against a REAL Postgres (embedded PGlite): `<p>_currency`, then `<p>_minor`, the
// id breaking ties, NULL last ascending — the order `repo-entity-money-sort.test.ts` walks over the
// memory driver, here decided by the server's own `order by` and row comparisons.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { clearRegistry, database, entity, money, postgresDriver, uuid } from '@ultimat3/entity';
import { walkBackward, walkForward } from './keyset-walk-fixture';
import { MONEY_ROWS, moneyOrder } from './money-sort-fixture';
import type { AdminSort } from './registry';
import { adminRepoFor } from './repo-entity';
import { adminResource } from './resource';

// A WASM compile plus an initdb, against bun's 5s default — a hang detector, not a budget.
const PGLITE_BOOT_MS = 60_000;

const priced = entity('admin_kc_priced', {
  columns: { id: uuid().primaryKey(), price: money().nullable() },
});

const client = pgliteClient();
const repo = () => adminRepoFor(priced, database({ priced }, { driver: postgresDriver() }).priced);

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [priced.$describe()],
    name: 'admin money sort contract',
    now: new Date('2026-11-19T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

beforeEach(async () => {
  await client.execute(raw('delete from "admin_kc_priced"'));
});

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

describe('contract · the money sort on Postgres', () => {
  for (const direction of ['asc', 'desc'] as const) {
    test(`a money column sorts by currency then minor, ${direction}, and pages without skipping or repeating a row`, async () => {
      const own = repo();
      const rows: { id: string; price: (typeof MONEY_ROWS)[number] }[] = [];
      for (const price of MONEY_ROWS) {
        rows.push({ id: String((await own.create({ price }))['id']), price });
      }
      const resource = adminResource(priced, { pageSize: 3, repo: own });
      const sort: AdminSort = { field: 'price', direction };
      const forward = await walkForward(resource, sort);
      expect(forward).toEqual(moneyOrder(rows, direction));
      expect(await walkBackward(resource, sort)).toEqual(forward);
    });
  }
});
