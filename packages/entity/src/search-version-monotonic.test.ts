// A search document's version is strictly increasing per row, even when the clock is not: writes
// inside one millisecond — an insert then an update, an upsert's collision, a filtered update, then
// a delete — each reach an external index as NEWER than the last, on the memory driver and on a
// custom store. Without that, the index refuses the second write as a replay: a lost update.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { advanceVersion, selectRows } from './adapter';
import { text, timestamp, uuid } from './columns';
import { type Driver, database, memoryDriver } from './database';
import { type DriverRepo, defineDriver } from './define-driver';
import { type EntityCore, entity } from './entity';
import { updateStatement, VERSION_STEP_SQL } from './pg-write-sql';
import { planFor } from './plan';
import { clearRegistry } from './registry';
import type { SearchIndex } from './search-index';
import { installSearchIndex } from './search-index-installed';
import { memorySearchIndex } from './search-index-memory';
import { VERSION_STEP_MS } from './search-index-version';

afterAll(() => {
  clearRegistry();
});

const ORG = '00000000-0000-7000-8000-00000000000a';
const ID = '00000000-0000-7000-8000-000000000001';
const AT = new Date('2026-11-10T10:00:00.000Z');

const notes = entity('smono_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text().searchable(),
    shelf: text(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
});

/** Untenanted, so `upsertAll` may target the key alone. */
const tags = entity('smono_tags', {
  columns: {
    id: uuid().primaryKey(),
    title: text().searchable(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
});

/** A clock that never moves: every write lands in the same millisecond. */
const stopped: Clock = { now: () => new Date(AT), monotonic: () => AT.getTime() };

const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ clock: stopped, actor: userActor({ id: 'member-1', orgId: ORG }) }), fn);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
});

const installed = (): SearchIndex => {
  const index = memorySearchIndex();
  release = installSearchIndex(index);
  return index;
};

const hits = async (index: SearchIndex, term: string) =>
  (await index.query({ entity: notes.$name, tenant: ORG, term })).map((hit) => hit.id);

/** A custom store: a Map per table, read through the kit, knowing nothing of versions. */
const mapStore = (): Driver =>
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

const DRIVERS: readonly [string, () => Driver][] = [
  ['memory', () => memoryDriver()],
  ['a custom store', mapStore],
];

describe.each(DRIVERS)('one millisecond, many versions — %s', (_, driver) => {
  test('an insert then an update reach the index as two versions', async () => {
    const index = installed();
    const db = database({ notes }, { driver: driver() });
    await asMember(() => db.notes.insert({ id: ID, orgId: ORG, title: 'zebra', shelf: 'a' }));
    const updated = await asMember(() => db.notes.update(ID, { title: 'quokka' }));
    expect(updated.updatedAt.getTime()).toBeGreaterThan(AT.getTime());
    await settle();
    expect(await hits(index, 'quokka')).toEqual([ID]);
    expect(await hits(index, 'zebra')).toEqual([]);
  });

  test('an updateWhere after an update in the same ms is newer still', async () => {
    const index = installed();
    const db = database({ notes }, { driver: driver() });
    await asMember(() => db.notes.insert({ id: ID, orgId: ORG, title: 'zebra', shelf: 'a' }));
    await asMember(() => db.notes.update(ID, { title: 'quokka' }));
    await asMember(() => db.notes.updateWhere({ shelf: 'a' }, { title: 'lantern' }));
    await settle();
    expect(await hits(index, 'lantern')).toEqual([ID]);
  });

  test('a delete after an update in the same ms removes the document', async () => {
    const index = installed();
    const db = database({ notes }, { driver: driver() });
    await asMember(() => db.notes.insert({ id: ID, orgId: ORG, title: 'zebra', shelf: 'a' }));
    await asMember(() => db.notes.update(ID, { title: 'quokka' }));
    await asMember(() => db.notes.delete(ID));
    await settle();
    expect(await hits(index, 'quokka')).toEqual([]);
  });
});

describe('one millisecond, many versions — an upsert', () => {
  test("an upsert's collision in the same ms as the insert is a newer version", async () => {
    const index = installed();
    const db = database({ tags }, { driver: memoryDriver() });
    const row = { id: ID, title: 'zebra' };
    await asMember(() => db.tags.insert(row));
    await asMember(() => db.tags.upsertAll([{ ...row, title: 'quokka' }], { onConflict: ['id'] }));
    await settle();
    const found = await index.query({ entity: tags.$name, tenant: null, term: 'quokka' });
    expect(found).toEqual([{ id: ID }]);
  });
});

describe('one millisecond, many versions — the Postgres statement', () => {
  const plain = entity('smono_plain', {
    columns: { id: uuid().primaryKey(), note: text(), updatedAt: timestamp().onUpdateNow() },
  });
  const set = new Map<string, unknown>([['updated_at', AT]]);
  const plan = (core: EntityCore<unknown>) =>
    planFor(core, { where: [{ column: 'id', op: 'eq', value: ID }] });

  test('a searchable entity advances its version past the stored one', () => {
    const { text: statement } = updateStatement(
      tags,
      plan(tags),
      set,
      { includeDeleted: false },
      false,
    );
    expect(statement).toContain(
      '"updated_at" = greatest($1, "updated_at" + interval \'1 millisecond\')',
    );
  });

  test('any other entity stamps the clock as it always did', () => {
    const { text: statement } = updateStatement(
      plain,
      plan(plain),
      set,
      { includeDeleted: false },
      false,
    );
    expect(statement).not.toContain('greatest');
  });

  test('the SQL step and the memory step are one millisecond', () => {
    expect(VERSION_STEP_MS).toBe(1);
    expect(VERSION_STEP_SQL.text).toBe("interval '1 millisecond'");
  });
});
