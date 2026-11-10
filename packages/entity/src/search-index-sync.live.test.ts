// The search mirror against a real Postgres: `returning *` on a hard delete, a soft-delete stamp
// and a filtered update decodes into the rows an external index removes or re-indexes, a composite
// key included — and a rolled-back transaction reaches the index with nothing.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import {
  generateMigration,
  type PostgresClient,
  postgresClient,
  raw,
  setDbClient,
  sql,
  statementsOf,
  withTransaction,
} from '@ultimat3/db';
import { text, timestamp, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';
import type { SearchIndex } from './search-index';
import { installSearchIndex } from './search-index-installed';
import { memorySearchIndex } from './search-index-memory';

afterAll(() => {
  clearRegistry();
});

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const ORG = '00000000-0000-7000-8000-00000000000a';
const idAt = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const notes = entity('live_smirror_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text().searchable(),
    shelf: text(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
    deletedAt: timestamp().nullable(),
  },
});

const labels = entity('live_smirror_labels', {
  columns: {
    orgId: uuid().tenant(),
    name: text({ max: 40 }),
    title: text().searchable(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
  primaryKey: ['orgId', 'name'],
});

const TABLES = [notes.$table, labels.$table];

/**
 * A clock that never moves: every write of this file lands in ONE millisecond, the case a version
 * in epoch ms has to survive — strictly increasing per row, a re-created key live again.
 */
const at = Date.parse('2026-11-10T10:00:00.000Z');
const stopped: Clock = { now: () => new Date(at), monotonic: () => at };

const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ clock: stopped, actor: userActor({ id: 'member-1', orgId: ORG }) }), fn);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const hits = async (index: SearchIndex, name: string, term: string) =>
  (await index.query({ entity: name, tenant: ORG, term })).map((hit) => hit.id).sort();

describe.skipIf(!hasPostgres)('live · postgres · the search mirror', () => {
  let client: PostgresClient;
  let release: (() => void) | undefined;
  const db = database({ notes, labels }, { driver: postgresDriver() });

  beforeAll(async () => {
    client = postgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    for (const table of TABLES)
      await client.execute(raw(`drop table if exists "${table}" cascade`));
    const migration = generateMigration({
      entities: [notes.$describe(), labels.$describe()],
      name: 'live search mirror',
      now: new Date('2026-11-10T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
  });

  afterAll(async () => {
    for (const table of TABLES)
      await client.execute(raw(`drop table if exists "${table}" cascade`));
    await client.close();
    setDbClient(undefined);
  });

  afterEach(async () => {
    release?.();
    release = undefined;
    for (const table of TABLES) await client.execute(raw(`truncate "${table}"`));
  });

  const installed = (): SearchIndex => {
    const index = memorySearchIndex();
    release = installSearchIndex(index);
    return index;
  };

  const seed = async () => {
    await asMember(() =>
      db.notes.insertAll([
        { id: idAt(1), orgId: ORG, title: 'zebra one', shelf: 'old' },
        { id: idAt(2), orgId: ORG, title: 'zebra two', shelf: 'old' },
        { id: idAt(3), orgId: ORG, title: 'zebra three', shelf: 'new' },
      ]),
    );
    await settle();
  };

  test('deleteWhere (a soft delete here) removes the stamped rows', async () => {
    const index = installed();
    await seed();
    expect(await asMember(() => db.notes.deleteWhere({ shelf: 'old' }))).toBe(2);
    await settle();
    expect(await hits(index, notes.$name, 'zebra')).toEqual([idAt(3)]);
  });

  test('updateWhere indexes the new text of every row it wrote', async () => {
    const index = installed();
    await seed();
    await asMember(() => db.notes.updateWhere({ shelf: 'old' }, { title: 'quokka' }));
    await settle();
    expect(await hits(index, notes.$name, 'quokka')).toEqual([idAt(1), idAt(2)]);
    expect(await hits(index, notes.$name, 'zebra')).toEqual([idAt(3)]);
  });

  test('a hard deleteWhere on a composite key removes exactly that row', async () => {
    const index = installed();
    await asMember(() =>
      db.labels.insertAll([
        { orgId: ORG, name: 'red', title: 'zebra red' },
        { orgId: ORG, name: 'blue', title: 'zebra blue' },
      ]),
    );
    await settle();
    await asMember(() => db.labels.deleteWhere({ name: 'red' }));
    await settle();
    expect(await hits(index, labels.$name, 'zebra')).toEqual([JSON.stringify([ORG, 'blue'])]);
  });

  test('a rolled-back deleteWhere removes nothing', async () => {
    const index = installed();
    await seed();
    await asMember(() =>
      withTransaction(async () => {
        await db.notes.deleteWhere({ shelf: 'old' });
        // The rollback is the transaction's answer to a rejected unit of work: input, not a verdict.
        return Promise.reject(new RangeError('rolled back on purpose'));
      }),
    ).catch(() => undefined);
    await settle();
    expect(await hits(index, notes.$name, 'zebra')).toEqual([idAt(1), idAt(2), idAt(3)]);
  });

  test('an insert, an update and an updateWhere in one ms are three versions', async () => {
    const index = installed();
    await asMember(() => db.notes.insert({ id: idAt(1), orgId: ORG, title: 'zebra', shelf: 'a' }));
    const updated = await asMember(() => db.notes.update(idAt(1), { title: 'quokka' }));
    expect(updated.updatedAt.getTime()).toBe(at + 1);
    await settle();
    expect(await hits(index, notes.$name, 'quokka')).toEqual([idAt(1)]);
    await asMember(() => db.notes.updateWhere({ shelf: 'a' }, { title: 'lantern' }));
    await settle();
    expect(await hits(index, notes.$name, 'lantern')).toEqual([idAt(1)]);
    await asMember(() => db.notes.deleteWhere({ shelf: 'a' }));
    await settle();
    expect(await hits(index, notes.$name, 'lantern')).toEqual([]);
  });

  test("an upsert's collision in the same ms as the insert is a newer version", async () => {
    const index = installed();
    const row = { orgId: ORG, name: 'red', title: 'zebra' };
    await asMember(() => db.labels.insert(row));
    await asMember(() =>
      db.labels.upsertAll([{ ...row, title: 'quokka' }], { onConflict: ['orgId', 'name'] }),
    );
    await settle();
    expect(await hits(index, labels.$name, 'quokka')).toEqual([JSON.stringify([ORG, 'red'])]);
  });

  test('a key deleted and inserted again in the same ms, after it ran ahead, is found', async () => {
    const index = installed();
    const row = { orgId: ORG, name: 'red', title: 'zebra' };
    await asMember(() => db.labels.insert(row));
    // Two more versions in the same ms: the stored one runs ahead of the clock.
    await asMember(() => db.labels.updateWhere({ name: 'red' }, { title: 'lantern' }));
    await asMember(() => db.labels.updateWhere({ name: 'red' }, { title: 'harbour' }));
    await asMember(() => db.labels.deleteWhere({ name: 'red' }));
    await asMember(() => db.labels.insert({ ...row, title: 'quokka' }));
    await settle();
    expect(await hits(index, labels.$name, 'quokka')).toEqual([JSON.stringify([ORG, 'red'])]);
  });

  test('a soft delete after updates in the same ms advances the version and removes', async () => {
    const index = installed();
    await asMember(() => db.notes.insert({ id: idAt(1), orgId: ORG, title: 'zebra', shelf: 'a' }));
    await asMember(() => db.notes.update(idAt(1), { title: 'lantern' }));
    const last = await asMember(() => db.notes.update(idAt(1), { title: 'harbour' }));
    await asMember(() => db.notes.delete(idAt(1)));
    const stamped = await client.one<{ ms: string }>(
      sql`select (extract(epoch from updated_at) * 1000)::bigint::text as ms from live_smirror_notes where id = ${idAt(1)}`,
    );
    await settle();
    expect(Number(stamped?.ms)).toBeGreaterThan(last.updatedAt.getTime());
    expect(await hits(index, notes.$name, 'harbour')).toEqual([]);
  });

  test('a delete then an insert in one transaction leaves the new row found', async () => {
    const index = installed();
    const row = { orgId: ORG, name: 'blue', title: 'zebra' };
    await asMember(() => db.labels.insert(row));
    await settle();
    await asMember(() =>
      withTransaction(async () => {
        await db.labels.deleteWhere({ name: 'blue' });
        await db.labels.insert({ ...row, title: 'quokka' });
      }),
    );
    await settle();
    expect(await hits(index, labels.$name, 'quokka')).toEqual([JSON.stringify([ORG, 'blue'])]);
    expect(await hits(index, labels.$name, 'zebra')).toEqual([]);
  });
});
