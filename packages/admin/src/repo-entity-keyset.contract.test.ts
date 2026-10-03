// The admin's keyset against a REAL Postgres (embedded PGlite): ten rows sharing one sort value at
// page size 3, a nullable sort column, and the case only a server can hold — instants that differ
// in the MICROSECONDS a row's `Date` drops. Walked to the end and back; every row exactly once.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createPgliteClient,
  generateMigration,
  raw,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import {
  clearRegistry,
  database,
  entity,
  integer,
  postgresDriver,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import { walkBackward, walkForward } from './keyset-walk-fixture';
import type { AdminSort } from './registry';
import { adminRepoFor } from './repo-entity';
import { adminResource } from './resource';

// A WASM compile plus an initdb, against bun's 5s default — a hang detector, not a budget.
const PGLITE_BOOT_MS = 60_000;

const ranked = entity('admin_kc_ranked', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 20 }),
    rank: integer().nullable(),
    at: timestamp(),
  },
});

const client = createPgliteClient();
const table = (): ReturnType<typeof database<{ ranked: typeof ranked }>>['ranked'] =>
  database({ ranked }, { driver: postgresDriver() }).ranked;
const resource = () => adminResource(ranked, { pageSize: 3, repo: adminRepoFor(ranked, table()) });

/** Ids in a known order: the hex digit is the row's place in id order. */
const idAt = (n: number): string => `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

/** Rows written by SQL, so an instant can carry microseconds no `Date` can. */
const insert = async (
  rows: readonly (readonly [number, number | null, string])[],
): Promise<void> => {
  for (const [n, rank, at] of rows) {
    await client.execute(
      raw(
        `insert into "admin_kc_ranked" ("id", "title", "rank", "at") values ('${idAt(n)}', 'r${n}', ${rank === null ? 'null' : String(rank)}, '${at}')`,
      ),
    );
  }
};

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [ranked.$describe()],
    name: 'admin keyset contract',
    now: new Date('2026-10-02T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

beforeEach(async () => {
  await client.execute(raw('delete from "admin_kc_ranked"'));
});

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

const ALL_TEN = Array.from({ length: 10 }, (_, n) => idAt(n + 1));

describe('contract · the admin keyset on Postgres', () => {
  for (const direction of ['asc', 'desc'] as const) {
    test(`ten rows with one sort value at page size 3, walking ${direction}`, async () => {
      await insert(ALL_TEN.map((_, n) => [n + 1, 7, '2026-03-01T10:20:45.123Z'] as const));
      const sort: AdminSort = { field: 'rank', direction };
      const forward = await walkForward(resource(), sort);
      expect(forward).toEqual(direction === 'asc' ? ALL_TEN : [...ALL_TEN].reverse());
      expect(await walkBackward(resource(), sort)).toEqual(forward);
    });

    test(`a nullable sort column — every NULL row is reached, walking ${direction}`, async () => {
      await insert([
        [1, null, '2026-03-01T00:00:00Z'],
        [2, 2, '2026-03-01T00:00:00Z'],
        [3, null, '2026-03-01T00:00:00Z'],
        [4, 1, '2026-03-01T00:00:00Z'],
        [5, null, '2026-03-01T00:00:00Z'],
        [6, 3, '2026-03-01T00:00:00Z'],
        [7, null, '2026-03-01T00:00:00Z'],
      ]);
      const sort: AdminSort = { field: 'rank', direction };
      const forward = await walkForward(resource(), sort);
      // NULL is the largest value: last ascending, first descending — the id breaking every tie.
      const order = direction === 'asc' ? [4, 2, 6, 1, 3, 5, 7] : [7, 5, 3, 1, 6, 2, 4];
      expect(forward).toEqual(order.map(idAt));
      expect(await walkBackward(resource(), sort)).toEqual(forward);
    });

    test(`one shared instant, as a bulk insert stamps it, walking ${direction}`, async () => {
      await insert(ALL_TEN.map((_, n) => [n + 1, 1, '2026-03-01T10:20:45.123456Z'] as const));
      const sort: AdminSort = { field: 'at', direction };
      const forward = await walkForward(resource(), sort);
      expect(forward).toEqual(direction === 'asc' ? ALL_TEN : [...ALL_TEN].reverse());
      expect(await walkBackward(resource(), sort)).toEqual(forward);
    });

    test(`instants one MILLISECOND apart only in microseconds — none dropped, walking ${direction}`, async () => {
      // Microseconds run AGAINST id order inside the one millisecond, and a second millisecond
      // follows: the order the server sorts by and the order a cursor can name disagree.
      await insert([
        ...ALL_TEN.slice(0, 7).map(
          (_, n) =>
            [
              n + 1,
              1,
              `2026-03-01T10:20:45.123${String(900 - n * 100).padStart(3, '0')}Z`,
            ] as const,
        ),
        ...ALL_TEN.slice(7).map((_, n) => [n + 8, 1, `2026-03-01T10:20:45.12${5 + n}Z`] as const),
      ]);
      const sort: AdminSort = { field: 'at', direction };
      const forward = await walkForward(resource(), sort);
      expect(new Set(forward)).toEqual(new Set(ALL_TEN));
      expect(forward).toHaveLength(10);
      expect(await walkBackward(resource(), sort)).toEqual(forward);
    });

    test(`a page that OPENS on a millisecond of distinct microseconds walks back to itself, ${direction}`, async () => {
      // Page one is the first millisecond whole; page two opens on a second one whose two rows
      // sort by microseconds against their ids — Previous from it must not re-serve either.
      await insert([
        [1, 1, '2026-03-01T10:20:45.100000Z'],
        [2, 1, '2026-03-01T10:20:45.100000Z'],
        [3, 1, '2026-03-01T10:20:45.100000Z'],
        [4, 1, '2026-03-01T10:20:45.200900Z'],
        [5, 1, '2026-03-01T10:20:45.200100Z'],
        [6, 1, '2026-03-01T10:20:45.300000Z'],
      ]);
      const sort: AdminSort = { field: 'at', direction };
      const forward = await walkForward(resource(), sort);
      const ascending = [1, 2, 3, 4, 5, 6].map(idAt);
      expect(forward).toEqual(direction === 'asc' ? ascending : [...ascending].reverse());
      expect(await walkBackward(resource(), sort)).toEqual(forward);
    });
  }
});
