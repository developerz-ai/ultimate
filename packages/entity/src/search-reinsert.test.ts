// A key deleted and written again reaches an external index as live, inside one millisecond too —
// even after versions ran ahead of the clock. A committed write's document replaces the delete's
// tombstone; only a `reindex` read keeps the stale guard. One transaction sends each key once.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { text, timestamp, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { clearRegistry } from './registry';
import type { SearchIndex, SearchScope } from './search-index';
import { installSearchIndex } from './search-index-installed';
import { memorySearchIndex } from './search-index-memory';

afterAll(() => {
  clearRegistry();
});

const ID = '00000000-0000-7000-8000-000000000001';
const AT = new Date('2026-11-10T10:00:00.000Z');

const pages = entity('sreins_pages', {
  columns: {
    id: uuid().primaryKey(),
    title: text().searchable(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
});

const drafts = entity('sreins_drafts', {
  columns: {
    id: uuid().primaryKey(),
    title: text().searchable(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
    deletedAt: timestamp().nullable(),
  },
});

const stopped: Clock = { now: () => new Date(AT), monotonic: () => AT.getTime() };
const inOneMs = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ clock: stopped }), work);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
});

/** The memory index, recording every removal it is sent. */
const installed = (): SearchIndex & { readonly removed: SearchScope[] } => {
  const inner = memorySearchIndex();
  const removed: SearchScope[] = [];
  const index = {
    ...inner,
    removed,
    remove: async (scope: SearchScope, ids: readonly string[], version: number) => {
      removed.push(scope);
      await inner.remove(scope, ids, version);
    },
  };
  release = installSearchIndex(index);
  return index;
};

const hits = async (index: SearchIndex, name: string, term: string) =>
  (await index.query({ entity: name, tenant: null, term })).map((hit) => hit.id);

describe('a key deleted and written again', () => {
  test('a delete then an insert of the same id in one ms leaves it found', async () => {
    const index = installed();
    const db = database({ pages }, { driver: memoryDriver() });
    await inOneMs(() => db.pages.insert({ id: ID, title: 'zebra' }));
    await inOneMs(() => db.pages.delete(ID));
    await inOneMs(() => db.pages.insert({ id: ID, title: 'quokka' }));
    await settle();
    expect(await hits(index, pages.$name, 'quokka')).toEqual([ID]);
  });

  test('…after versions ran ahead of the clock', async () => {
    const index = installed();
    const db = database({ pages }, { driver: memoryDriver() });
    await inOneMs(() => db.pages.insert({ id: ID, title: 'zebra' }));
    await inOneMs(() => db.pages.update(ID, { title: 'lantern' }));
    await inOneMs(() => db.pages.update(ID, { title: 'harbour' }));
    await inOneMs(() => db.pages.delete(ID));
    await inOneMs(() => db.pages.insert({ id: ID, title: 'quokka' }));
    await settle();
    expect(await hits(index, pages.$name, 'quokka')).toEqual([ID]);
    expect(await hits(index, pages.$name, 'harbour')).toEqual([]);
  });

  test('a soft delete after updates in one ms removes the document', async () => {
    const index = installed();
    const driver = memoryDriver();
    const db = database({ drafts }, { driver });
    await inOneMs(() => db.drafts.insert({ id: ID, title: 'zebra' }));
    await inOneMs(() => db.drafts.update(ID, { title: 'lantern' }));
    const before = await inOneMs(() => db.drafts.update(ID, { title: 'harbour' }));
    await inOneMs(() => db.drafts.delete(ID));
    const stamped = await inOneMs(() => driver.repo(drafts).findById(ID, { includeDeleted: true }));
    await settle();
    expect(stamped?.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(await hits(index, drafts.$name, 'harbour')).toEqual([]);
  });

  test('a delete then an insert in one transaction leaves the new row found', async () => {
    const index = installed();
    const driver = memoryDriver();
    const db = database({ pages }, { driver });
    await inOneMs(() => db.pages.insert({ id: ID, title: 'zebra' }));
    await settle();
    await inOneMs(() =>
      driver.transactor().run(async () => {
        await db.pages.delete(ID);
        await db.pages.insert({ id: ID, title: 'quokka' });
      }),
    );
    await settle();
    expect(await hits(index, pages.$name, 'quokka')).toEqual([ID]);
    expect(await hits(index, pages.$name, 'zebra')).toEqual([]);
  });
});
