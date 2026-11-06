// `entity({ history: true })`: the history table is a real entity beside its parent, carrying the
// parent's tenant column; a read of it is tenant-scoped like any other; its repository refuses every
// rewrite; and both drivers record the same images for the same writes — memory in its repository,
// Postgres (embedded PGlite, migrated by the migration `x db gen` writes) in the trigger.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, isUltimateError, runWithContext, userActor } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { integer, text, uuid } from './columns';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry, getEntity } from './registry';

const PGLITE_BOOT_MS = 30_000;
const ORG = '00000000-0000-7000-8000-0000000000aa';
const OTHER_ORG = '00000000-0000-7000-8000-0000000000bb';
const ID = '00000000-0000-7000-8000-000000000001';

const notes = entity('hist_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text(),
    likeCount: integer().default(0),
  },
  history: true,
});
const history = notes.$history ?? expect.unreachable('history: true declares a history entity');

const ENTITIES = { notes, history };
const client = pgliteClient();
const as = (orgId: string) => ctxOf({ actor: { ...userActor({ id: 'member-1' }), orgId } });

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [notes.$describe(), history.$describe()],
    name: 'history parity',
    now: new Date('2026-11-06T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
});

afterAll(() => {
  clearRegistry();
});

describe('history · the entity', () => {
  test('is registered beside its parent, with the parent tenant column', () => {
    expect(getEntity('hist_notes_history')?.core).toBe(history);
    expect(history.$tenantColumn).toBe('orgId');
    expect(history.$historyOf).toBe('hist_notes');
    expect(notes.$describe().history).toEqual({
      table: 'hist_notes_history',
      key: 'id',
      tenant: 'org_id',
      ignore: [],
    });
  });

  test('a composite primary key is refused', () => {
    const code = (() => {
      try {
        entity('hist_pairs', {
          columns: { a: uuid(), b: uuid() },
          primaryKey: ['a', 'b'],
          history: true,
        });
      } catch (error) {
        return isUltimateError(error) ? error.code : 'uncoded';
      }
      return 'accepted';
    })();
    expect(code).toBe('X_INVARIANT_VIOLATED');
  });
});

type Db = ReturnType<typeof database<typeof ENTITIES>>;

/** The same writes, then what the history holds in this tenant and in another. */
const script = async (db: Db) =>
  runWithContext(as(ORG), async () => {
    await db.notes.insert({ id: ID, orgId: ORG, title: 'a' });
    await db.notes.update(ID, { title: 'b' });
    await db.notes.update(ID, { title: 'b' });
    await db.notes.updateWhere({ orgId: ORG }, { title: 'c' });
    await db.notes.delete(ID);
    // Sorted here, not by `at`: four autocommit writes can share a clock tick, and a tie is then
    // broken by the random id — the SET of images is what both drivers must agree on.
    const rows = await db.history.all();
    const refused = await db.history
      .delete(rows[0]?.id ?? '')
      .then(() => 'accepted')
      .catch((error: unknown) => (isUltimateError(error) ? error.code : 'uncoded'));
    const elsewhere = await runWithContext(as(OTHER_ORG), () => db.history.all());
    return {
      images: rows
        .map((row) => [
          row.op,
          row.rowId,
          (row.before as { title?: string } | null)?.title ?? null,
          (row.after as { title?: string } | null)?.title ?? null,
        ])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      refused,
      elsewhere: elsewhere.length,
    };
  });

const run = async (driver: Driver) => {
  await client.execute(raw('delete from "hist_notes"'));
  await client.execute(raw(`select set_config('x.purge', 'hist_notes_history', false)`));
  await client.execute(raw('delete from "hist_notes_history"'));
  await client.execute(raw(`select set_config('x.purge', '', false)`));
  return script(database(ENTITIES, { driver }));
};

describe('history · both drivers, one answer', () => {
  test('memory records what the trigger records', async () => {
    const memory = await run(memoryDriver());
    const postgres = await run(postgresDriver());
    expect(postgres).toEqual({
      images: [
        ['delete', ID, 'c', null],
        ['insert', ID, null, 'a'],
        ['update', ID, 'a', 'b'],
        ['update', ID, 'b', 'c'],
      ],
      refused: 'X_ENTITY_APPEND_ONLY',
      elsewhere: 0,
    });
    expect(memory).toEqual(postgres);
  });
});
