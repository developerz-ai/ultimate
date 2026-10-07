// `appendOnly` answers the same in both drivers — `memoryDriver()` and `postgresDriver()` over the
// embedded PGlite, migrated by the very migration `x db gen` writes for the entity — and the table
// itself refuses the raw SQL the repository never sends. One entity, both halves of the guarantee.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { APPEND_ONLY_CODE } from './append-only-errors';
import { integer, text, uuid } from './columns';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const PGLITE_BOOT_MS = 30_000;

const ledger = entity('aop_ledger', {
  columns: {
    id: uuid().primaryKey(),
    account: text({ max: 20 }),
    amount: integer(),
  },
  appendOnly: true,
});

const ENTITIES = { ledger };
const client = pgliteClient();
const ID = '00000000-0000-7000-8000-000000000001';

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [ledger.$describe()],
    name: 'append only parity',
    now: new Date('2026-10-06T00:00:00.000Z'),
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

type Outcome = { readonly ok: unknown } | { readonly code: string };

const outcome = async (work: () => Promise<unknown>): Promise<Outcome> => {
  try {
    return { ok: await work() };
  } catch (error) {
    return { code: isUltimateError(error) ? error.code : `not coded: ${String(error)}` };
  }
};

/** One body per driver, each on a table holding exactly one row. Memory first. */
const both = async (
  body: (db: ReturnType<typeof database<typeof ENTITIES>>) => Promise<unknown>,
): Promise<readonly [Outcome, Outcome]> => {
  const run = async (driver: Driver) => {
    await client.execute(raw('alter table "aop_ledger" disable trigger "ultimate_append_only"'));
    await client.execute(raw('delete from "aop_ledger"'));
    await client.execute(raw('alter table "aop_ledger" enable trigger "ultimate_append_only"'));
    const db = database(ENTITIES, { driver });
    await db.ledger.insert({ id: ID, account: 'cash', amount: 100 });
    return outcome(() => body(db));
  };
  return [await run(memoryDriver()), await run(postgresDriver())] as const;
};

describe('appendOnly · both drivers, one answer', () => {
  const rewrites: readonly (readonly [
    string,
    (db: Parameters<Parameters<typeof both>[0]>[0]) => Promise<unknown>,
  ])[] = [
    ['update', (db) => db.ledger.update(ID, { amount: 1 })],
    ['delete', (db) => db.ledger.delete(ID)],
    ['updateWhere', (db) => db.ledger.updateWhere({ account: 'cash' }, { amount: 1 })],
    ['deleteWhere', (db) => db.ledger.deleteWhere({ account: 'cash' })],
    [
      'upsertAll',
      (db) => db.ledger.upsertAll([{ id: ID, account: 'cash', amount: 1 }], { onConflict: ['id'] }),
    ],
  ];
  for (const [name, body] of rewrites) {
    test(
      `${name} is refused by both, before any statement`,
      async () => {
        const [memory, pg] = await both(body);
        expect(memory).toEqual({ code: APPEND_ONLY_CODE });
        expect(pg).toEqual(memory);
      },
      PGLITE_BOOT_MS,
    );
  }

  test('appending answers the same in both', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.ledger.insert({
        id: '00000000-0000-7000-8000-000000000002',
        account: 'cash',
        amount: -40,
      });
      return db.ledger.sum('amount');
    });
    expect(memory).toEqual({ ok: '60' });
    expect(pg).toEqual(memory);
  });
});

describe('appendOnly · the table refuses what the repository never sends', () => {
  test('a raw UPDATE and a raw DELETE on the migrated table are refused by its trigger', async () => {
    await both(async () => undefined);
    for (const statement of [
      `update "aop_ledger" set amount = 0 where id = '${ID}'`,
      `delete from "aop_ledger" where id = '${ID}'`,
    ]) {
      const refused = await outcome(() => client.execute(raw(statement)));
      expect(refused).not.toHaveProperty('ok');
    }
    const rows = await client.query<{ amount: number }>(raw('select amount from "aop_ledger"'));
    expect(rows).toEqual([{ amount: 100 }]);
  });
});
