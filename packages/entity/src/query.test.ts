// The chainable read is what an app actually writes, so this pins its two halves: the plan a
// chain describes, and the cursor page it terminates in. Every terminal goes through the same
// plan, which is why `all()`, `one()` and `count()` cannot quietly disagree with `page()`.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { integer, text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { MAX_PAGE_SIZE } from './plan';
import { tableFor } from './query';
import { clearRegistry } from './registry';
import { memoryRepo } from './repo';

const posts = entity('query_test_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text({ max: 120 }),
    likeCount: integer().default(0),
    createdAt: timestamp().defaultNow(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
});

type Post = typeof posts.$row;

const ORG = '00000000-0000-7000-8000-0000000000a1';
const OTHER = '00000000-0000-7000-8000-0000000000a2';
const AT = new Date('2026-02-01T00:00:00.000Z');

const id = (index: number): string =>
  `00000000-0000-7000-8000-0000000001${String(index).padStart(2, '0')}`;

const seed: readonly Post[] = [
  ...Array.from({ length: 5 }, (_, index) => ({
    id: id(index),
    orgId: ORG,
    title: `Post ${index}`,
    likeCount: index,
    createdAt: new Date(AT.getTime() + index * 1000),
    updatedAt: AT,
  })),
  { id: id(9), orgId: OTHER, title: 'Theirs', likeCount: 99, createdAt: AT, updatedAt: AT },
];

let table = tableFor(posts, memoryRepo(posts, seed));

beforeEach(() => {
  table = tableFor(posts, memoryRepo(posts, seed));
});

afterAll(() => {
  clearRegistry();
});

describe('the plan a chain describes', () => {
  test('where, andWhere, orderBy and limit accumulate in declaration order', () => {
    const plan = table
      .where({ orgId: ORG })
      .andWhere('likeCount', 'gte', 2)
      .orderBy('createdAt', 'desc')
      .orderBy('id')
      .limit(3)
      .plan();

    expect(plan.entity).toBe('query_test_posts');
    expect(plan.where).toEqual([
      { column: 'orgId', op: 'eq', value: ORG },
      { column: 'likeCount', op: 'gte', value: 2 },
    ]);
    expect(plan.orderBy).toEqual([
      { column: 'createdAt', direction: 'desc' },
      { column: 'id', direction: 'asc' },
    ]);
    expect(plan.limit).toBe(3);
    expect(plan.cursor).toBeUndefined();
  });

  test('the default page is bounded — an unbounded read is not expressible', () => {
    expect(table.plan().limit).toBe(50);
  });

  /**
   * The failure case: `limit(rows)` used to be `next({ limit: rows })` and nothing else, so an
   * action taking `pageSize` as input and passing it through bound whatever a client sent. The
   * refusal lands on the chain, where the author wrote the number — not one statement later, and
   * not after Postgres has already answered with five million rows.
   */
  test('a page size that would be a production incident is refused on the chain', () => {
    for (const rows of [5_000_000, MAX_PAGE_SIZE + 1, 0, -1, 2.5, Number.NaN]) {
      expect(() => table.limit(rows)).toThrow(/X_INVARIANT_VIOLATED|whole number of rows/);
    }
    // And the legal range still builds, ceiling included.
    expect(table.limit(MAX_PAGE_SIZE).plan().limit).toBe(MAX_PAGE_SIZE);
    expect(table.limit(1).plan().limit).toBe(1);
  });

  test('there is no offset on the builder, and there never will be', () => {
    expect('offset' in table).toBe(false);
    expect(Object.keys(table)).not.toContain('offset');
  });

  test('each link returns a new builder, so a base chain is reusable', async () => {
    const base = table.where({ orgId: ORG });
    const narrowed = base.andWhere('likeCount', 'gte', 4);

    expect(narrowed).not.toBe(base);
    expect(base.plan().where).toHaveLength(1);
    expect(await base.count()).toBe(5);
    expect(await narrowed.count()).toBe(1);
  });

  test('after(null) is the first page, and a cursor shows up in the plan', () => {
    expect(table.after(null).plan().cursor).toBeUndefined();
    expect(table.after('c_1').plan().cursor).toBe('c_1');
  });
});

describe('the terminals', () => {
  test('all() returns the rows the plan selects, tenant filter applied', async () => {
    const rows = await table.where({ orgId: ORG }).orderBy('createdAt').all();
    expect(rows.map((row) => row.title)).toEqual([
      'Post 0',
      'Post 1',
      'Post 2',
      'Post 3',
      'Post 4',
    ]);
  });

  test('one() takes a single row and answers null on a miss', async () => {
    const found = await table.where({ orgId: ORG, title: 'Post 3' }).one();
    expect(found?.id).toBe(id(3));
    expect(await table.where({ orgId: ORG, title: 'nope' }).one()).toBeNull();
  });

  test('count() counts the whole predicate, not the page', async () => {
    expect(await table.where({ orgId: ORG }).limit(2).count()).toBe(5);
  });

  test('select() narrows the rows and says so in the plan', async () => {
    const narrowed = table.where({ orgId: ORG }).orderBy('id').select({ id: true, title: true });
    const rows = await narrowed.all();

    expect(narrowed.plan().select).toEqual(['id', 'title']);
    expect(Object.keys(rows[0] ?? {})).toEqual(['id', 'title']);
    // The projection survives every terminal, not just `all()`.
    expect(Object.keys((await narrowed.page()).rows[0] ?? {})).toEqual(['id', 'title']);
    expect(Object.keys((await narrowed.one()) ?? {})).toEqual(['id', 'title']);
  });

  test('the tenancy guard fires on execution, not on a chain nobody runs', async () => {
    const unscoped = table.orderBy('createdAt').limit(2);
    await expect(unscoped.all()).rejects.toBeUltimateError('X_TENANCY_UNSCOPED');
    await expect(unscoped.page()).rejects.toBeUltimateError('X_TENANCY_UNSCOPED');
    await expect(unscoped.count()).rejects.toBeUltimateError('X_TENANCY_UNSCOPED');
  });
});

describe('page() and the cursor that continues it', () => {
  const feed = () => table.where({ orgId: ORG }).orderBy('createdAt').limit(2);

  test('pages cover every row exactly once and then stop', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await feed().after(cursor).page();
      seen.push(...result.rows.map((row) => row.id));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual([id(0), id(1), id(2), id(3), id(4)]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test('the cursor is opaque and signed — it is not the row it points at', async () => {
    const { nextCursor } = await feed().page();
    expect(nextCursor).not.toBeNull();
    expect(nextCursor).not.toContain(id(1));
    expect(nextCursor ?? '').toMatch(/^[\w-]+\.[0-9a-f]{32}$/);
  });

  test('an insert before the page boundary does not shift the next page', async () => {
    const first = await feed().page();
    await table.insert({
      id: id(50),
      orgId: ORG,
      title: 'jumped the queue',
      likeCount: 0,
      createdAt: new Date(AT.getTime() - 1000),
      updatedAt: AT,
    });
    const second = await feed().after(first.nextCursor).page();
    expect(second.rows.map((row) => row.id)).toEqual([id(2), id(3)]);
  });

  test('a cursor from a different sort order is X_CURSOR_INVALID', async () => {
    const { nextCursor } = await feed().page();
    const reordered = table.where({ orgId: ORG }).orderBy('title', 'desc').limit(2);
    await expect(reordered.after(nextCursor).page()).rejects.toBeUltimateError('X_CURSOR_INVALID');
  });

  test('a cursor from a different filter is X_CURSOR_INVALID', async () => {
    const { nextCursor } = await feed().page();
    const filtered = table
      .where({ orgId: ORG })
      .andWhere('likeCount', 'gte', 1)
      .orderBy('createdAt')
      .limit(2);
    await expect(filtered.after(nextCursor).page()).rejects.toBeUltimateError('X_CURSOR_INVALID');
  });

  test('a hand-edited cursor is X_CURSOR_INVALID', async () => {
    const { nextCursor } = await feed().page();
    const [body = '', signature = ''] = (nextCursor ?? '').split('.');
    // Flip to a digit the signature does not already end in: `+ '0'` on a signature ending in
    // `0` is not a tamper at all, and the test would pass one run in sixteen for no reason.
    const flipped = `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`;
    await expect(feed().after(`${body}.${flipped}`).page()).rejects.toBeUltimateError(
      'X_CURSOR_INVALID',
    );
  });
});

describe('writes through the table', () => {
  test('insert parses the row before it is stored', async () => {
    await expect(
      table.insert({ id: 'not-a-uuid', orgId: ORG, title: 'bad' }),
    ).rejects.toBeUltimateError('X_INVARIANT_VIOLATED');
  });

  test('update stamps onUpdateNow() columns the caller never sets', async () => {
    const updated = await table.update(id(0), { title: 'renamed' }, { orgId: ORG });
    expect(updated.title).toBe('renamed');
    // The clock is frozen under the test preload, so "now" is an exact value, not a range.
    expect(updated.updatedAt).toEqual(new Date());
    expect(updated.updatedAt).not.toEqual(AT);
  });

  test('an id alone never addresses another tenant’s row', async () => {
    await expect(
      table.update(id(9), { title: 'theirs' }, { orgId: ORG }),
    ).rejects.toBeUltimateError('X_NOT_FOUND');
    await expect(table.delete(id(9), { orgId: ORG })).rejects.toBeUltimateError('X_NOT_FOUND');
  });

  test('delete removes the row from the page it was on', async () => {
    await table.delete(id(0), { orgId: ORG });
    expect(await table.where({ orgId: ORG }).count()).toBe(4);
  });
});
