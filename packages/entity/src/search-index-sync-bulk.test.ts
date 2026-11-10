// The write path for the writes that name no `id`: `deleteWhere`, `updateWhere`, and a delete on
// an entity keyed by something else (a single non-`id` column, a composite key). Each reaches an
// installed external index with the rows the statement touched; a rollback reaches nothing.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { ctxOf, runWithContext, subscribed, userActor } from '@ultimat3/core';
import { advanceVersion, selectRows } from './adapter';
import { text, timestamp, uuid } from './columns';
import { database, memoryDriver } from './database';
import { type DriverRepo, defineDriver } from './define-driver';
import type { EntityCore } from './entity';
import { entity } from './entity';
import { clearRegistry } from './registry';
import type { SearchIndex } from './search-index';
import { installSearchIndex } from './search-index-installed';
import { memorySearchIndex } from './search-index-memory';

afterAll(() => {
  clearRegistry();
});

const ORG = '00000000-0000-7000-8000-00000000000a';
const idAt = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const notes = entity('ssbulk_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text().searchable(),
    shelf: text(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
});

const drafts = entity('ssbulk_drafts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text().searchable(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
    deletedAt: timestamp().nullable(),
  },
});

/** Keyed by a column that is not `id`. */
const pages = entity('ssbulk_pages', {
  columns: {
    slug: text({ max: 40 }).primaryKey(),
    orgId: uuid().tenant(),
    title: text().searchable(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
});

/** A composite key: `delete(id)` cannot name a row, `deleteWhere` is the only delete. */
const labels = entity('ssbulk_labels', {
  columns: {
    orgId: uuid().tenant(),
    name: text({ max: 40 }),
    title: text().searchable(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
  primaryKey: ['orgId', 'name'],
});

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
});

let at = Date.parse('2026-11-10T10:00:00.000Z');
const ticking: Clock = {
  now: () => {
    at += 1_000;
    return new Date(at);
  },
  monotonic: () => at,
};

const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ clock: ticking, actor: userActor({ id: 'member-1', orgId: ORG }) }), fn);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const hits = async (index: SearchIndex, name: string, term: string) =>
  (await index.query({ entity: name, tenant: ORG, term })).map((hit) => hit.id).sort();

const installed = (): SearchIndex => {
  const index = memorySearchIndex();
  release = installSearchIndex(index);
  return index;
};

const seedNotes = async (db: ReturnType<typeof database<{ notes: typeof notes }>>) => {
  await asMember(() =>
    db.notes.insertAll([
      { id: idAt(1), orgId: ORG, title: 'zebra one', shelf: 'old' },
      { id: idAt(2), orgId: ORG, title: 'zebra two', shelf: 'old' },
      { id: idAt(3), orgId: ORG, title: 'zebra three', shelf: 'new' },
    ]),
  );
  await settle();
};

/** A custom store: a Map per table, keyed by the primary key, read through the kit. */
const mapStore = () =>
  defineDriver({
    name: 'map',
    capabilities: [],
    repo: <Row>(table: EntityCore<Row>): DriverRepo<Row> => {
      const rows = new Map<string, Row>();
      const keyOf = (row: Row) =>
        JSON.stringify(table.$primaryKey.map((key) => (row as Record<string, unknown>)[key]));
      const matched = (plan: Parameters<DriverRepo<Row>['count']>[0]['plan']) =>
        selectRows(table, rows.values(), { plan, after: undefined, limit: rows.size });
      return {
        select: async (read) => selectRows(table, rows.values(), read),
        count: async ({ plan }) => matched(plan).length,
        insert: async (batch) => {
          for (const row of batch) rows.set(keyOf(row), row);
          return batch;
        },
        update: async ({ plan }, patch, advance) => {
          const hit = matched(plan);
          for (const row of hit) {
            const next = { ...row, ...patch } as Row;
            rows.set(
              keyOf(row),
              advance === undefined
                ? next
                : advanceVersion(table, row, next, (key) => key === advance.property),
            );
          }
          return hit.length;
        },
        delete: async ({ plan }) => {
          const hit = matched(plan);
          for (const row of hit) rows.delete(keyOf(row));
          return hit.length;
        },
      };
    },
  });

describe('the search index write path, for writes that name no id', () => {
  test('a custom store names the rows it deleted and updated too', async () => {
    const index = installed();
    const db = database({ notes }, { driver: mapStore() });
    await seedNotes(db);
    await asMember(() => db.notes.updateWhere({ shelf: 'new' }, { title: 'quokka' }));
    await asMember(() => db.notes.deleteWhere({ shelf: 'old' }));
    await settle();
    expect(await hits(index, notes.$name, 'zebra')).toEqual([]);
    expect(await hits(index, notes.$name, 'quokka')).toEqual([idAt(3)]);
  });

  test('deleteWhere removes exactly the rows it deleted', async () => {
    const index = installed();
    const db = database({ notes }, { driver: memoryDriver() });
    await seedNotes(db);
    expect(await hits(index, notes.$name, 'zebra')).toEqual([idAt(1), idAt(2), idAt(3)]);
    expect(await asMember(() => db.notes.deleteWhere({ shelf: 'old' }))).toBe(2);
    await settle();
    expect(await hits(index, notes.$name, 'zebra')).toEqual([idAt(3)]);
  });

  test("updateWhere indexes each matched row's new text", async () => {
    const index = installed();
    const db = database({ notes }, { driver: memoryDriver() });
    await seedNotes(db);
    await asMember(() => db.notes.updateWhere({ shelf: 'old' }, { title: 'quokka' }));
    await settle();
    expect(await hits(index, notes.$name, 'quokka')).toEqual([idAt(1), idAt(2)]);
    expect(await hits(index, notes.$name, 'zebra')).toEqual([idAt(3)]);
  });

  test('a soft deleteWhere removes the stamped rows', async () => {
    const index = installed();
    const db = database({ drafts }, { driver: memoryDriver() });
    await asMember(() => db.drafts.insert({ id: idAt(1), orgId: ORG, title: 'zebra' }));
    await settle();
    await asMember(() => db.drafts.deleteWhere({ title: 'zebra' }));
    await settle();
    expect(await hits(index, drafts.$name, 'zebra')).toEqual([]);
  });

  test('a delete on an entity keyed by a column that is not id removes its row', async () => {
    const index = installed();
    const db = database({ pages }, { driver: memoryDriver() });
    await asMember(() => db.pages.insert({ slug: 'about', orgId: ORG, title: 'zebra' }));
    await settle();
    expect(await hits(index, pages.$name, 'zebra')).toEqual(['about']);
    await asMember(() => db.pages.delete('about'));
    await settle();
    expect(await hits(index, pages.$name, 'zebra')).toEqual([]);
  });

  test('a deleteWhere on a composite key removes that row and no other', async () => {
    const index = installed();
    const db = database({ labels }, { driver: memoryDriver() });
    await asMember(() =>
      db.labels.insertAll([
        { orgId: ORG, name: 'red', title: 'zebra red' },
        { orgId: ORG, name: 'blue', title: 'zebra blue' },
      ]),
    );
    await settle();
    expect((await hits(index, labels.$name, 'zebra')).length).toBe(2);
    await asMember(() => db.labels.deleteWhere({ name: 'red' }));
    await settle();
    expect(await hits(index, labels.$name, 'zebra')).toEqual([JSON.stringify([ORG, 'blue'])]);
  });

  test('a rolled-back deleteWhere removes nothing', async () => {
    const index = installed();
    const driver = memoryDriver();
    const db = database({ notes }, { driver });
    await seedNotes(db);
    await asMember(() =>
      driver
        .transactor()
        .run(async () => {
          await db.notes.deleteWhere({ shelf: 'old' });
          // The rollback is the transactor's answer to a rejected unit of work: input, not a verdict.
          return Promise.reject(new RangeError('rolled back on purpose'));
        })
        .catch(() => undefined),
    );
    await settle();
    expect(await hits(index, notes.$name, 'zebra')).toEqual([idAt(1), idAt(2), idAt(3)]);
  });

  test('mirroring hears no bus: an installed index subscribes to nothing', () => {
    expect(subscribed('entity.row')).toBe(false);
    installed();
    expect(subscribed('entity.row')).toBe(false);
    expect(subscribed('entity.bulk')).toBe(false);
  });
});
