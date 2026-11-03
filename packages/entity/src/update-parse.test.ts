// `insert` parsed and `update` did not, so one patch was stored by memory and refused by Postgres
// (`23514`), and another was stored as a number by one and as text by the other. Both drivers, one
// body: a patch is refused by the named columns' own schemas, before any statement.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, sql, statementsOf } from '@ultimat3/db';
import { text, timestamp, uuid } from './columns';
import { bigint } from './columns-data';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { enumerated } from './enum-column';
import { memoryRepo } from './memory-repo';
import { postgresDriver, postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';

const STATES = ['draft', 'live'] as const;

const notes = entity('update_parse_notes', {
  columns: {
    id: uuid().primaryKey(),
    label: text({ max: 3 }),
    body: text({ max: 3 }).nullable(),
    count: bigint().nullable(),
    state: enumerated(STATES)
      .transitions({ draft: ['live'], live: [] })
      .default('draft'),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
});

const ENTITIES = { notes };
const ID = '00000000-0000-7000-8000-000000000001';
const client = pgliteClient();

/** Out of the type on purpose: these are the values only a JS caller or a cast can hand over. */
type AnyPatch = Parameters<ReturnType<typeof database<typeof ENTITIES>>['notes']['update']>[1];
const loose = (patch: Record<string, unknown>): AnyPatch => patch as AnyPatch;

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [notes.$describe()],
    name: 'update parse',
    now: new Date('2026-11-02T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, 30_000);

beforeEach(async () => {
  await client.execute(raw('delete from "update_parse_notes"'));
});

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

const codeOf = (error: unknown): string =>
  isUltimateError(error) ? error.code : `not coded: ${String(error)}`;

const DRIVERS: readonly (readonly [string, () => Driver])[] = [
  ['memory', () => memoryDriver()],
  ['postgres', () => postgresDriver()],
];

for (const [name, driver] of DRIVERS) {
  describe(`update validates what it names — ${name}`, () => {
    const seeded = async () => {
      const db = database(ENTITIES, { driver: driver() });
      await db.notes.insert({ id: ID, label: 'abc', body: 'xyz', count: '5' });
      return db;
    };

    const insertCode = async (values: Record<string, unknown>): Promise<string> => {
      const db = database(ENTITIES, { driver: driver() });
      const refused = await db.notes
        .insert({ id: ID, label: 'abc', ...values } as never)
        .catch((error: unknown) => error);
      return codeOf(refused);
    };

    for (const [what, patch] of [
      ['a value past max', { label: 'toolong' }],
      ['a number on a text column', { label: 42 }],
      ['null on a required column', { label: null }],
    ] as const) {
      test(`update refuses ${what}, with the code insert answers`, async () => {
        const expected = await insertCode(patch);
        expect(expected).toBe('X_INVARIANT_VIOLATED');
        const db = await seeded();
        const refused = await db.notes.update(ID, loose(patch)).catch((error: unknown) => error);
        expect(codeOf(refused)).toBe(expected);
        expect((await db.notes.where({ id: ID }).one())?.label).toBe('abc');
      });

      test(`updateWhere refuses ${what}, with the code insert answers`, async () => {
        const db = await seeded();
        const refused = await db.notes
          .updateWhere({ id: ID }, loose(patch))
          .catch((error: unknown) => error);
        expect(codeOf(refused)).toBe('X_INVARIANT_VIOLATED');
        expect((await db.notes.where({ id: ID }).one())?.label).toBe('abc');
      });
    }

    test('the stored value is the parsed one, on both', async () => {
      const db = await seeded();
      const row = await db.notes.update(ID, loose({ count: '007' }));
      expect(row.count).toBe('7');
    });

    test('omitted columns stay; undefined is absent; null clears a nullable', async () => {
      const db = await seeded();
      const first = await db.notes.update(ID, { label: 'new' });
      expect(first).toMatchObject({ label: 'new', body: 'xyz', count: '5' });
      const second = await db.notes.update(ID, { label: 'two', body: undefined });
      expect(second).toMatchObject({ label: 'two', body: 'xyz' });
      const third = await db.notes.update(ID, { body: null });
      expect(third).toMatchObject({ label: 'two', body: null });
    });

    test('a default never lands on an omitted column', async () => {
      const db = await seeded();
      await db.notes.transition('state', ID, { from: 'draft', to: 'live' });
      const row = await db.notes.update(ID, { label: 'new' });
      expect(row.state).toBe('live');
    });

    test('onUpdateNow still moves on update, updateWhere and a transition', async () => {
      const db = await seeded();
      const at = async (): Promise<number> =>
        (await db.notes.where({ id: ID }).one())?.updatedAt.getTime() ?? 0;
      const stale = new Date('2020-01-01T00:00:00.000Z');
      const backdate = async (): Promise<void> => {
        await client.execute(
          raw(`update "update_parse_notes" set updated_at = '${stale.toISOString()}'`),
        );
      };
      // Memory holds its own rows, so only Postgres can be backdated: there, the assertion is a
      // moved stamp; in memory, that the stamp is at least the one it had.
      const before = async (): Promise<number> => {
        if (name === 'postgres') await backdate();
        return at();
      };

      let was = await before();
      await db.notes.update(ID, { label: 'one' });
      expect(await at()).toBeGreaterThanOrEqual(was);
      if (name === 'postgres') expect(await at()).toBeGreaterThan(was);

      was = await before();
      await db.notes.updateWhere({ id: ID }, { label: 'two' });
      expect(await at()).toBeGreaterThanOrEqual(was);
      if (name === 'postgres') expect(await at()).toBeGreaterThan(was);

      was = await before();
      await db.notes.transition('state', ID, { from: 'draft', to: 'live' });
      expect(await at()).toBeGreaterThanOrEqual(was);
      if (name === 'postgres') expect(await at()).toBeGreaterThan(was);
    });

    test('an empty patch is still the refusal it was', async () => {
      const db = await seeded();
      const refused = await db.notes
        .updateWhere({ id: ID }, { label: undefined })
        .catch((error: unknown) => error);
      expect(codeOf(refused)).toBe('X_PATCH_EMPTY');
    });
  });
}

/**
 * The repository is the same door. A fragment is no `RowPatch` value, and `repo.update` spliced one
 * into the statement on Postgres while memory stored the object: a second way to write, past the
 * column's schema, that one driver had and the other did not.
 */
describe('a repository judges a patch as its table does', () => {
  const REPOS = [
    ['memory', () => memoryRepo(notes)],
    ['postgres', () => postgresRepo(notes)],
  ] as const;

  for (const [name, repoOf] of REPOS) {
    const seeded = async () => {
      const repo = repoOf();
      await repo.insert(notes.$parse({ id: ID, label: 'abc', count: '5' }));
      return repo;
    };

    test(`${name} · a SQL fragment is refused, by update and by updateWhere`, async () => {
      const repo = await seeded();
      const patch = { count: sql`count + 1` } as unknown as Parameters<typeof repo.update>[1];
      const one = await repo.update(ID, patch).catch((error: unknown) => error);
      expect(codeOf(one)).toBe('X_INVARIANT_VIOLATED');
      const many = await repo.updateWhere({ id: ID }, patch).catch((error: unknown) => error);
      expect(codeOf(many)).toBe('X_INVARIANT_VIOLATED');
      expect((await repo.findById(ID))?.count).toBe('5');
    });

    test(`${name} · a value past max is refused`, async () => {
      const repo = await seeded();
      const refused = await repo.update(ID, { label: 'toolong' }).catch((error: unknown) => error);
      expect(codeOf(refused)).toBe('X_INVARIANT_VIOLATED');
    });
  }

  test('the table refuses a fragment with the same code', async () => {
    const db = database(ENTITIES, { driver: postgresDriver() });
    await db.notes.insert({ id: ID, label: 'abc', count: '5' });
    const refused = await db.notes
      .update(ID, loose({ count: sql`count + 1` }))
      .catch((error: unknown) => error);
    expect(codeOf(refused)).toBe('X_INVARIANT_VIOLATED');
  });
});
