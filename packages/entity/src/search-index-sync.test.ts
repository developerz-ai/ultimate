// The write path: with an external index installed, committed entity writes keep it current — an
// insert, update or upsert indexes the row, a delete (soft or hard) removes it — and a rollback
// indexes nothing. What the built-in Postgres index costs a write: `search-mirror-statements.test.ts`.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { text, timestamp, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { clearRegistry } from './registry';
import type { SearchDocument, SearchIndex } from './search-index';
import { installSearchIndex } from './search-index-installed';
import { memorySearchIndex } from './search-index-memory';

afterAll(() => {
  clearRegistry();
});

const ORG = '00000000-0000-7000-8000-00000000000a';
const ID = '00000000-0000-7000-8000-000000000001';

const notes = entity('ssync_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text().searchable(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
    deletedAt: timestamp().nullable(),
  },
});

const plain = entity('ssync_plain', { columns: { id: uuid().primaryKey(), note: text() } });

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
});

/** A clock each write moves on by a second: every write is a NEWER version than the last. */
let at = Date.parse('2026-11-09T10:00:00.000Z');
const ticking: Clock = {
  now: () => {
    at += 1_000;
    return new Date(at);
  },
  monotonic: () => at,
};

/** As a member of `ORG`, so a point write on the tenant-scoped entity is scoped. */
const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ clock: ticking, actor: userActor({ id: 'member-1', orgId: ORG }) }), fn);

/** Settles the fire-and-forget index calls a commit started. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const hits = async (index: SearchIndex, term: string) =>
  (await index.query({ entity: notes.$name, tenant: ORG, term })).map((hit) => hit.id);

describe('the search index write path', () => {
  test('insert, update and delete keep an installed index current', async () => {
    const index = memorySearchIndex();
    release = installSearchIndex(index);
    const db = database({ notes }, { driver: memoryDriver() });
    await asMember(() => db.notes.insert({ id: ID, orgId: ORG, title: 'zebra' }));
    await settle();
    expect(await hits(index, 'zebra')).toEqual([ID]);
    await asMember(() => db.notes.update(ID, { title: 'quokka' }));
    await settle();
    expect(await hits(index, 'zebra')).toEqual([]);
    expect(await hits(index, 'quokka')).toEqual([ID]);
    await asMember(() => db.notes.delete(ID));
    await settle();
    expect(await hits(index, 'quokka')).toEqual([]);
  });

  test('a rolled-back write indexes nothing', async () => {
    const index = memorySearchIndex();
    release = installSearchIndex(index);
    const driver = memoryDriver();
    const db = database({ notes }, { driver });
    await driver
      .transactor()
      .run(async () => {
        await db.notes.insert({ id: ID, orgId: ORG, title: 'zebra' });
        // The rollback is the transactor's answer to a rejected unit of work: input, not a verdict.
        return Promise.reject(new RangeError('rolled back on purpose'));
      })
      .catch(() => undefined);
    await settle();
    expect(await hits(index, 'zebra')).toEqual([]);
  });

  test("an index that fails does not fail the user's write", async () => {
    const refusing: SearchIndex = {
      name: 'refusing',
      index: () => Promise.reject(new TypeError('index is down')),
      remove: async () => undefined,
      query: async () => [],
      list: async () => ({ entries: [], next: null }),
    };
    release = installSearchIndex(refusing);
    const db = database({ notes }, { driver: memoryDriver() });
    const stored = await db.notes.insert({ id: ID, orgId: ORG, title: 'zebra' });
    await settle();
    expect(stored.id).toBe(ID);
  });

  test('an entity with nothing searchable is never sent to the index', async () => {
    const documents: SearchDocument[] = [];
    release = installSearchIndex({
      name: 'recording',
      index: async (batch) => {
        documents.push(...batch);
      },
      remove: async () => undefined,
      query: async () => [],
      list: async () => ({ entries: [], next: null }),
    });
    const db = database({ plain }, { driver: memoryDriver() });
    await db.plain.insert({ id: ID, note: 'zebra' });
    await settle();
    expect(documents).toEqual([]);
  });
});
