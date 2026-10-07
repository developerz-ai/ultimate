// The one adapter from a typed handle to `AdminRepo`, over the memory driver: the six verbs, the
// keyset bound in both directions and across a tie, `count`, the id that is PARSED and not cast,
// and the two things the adapter must not do — add a tenant predicate of its own, or carry a
// sealed value somewhere a read could find it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, generateMasterKey, runWithContext, userActor } from '@ultimat3/core';
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
import { adminEntitiesOf, adminRepoFor, adminTablesOf } from './repo-entity';

const KEY_ENV = 'ULTIMATE_SECRETS_KEY';
const previousKey = process.env[KEY_ENV];

const notes = entity('admin_repo_notes', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 80 }),
    rank: integer(),
    createdAt: timestamp().defaultNow(),
  },
});

const ledgers = entity('admin_repo_ledgers', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    name: text({ max: 80 }),
  },
});

const vaults = entity('admin_repo_vaults', {
  columns: {
    id: uuid().primaryKey(),
    name: text({ max: 80 }),
    token: text({ max: 200 }).sealed(),
  },
});

const db = database({ notes, books: ledgers, vaults }, { driver: memoryDriver() });
const repo = adminRepoFor(notes, db.notes);

const ORG_A = '0190a000-0000-7000-8000-00000000000a';
const ORG_B = '0190a000-0000-7000-8000-00000000000b';

const as = <T>(orgId: string, run: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'op', roles: ['admin'], orgId }) }), run);

const ids: string[] = [];

beforeAll(async () => {
  process.env[KEY_ENV] = generateMasterKey();
  // Ranks 1..5, with a TIE at rank 3 — the case a strict `gt` seek silently skips a row on.
  for (const [title, rank] of [
    ['a', 1],
    ['b', 2],
    ['c', 3],
    ['d', 3],
    ['e', 5],
  ] as const) {
    ids.push(String((await repo.create({ title, rank }))['id']));
  }
});

afterAll(() => {
  if (previousKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = previousKey;
  clearRegistry();
});

const titles = (rows: readonly Readonly<Record<string, unknown>>[]): string =>
  rows.map((row) => String(row['title'])).join('');

describe('unit · adminRepoFor over a typed handle', () => {
  test('list orders by the sort field with the id as tie-break, and honours the limit', async () => {
    const rows = await repo.list({ sort: { field: 'rank', direction: 'asc' }, limit: 3 });
    expect(rows.map((row) => row['rank'])).toEqual([1, 2, 3]);
    expect(
      titles(await repo.list({ sort: { field: 'rank', direction: 'desc' }, limit: 5 })),
    ).toHaveLength(5);
  });

  test('a keyset page resumes AFTER the cursor row, tie included — no row skipped, none repeated', async () => {
    const sort = { field: 'rank', direction: 'asc' } as const;
    const first = await repo.list({ sort, limit: 3 });
    const last = first[2];
    const next = await repo.list({
      sort,
      limit: 3,
      after: { field: 'rank', value: String(last?.['rank']), id: String(last?.['id']) },
    });
    const seen = [...first, ...next].map((row) => String(row['id']));
    expect(new Set(seen).size).toBe(5);
    expect([...first, ...next].map((row) => row['rank'])).toEqual([1, 2, 3, 3, 5]);
  });

  test('a keyset over an INSTANT resumes at the cursor — the bound a cursor carries is ISO text', async () => {
    // The admin's default sort is `createdAt`, and `pagination.ts` writes a Date into a cursor as
    // its ISO string. Handed to the handle as text, the memory driver compared it by its
    // characters against a Date and every page after the first was the first one again.
    const stamped = entity('admin_repo_stamps', {
      columns: { id: uuid().primaryKey(), title: text({ max: 8 }), at: timestamp() },
    });
    const table = database({ stamped }, { driver: memoryDriver() }).stamped;
    const stamps = adminRepoFor(stamped, table);
    for (const [title, at] of [
      ['old', '2026-01-01T00:00:00.000Z'],
      ['mid', '2026-02-01T00:00:00.000Z'],
      ['new', '2026-03-01T00:00:00.000Z'],
    ] as const) {
      await stamps.create({ title, at: new Date(at) });
    }
    const sort = { field: 'at', direction: 'desc' } as const;
    const [first] = await stamps.list({ sort, limit: 1 });
    expect(first?.['title']).toBe('new');
    const next = await stamps.list({
      sort,
      limit: 2,
      after: { field: 'at', value: '2026-03-01T00:00:00.000Z', id: String(first?.['id']) },
    });
    expect(titles(next)).toBe('midold');
    // And a filter on one, as the list's URL spells it.
    const since = await stamps.list({
      sort,
      limit: 5,
      where: [{ field: 'at', op: 'gte', value: '2026-02-01T00:00:00.000Z' }],
    });
    expect(titles(since)).toBe('newmid');
    expect(
      await stamps.count?.([{ field: 'at', op: 'lt', value: '2026-02-01T00:00:00.000Z' }]),
    ).toBe(1);
  });

  test('`contains` matches the text typed — a `%` or `_` in it is a character, not a wildcard', async () => {
    const sort = { field: 'rank', direction: 'asc' } as const;
    const texts = entity('admin_repo_texts', {
      columns: {
        id: uuid().primaryKey(),
        title: text({ max: 40 }),
        rank: integer(),
        note: text({ max: 40 }).nullable(),
      },
    });
    const table = database({ texts }, { driver: memoryDriver() }).texts;
    const repoOfTexts = adminRepoFor(texts, table);
    await repoOfTexts.create({ title: '50% off', rank: 1, note: 'promo' });
    await repoOfTexts.create({ title: '500 off', rank: 2 });
    await repoOfTexts.create({ title: 'a_b', rank: 3 });
    await repoOfTexts.create({ title: 'axb', rank: 4 });
    const found = async (value: string): Promise<string> =>
      (
        await repoOfTexts.list({
          sort,
          limit: 9,
          where: [{ field: 'title', op: 'contains', value }],
        })
      )
        .map((row) => String(row['title']))
        .join('|');
    expect(await found('50%')).toBe('50% off');
    expect(await found('a_b')).toBe('a_b');
    expect(await found('off')).toBe('50% off|500 off');
    // One admin operator, two of the handle's: `true` is the rows with no value, `false` the rest.
    const nullness = async (value: boolean): Promise<number> =>
      (await repoOfTexts.list({ sort, limit: 9, where: [{ field: 'note', op: 'is-null', value }] }))
        .length;
    expect(await nullness(true)).toBe(3);
    expect(await nullness(false)).toBe(1);
  });

  test('a `before` bound walks back and answers in the sort order', async () => {
    const sort = { field: 'rank', direction: 'asc' } as const;
    const all = await repo.list({ sort, limit: 5 });
    const anchor = all[3];
    const back = await repo.list({
      sort,
      limit: 5,
      before: { field: 'rank', value: String(anchor?.['rank']), id: String(anchor?.['id']) },
    });
    // Everything at or before the anchor's rank, minus what the tie-drop removes up to the anchor.
    expect(back.every((row) => Number(row['rank']) <= 3)).toBe(true);
    expect(back.map((row) => String(row['id']))).not.toContain(String(all[4]?.['id']));
  });

  test('a timestamp bound travels as the cursor’s ISO string and still seeks by INSTANT', async () => {
    const stamped = entity('admin_repo_events', {
      columns: { id: uuid().primaryKey(), label: text({ max: 20 }), at: timestamp() },
    });
    const events = adminRepoFor(stamped, database({ stamped }, { driver: memoryDriver() }).stamped);
    for (const [label, at] of [
      ['early', '2026-01-01T00:00:00.000Z'],
      ['middle', '2026-03-02T12:00:00.000Z'],
      ['late', '2026-06-01T00:00:00.000Z'],
    ] as const) {
      await events.create({ label, at: new Date(at) });
    }
    const sort = { field: 'at', direction: 'asc' } as const;
    const [, middle] = await events.list({ sort, limit: 3 });
    // The cursor carries the position as the ISO string `pagination.ts` wrote; the handle compares
    // by the column's kind. Compared as text against a Date, `early` would come back on page two.
    const next = await events.list({
      sort,
      limit: 3,
      after: { field: 'at', value: '2026-03-02T12:00:00.000Z', id: String(middle?.['id']) },
    });
    expect(next.map((row) => row['label'])).toEqual(['late']);
  });

  test('filters become predicates: eq, contains, in', async () => {
    const sort = { field: 'rank', direction: 'asc' } as const;
    expect(
      titles(await repo.list({ sort, limit: 9, where: [{ field: 'rank', op: 'eq', value: 3 }] })),
    ).toHaveLength(2);
    expect(
      titles(
        await repo.list({
          sort,
          limit: 9,
          where: [{ field: 'title', op: 'contains', value: 'e' }],
        }),
      ),
    ).toBe('e');
    expect(
      titles(
        await repo.list({
          sort,
          limit: 9,
          where: [{ field: 'title', op: 'in', value: ['a', 'b'] }],
        }),
      ),
    ).toBe('ab');
  });

  test('count answers the whole table, and a filtered subset', async () => {
    expect(await repo.count?.()).toBe(5);
    expect(await repo.count?.([{ field: 'rank', op: 'gt', value: 2 }])).toBe(3);
  });

  test('find, update and destroy address one row', async () => {
    const id = ids[0] ?? '';
    expect((await repo.find(id))?.['title']).toBe('a');
    expect((await repo.update(id, { title: 'A' }))['title']).toBe('A');
    // A patch stays a patch: the column it did not name is untouched.
    expect((await repo.find(id))?.['rank']).toBe(1);
    const extra = String((await repo.create({ title: 'gone', rank: 9 }))['id']);
    await repo.destroy(extra);
    expect(await repo.find(extra)).toBeNull();
  });

  test('an id the primary key column rejects never reaches the driver', async () => {
    // A READ of it is a row that does not exist — the admin's 404, not an invariant violation:
    // the operator mistyped a URL. A write still refuses by name.
    expect(await repo.find('not-a-uuid')).toBeNull();
    await expect(repo.destroy('not-a-uuid')).rejects.toThrow(/expected a uuid/);
    await expect(repo.update('not-a-uuid', { title: 'x' })).rejects.toThrow(/expected a uuid/);
  });

  test("a tenant-scoped entity never returns another org's row, and the adapter adds no predicate", async () => {
    const books = adminRepoFor(ledgers, db.books);
    const mine = await as(ORG_A, () => books.create({ orgId: ORG_A, name: 'ours' }));
    const theirs = await as(ORG_B, () => books.create({ orgId: ORG_B, name: 'theirs' }));
    const sort = { field: 'name', direction: 'asc' } as const;

    const seenByA = await as(ORG_A, () => books.list({ sort, limit: 10 }));
    expect(seenByA.map((row) => row['name'])).toEqual(['ours']);
    expect(await as(ORG_A, () => books.find(String(theirs['id'])))).toBeNull();
    expect(await as(ORG_A, async () => books.count?.())).toBe(1);
    expect((await as(ORG_B, () => books.find(String(theirs['id']))))?.['name']).toBe('theirs');
    // The tenant is the HANDLE's: with no actor to take one from, the same call is refused
    // rather than answered across every org — the adapter never supplied a scope of its own.
    await expect(books.list({ sort, limit: 10 })).rejects.toThrow(/X_TENANCY_UNSCOPED/);
    expect(String(mine['orgId'])).toBe(ORG_A);
  });

  test('a sealed value is written through and never comes back on a serialised row', async () => {
    const safe = adminRepoFor(vaults, db.vaults);
    const made = await safe.create({ name: 'prod', token: 'CANARY-1' });
    const found = await safe.find(String(made['id']));
    expect(JSON.stringify(found)).not.toContain('CANARY-1');
    expect(Object.keys(found ?? {})).not.toContain('token');
    // A patch that does not name the sealed column leaves it as it was.
    const renamed = await safe.update(String(made['id']), { name: 'production' });
    expect(renamed['name']).toBe('production');
    const [stored] = await db.vaults.where({ id: String(made['id']) }).all();
    expect(stored?.token).toBe('CANARY-1');
  });
});

describe('unit · adminTablesOf', () => {
  test('a table is found by the ENTITY it serves, not by the key it sits under', () => {
    const tables = adminTablesOf(db);
    expect([...tables.keys()].sort()).toEqual([
      'admin_repo_ledgers',
      'admin_repo_notes',
      'admin_repo_vaults',
    ]);
    expect(tables.get('admin_repo_ledgers')).toBe(db.books);
  });
});

describe('unit · adminEntitiesOf', () => {
  test('every entity of the handle, as the entity itself, in the handle’s own order', () => {
    expect(adminEntitiesOf(db)).toEqual([notes, ledgers, vaults]);
  });

  test('an entity keyed on more than one column is left out — one id cannot address its rows', () => {
    const pairs = entity('admin_repo_pairs', {
      columns: { left: uuid(), right: uuid() },
      primaryKey: ['left', 'right'],
    });
    const mixed = database({ notes, pairs }, { driver: memoryDriver() });
    expect(adminEntitiesOf(mixed).map((found) => found.$name)).toEqual(['admin_repo_notes']);
  });
});
