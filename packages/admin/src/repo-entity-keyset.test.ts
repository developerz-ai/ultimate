// The admin's keyset walked to EXHAUSTION over the memory driver, in both directions: ten rows
// sharing one sort value at page size 3, a nullable sort column, and an instant every row shares.
// Every row is served exactly once, in the order page one promised. `repo-entity-keyset.contract`
// runs the same walks against a real Postgres.

import { afterAll, describe, expect, test } from 'bun:test';
import {
  clearRegistry,
  database,
  entity,
  integer,
  memoryDriver,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import { walkBackward, walkForward } from './keyset-walk-fixture';
import type { AdminSort } from './registry';
import { adminRepoFor } from './repo-entity';
import { adminResource } from './resource';

const ranked = entity('admin_keyset_ranked', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 20 }),
    rank: integer().nullable(),
    at: timestamp(),
  },
});

afterAll(clearRegistry);

const AT = new Date('2026-03-01T10:20:45.123Z');

/** A fresh table per test: `ranks` in insertion order, every row at the same instant. */
const seeded = async (ranks: readonly (number | null)[]) => {
  const table = database({ ranked }, { driver: memoryDriver() }).ranked;
  const repo = adminRepoFor(ranked, table);
  const ids: string[] = [];
  for (const [index, rank] of ranks.entries()) {
    ids.push(String((await repo.create({ title: `r${index}`, rank, at: AT }))['id']));
  }
  return { ids, resource: adminResource(ranked, { pageSize: 3, repo }) };
};

const TEN_TIES = Array.from({ length: 10 }, () => 7);
const NULLS_AND_VALUES = [null, 2, null, 1, null, 3, null, 4];

describe('unit · the admin keyset is total over (sort, id)', () => {
  for (const direction of ['asc', 'desc'] as const) {
    test(`ten rows with one sort value at page size 3 — every row, once, walking ${direction}`, async () => {
      const { ids, resource } = await seeded(TEN_TIES);
      const sort: AdminSort = { field: 'rank', direction };
      const forward = await walkForward(resource, sort);
      expect(forward).toHaveLength(10);
      expect(new Set(forward)).toEqual(new Set(ids));
      // Back from the last page to the first, and the same order read in reverse.
      expect(await walkBackward(resource, sort)).toEqual(forward);
    });

    test(`a nullable sort column — the null rows are reached, walking ${direction}`, async () => {
      const { ids, resource } = await seeded(NULLS_AND_VALUES);
      const sort: AdminSort = { field: 'rank', direction };
      const forward = await walkForward(resource, sort);
      expect(forward).toHaveLength(ids.length);
      expect(new Set(forward)).toEqual(new Set(ids));
      expect(await walkBackward(resource, sort)).toEqual(forward);
    });

    test(`one instant shared by every row — the default sort's tie — walking ${direction}`, async () => {
      const { ids, resource } = await seeded(TEN_TIES);
      const sort: AdminSort = { field: 'at', direction };
      const forward = await walkForward(resource, sort);
      expect(new Set(forward)).toEqual(new Set(ids));
      expect(forward).toHaveLength(10);
      expect(await walkBackward(resource, sort)).toEqual(forward);
    });
  }

  test('nulls sort last ascending and first descending, as the handle orders them', async () => {
    const { resource } = await seeded(NULLS_AND_VALUES);
    const ranks = async (direction: 'asc' | 'desc') => {
      const order = await walkForward(resource, { field: 'rank', direction }, 'rank');
      return order;
    };
    expect(await ranks('asc')).toEqual(['1', '2', '3', '4', 'null', 'null', 'null', 'null']);
    expect(await ranks('desc')).toEqual(['null', 'null', 'null', 'null', '4', '3', '2', '1']);
  });
});
