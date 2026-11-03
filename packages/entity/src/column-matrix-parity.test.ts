// Every column kind and every `arrayOf()` element kind, round-tripped through `postgresDriver()`
// over PGlite and compared with `memoryDriver()` — the embedded half of the matrix
// `column-matrix.live.test.ts` runs on `Bun.SQL`. The two drivers decode a cell by different
// tables (PGlite parses `uuid[]`, `Bun.SQL` hands back its literal), so green here says nothing
// about a server and green there says nothing about `x dev`: both are the bar.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { columnMatrixCases, createMatrixTable } from './column-matrix-fixture';
import { text, uuid } from './columns';
import { bigint, decimal } from './columns-data';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const amounts = entity('matrix_unique_amounts', {
  columns: { id: uuid().primaryKey(), d: decimal().unique(), label: text({ max: 8 }).nullable() },
});
const bounded = entity('matrix_unique_bounded', {
  columns: { id: uuid().primaryKey(), d: decimal({ precision: 10, scale: 2 }).unique() },
});
const counters = entity('matrix_unique_counters', {
  columns: { id: uuid().primaryKey(), n: bigint().unique(), label: text({ max: 8 }).nullable() },
});
const UNIQUE = { amounts, bounded, counters };

const PGLITE_BOOT_MS = 30_000;
const client = pgliteClient();

beforeAll(async () => {
  setDbClient(client);
  await createMatrixTable(client);
  const migration = generateMigration({
    entities: [amounts.$describe(), bounded.$describe(), counters.$describe()],
    name: 'decimal unique parity',
    now: new Date('2026-11-02T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

describe('pglite · every column kind round-trips', () => {
  columnMatrixCases(() => postgresDriver());
});

/**
 * One value, two spellings, one unique index. Unbounded `numeric` keeps the scale it was given, so
 * `'2.5'` and `'2.50'` both reach the store as written: Postgres compares them as one, and memory
 * compared the text and stored both.
 */
const DRIVERS: readonly (readonly [string, () => Driver])[] = [
  ['memory', () => memoryDriver()],
  ['pglite', () => postgresDriver()],
];

for (const [name, driver] of DRIVERS) {
  describe(`${name} · a unique decimal is one value`, () => {
    const db = () => database(UNIQUE, { driver: driver() });
    const refused = (work: Promise<unknown>): Promise<unknown> =>
      work.then(
        () => 'stored',
        (error: unknown) => (isUltimateError(error) ? error.code : `not coded: ${String(error)}`),
      );

    beforeEach(async () => {
      for (const one of Object.values(UNIQUE)) {
        await client.execute(raw(`delete from "${one.$name}"`));
      }
    });

    test('unbounded: 2.5 and 2.50 collide', async () => {
      const handle = db();
      await handle.amounts.insert({ d: '2.5' });
      expect(await refused(handle.amounts.insert({ d: '2.50' }))).toBe('X_DB_UNIQUE_VIOLATION');
      expect(await handle.amounts.where({ d: '2.500' }).all()).toHaveLength(1);
    });

    test('unbounded: 2.5 and 2.51 do not', async () => {
      const handle = db();
      await handle.amounts.insert({ d: '2.5' });
      expect(await refused(handle.amounts.insert({ d: '2.51' }))).toBe('stored');
    });

    test('numeric(10,2) already refused, and stays refused', async () => {
      const handle = db();
      await handle.bounded.insert({ d: '2.5' });
      expect(await refused(handle.bounded.insert({ d: '2.50' }))).toBe('X_DB_UNIQUE_VIOLATION');
    });

    test('an upsert on the same target lands on the one row', async () => {
      const handle = db();
      await handle.amounts.upsertAll([{ d: '2.5', label: 'a' }], {
        onConflict: ['d'],
        onMatch: 'update',
      });
      await handle.amounts.upsertAll([{ d: '2.50', label: 'b' }], {
        onConflict: ['d'],
        onMatch: 'update',
      });
      const rows = await handle.amounts.all();
      expect(rows.map((row) => row.label)).toEqual(['b']);
    });

    test('a batch repeating one value under two spellings is refused, not half-written', async () => {
      const handle = db();
      const outcome = await refused(
        handle.amounts.upsertAll(
          [
            { d: '2.5', label: 'a' },
            { d: '2.50', label: 'b' },
          ],
          { onConflict: ['d'], onMatch: 'update' },
        ),
      );
      expect(outcome).not.toBe('stored');
      expect(await handle.amounts.all()).toHaveLength(0);
    });
  });
}
