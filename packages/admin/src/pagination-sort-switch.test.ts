// A cursor carries the sort field it was issued under. Replayed under another `?sort=` — a
// bookmark, or an operator clicking a column header on page three — its boundary value belongs to
// a different column, and seeking by it lands anywhere: an empty page with a Previous link. The
// promise `decodeAdminCursor` makes for any cursor it cannot honour is page one.

import { afterAll, expect, test } from 'bun:test';
import {
  clearRegistry,
  database,
  entity,
  integer,
  memoryDriver,
  money,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import { pageRequestOf } from './list-request';
import { fetchPage, listQuery } from './pagination';
import type { AdminSort } from './registry';
import { adminRepoFor } from './repo-entity';
import { adminResource } from './resource';

const switched = entity('admin_page_sort_switch', {
  columns: { id: uuid().primaryKey(), title: text({ max: 20 }), rank: integer(), at: timestamp() },
});
afterAll(clearRegistry);

const byTitle: AdminSort = { field: 'title', direction: 'asc' };

async function seeded() {
  const table = database({ switched }, { driver: memoryDriver() }).switched;
  const repo = adminRepoFor(switched, table);
  for (let i = 0; i < 6; i++) {
    await repo.create({ title: `t${i}`, rank: 100 - i, at: new Date(Date.UTC(2026, 0, 1 + i)) });
  }
  return adminResource(switched, { pageSize: 2, repo });
}

test('a cursor replayed under another sort is page one of that sort, with no Previous', async () => {
  const resource = await seeded();
  const first = await fetchPage(resource, { sort: byTitle });
  expect(first.rows.map((row) => row['title'])).toEqual(['t0', 't1']);
  expect(first.nextCursor).not.toBeNull();

  const cases = [
    [{ field: 'rank', direction: 'asc' }, ['t5', 't4']],
    [{ field: 'at', direction: 'asc' }, ['t0', 't1']],
  ] as const;
  for (const [sort, expected] of cases) {
    // Both halves read the cursor: the query must not seek, and the page must not claim a past.
    expect(listQuery(resource, { sort, cursor: first.nextCursor })).not.toHaveProperty('after');
    const page = await fetchPage(resource, { sort, cursor: first.nextCursor });
    expect(page.rows.map((row) => row['title'])).toEqual([...expected]);
    expect(page.prevCursor).toBeNull();
  }
});

test('a Previous cursor replayed under another sort is page one too', async () => {
  const resource = await seeded();
  const first = await fetchPage(resource, { sort: byTitle });
  const second = await fetchPage(resource, { sort: byTitle, cursor: first.nextCursor });
  expect(second.prevCursor).not.toBeNull();
  const rank: AdminSort = { field: 'rank', direction: 'asc' };
  expect(listQuery(resource, { sort: rank, cursor: second.prevCursor })).not.toHaveProperty(
    'before',
  );
  const page = await fetchPage(resource, { sort: rank, cursor: second.prevCursor });
  expect(page.rows.map((row) => row['title'])).toEqual(['t5', 't4']);
  expect(page.prevCursor).toBeNull();
  expect(page.hasMore).toBe(true);
});

test('the same sort keeps paging: the guard compares the field, not the cursor', async () => {
  const resource = await seeded();
  const first = await fetchPage(resource, { sort: byTitle });
  const second = await fetchPage(resource, { sort: byTitle, cursor: first.nextCursor });
  expect(second.rows.map((row) => row['title'])).toEqual(['t2', 't3']);
  expect(second.prevCursor).not.toBeNull();
});

// A money sort is the pair (currency, minor), and its cursor carries both — a cursor issued under
// another sort is page one of it, as for any column, and a hand-typed `?sort=price` is a sort.
test('a money column is a sort: the URL names it, and a foreign cursor is its page one', async () => {
  const priced = entity('admin_page_sort_money', {
    columns: { id: uuid().primaryKey(), name: text({ max: 20 }), price: money() },
  });
  const table = database({ priced }, { driver: memoryDriver() }).priced;
  const repo = adminRepoFor(priced, table);
  for (const [name, minor] of [
    ['a', 300],
    ['b', 100],
    ['c', 200],
  ] as const) {
    await repo.create({ name, price: { currency: 'EUR', minor } });
  }
  const resource = adminResource(priced, { pageSize: 2, repo });
  const url = new URL('http://admin.test/admin/priced?sort=price:asc');
  const sort = pageRequestOf(resource, url).sort;
  expect(sort).toEqual({ field: 'price', direction: 'asc' });
  if (sort === undefined) return expect.unreachable('the URL named a sort');
  const byName = await fetchPage(resource, { sort: { field: 'name', direction: 'asc' } });
  const page = await fetchPage(resource, { sort, cursor: byName.nextCursor });
  expect(page.rows.map((row) => row['name'])).toEqual(['b', 'c']);
  expect(page.prevCursor).toBeNull();
  const next = await fetchPage(resource, { sort, cursor: page.nextCursor });
  expect(next.rows.map((row) => row['name'])).toEqual(['a']);
});
