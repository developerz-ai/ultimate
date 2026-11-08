// Single responsibility: the JSON value `null` in a `jsonb` column answers the same in both
// drivers — `memoryDriver()` and `postgresDriver()` over PGlite. A NOT NULL column whose schema
// admits `null` stores the JSON literal; a nullable column's `null` is still SQL NULL (the clear).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { t } from '@ultimat3/schema';
import { text, uuid } from './columns';
import { json } from './columns-data';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const PGLITE_BOOT_MS = 30_000;
const shape = t.object({ a: t.number });

const events = entity('jn_events', {
  columns: {
    id: uuid().primaryKey(),
    code: text({ max: 10 }).unique(),
    /** NOT NULL in the table; `null` is a value the schema admits. */
    payload: json(t.nullable(shape)),
    /** Nullable in the table; `null` here is the column cleared. */
    note: json(shape).nullable(),
  },
});

/** NOT NULL, and the schema refuses `null`: the schema is what says so, in both drivers. */
const strict = entity('jn_strict', {
  columns: { id: uuid().primaryKey(), payload: json(shape) },
});

const ENTITIES = { events, strict };
const client = pgliteClient();

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: Object.values(ENTITIES).map((one) => one.$describe()),
    name: 'json null parity',
    now: new Date('2026-11-08T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

beforeEach(async () => {
  for (const one of Object.values(ENTITIES)) {
    await client.execute(raw(`delete from "${one.$name}"`));
  }
});

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

type Outcome = { readonly ok: unknown } | { readonly code: string };

const outcome = async (work: () => Promise<unknown>): Promise<Outcome> => {
  try {
    return { ok: await work() };
  } catch (error) {
    return { code: isUltimateError(error) ? error.code : `not coded: ${String(error)}` };
  }
};

const both = async (
  body: (db: ReturnType<typeof database<typeof ENTITIES>>) => Promise<unknown>,
): Promise<readonly [Outcome, Outcome]> => {
  const run = (driver: Driver) => outcome(() => body(database(ENTITIES, { driver })));
  return [await run(memoryDriver()), await run(postgresDriver())] as const;
};

/** What the table holds for `column` of every row, ordered by `code`: SQL NULL or a jsonb type. */
const stored = async (column: string): Promise<readonly (string | null)[]> => {
  const rows = await client.query<{ kind: string | null }>(
    raw(`select jsonb_typeof("${column}") as kind from "jn_events" order by code`),
  );
  return rows.map((row) => row.kind);
};

const ID = '00000000-0000-7000-8000-000000000001';

describe('a NOT NULL json column whose schema admits null', () => {
  test('insert stores the JSON literal and reads null back', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.events.insert({ id: ID, code: 'a', payload: null });
      return db.events.where({ id: ID }).one();
    });
    expect(memory).toEqual({ ok: { id: ID, code: 'a', payload: null, note: null } });
    expect(pg).toEqual(memory);
    expect(await stored('payload')).toEqual(['null']);
  });

  test('update to null stores the JSON literal', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.events.insert({ id: ID, code: 'a', payload: { a: 1 } });
      await db.events.update(ID, { payload: null });
      return db.events.where({ id: ID }).one();
    });
    expect(memory).toEqual({ ok: { id: ID, code: 'a', payload: null, note: null } });
    expect(pg).toEqual(memory);
    expect(await stored('payload')).toEqual(['null']);
  });

  test('insertAll and upsertAll store the JSON literal', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.events.insertAll([{ code: 'a', payload: null }]);
      await db.events.upsertAll([{ code: 'b', payload: null }], { onConflict: ['code'] });
      await db.events.upsertAll([{ code: 'a', payload: null }], { onConflict: ['code'] });
      return (await db.events.all()).map((row) => [row.code, row.payload]).sort();
    });
    expect(memory).toEqual({
      ok: [
        ['a', null],
        ['b', null],
      ],
    });
    expect(pg).toEqual(memory);
    expect(await stored('payload')).toEqual(['null', 'null']);
  });

  test('a null test matches no row: the column holds no SQL NULL', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.events.insert({ id: ID, code: 'a', payload: null });
      return [
        (await db.events.where({ payload: null }).all()).length,
        (await db.events.andWhere('payload', 'is-null', null).all()).length,
        (await db.events.andWhere('payload', 'is-not-null', null).all()).length,
        (await db.events.andWhere('payload', 'neq', null).all()).length,
        (await db.events.andWhere('payload', 'in', [null]).all()).length,
      ];
    });
    expect(pg).toEqual({ ok: [0, 0, 1, 1, 0] });
    expect(memory).toEqual(pg);
  });

  test('a schema that refuses null refuses it in both, by the column', async () => {
    const refusal = async (driver: Driver): Promise<string> => {
      const db = database(ENTITIES, { driver });
      const error: unknown = await db.strict
        .insert({ id: ID, payload: null as never })
        .then(() => undefined, (caught: unknown) => caught);
      return isUltimateError(error) ? `${error.code} ${error.cause}` : 'not refused';
    };
    const pg = await refusal(postgresDriver());
    // The column's schema answers, not the NOT NULL rule: `null` is a JSON value it may refuse.
    expect(pg).toStartWith('X_INVARIANT_VIOLATED column.json:');
    expect(await refusal(memoryDriver())).toBe(pg);
  });

  test('containment reads the JSON literal, not a NULL', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.events.insert({ id: ID, code: 'a', payload: null });
      return (await db.events.andWhere('payload', 'contains', null).all()).length;
    });
    expect(pg).toEqual({ ok: 1 });
    expect(memory).toEqual(pg);
  });
});

describe('a nullable json column', () => {
  test('an explicit null is SQL NULL — the column cleared', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.events.insert({ id: ID, code: 'a', payload: { a: 1 }, note: { a: 2 } });
      await db.events.update(ID, { note: null });
      return [
        await db.events.where({ id: ID }).one(),
        (await db.events.where({ note: null }).all()).length,
      ];
    });
    expect(memory).toEqual({ ok: [{ id: ID, code: 'a', payload: { a: 1 }, note: null }, 1] });
    expect(pg).toEqual(memory);
    expect(await stored('note')).toEqual([null]);
  });

  test('an absent value is SQL NULL', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.events.insert({ id: ID, code: 'a', payload: { a: 1 } });
      return db.events.where({ id: ID }).one();
    });
    expect(memory).toEqual({ ok: { id: ID, code: 'a', payload: { a: 1 }, note: null } });
    expect(pg).toEqual(memory);
    expect(await stored('note')).toEqual([null]);
  });
});
