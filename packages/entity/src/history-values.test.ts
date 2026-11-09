// `entity({ history: true })` over the values a jsonb image spells differently from the row: an
// `int8` past 2^53, a `numeric` with its scale, a `timestamptz` under a non-UTC session zone. The
// trigger on embedded Postgres must record the image the memory driver records, digit for digit.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { timestamp, uuid } from './columns';
import { bigint, decimal } from './columns-data';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const PGLITE_BOOT_MS = 30_000;
const ORG = '00000000-0000-7000-8000-0000000000aa';
const ID = '00000000-0000-7000-8000-000000000001';

const ledger = entity('histv_ledger', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    serial: bigint(),
    rate: decimal({ precision: 8, scale: 2 }),
    settledAt: timestamp(),
  },
  history: true,
});
const history = ledger.$history ?? expect.unreachable('history: true declares a history entity');
const ENTITIES = { ledger, history };
const client = pgliteClient();

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [ledger.$describe(), history.$describe()],
    name: 'history values',
    now: new Date('2026-11-06T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
  // The image must not depend on the zone the writing session happens to be in.
  await client.execute(raw("set time zone 'America/New_York'"));
}, PGLITE_BOOT_MS);

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
});

afterAll(() => {
  clearRegistry();
});

const run = async (driver: Driver) => {
  await client.execute(raw('delete from "histv_ledger"'));
  await client.execute(raw(`select set_config('x.purge', 'histv_ledger_history', false)`));
  await client.execute(raw('delete from "histv_ledger_history"'));
  await client.execute(raw(`select set_config('x.purge', '', false)`));
  const db = database(ENTITIES, { driver });
  const ctx = ctxOf({ actor: { ...userActor({ id: 'member-1' }), orgId: ORG } });
  return runWithContext(ctx, async () => {
    await db.ledger.insert({
      id: ID,
      orgId: ORG,
      serial: '9007199254740993',
      rate: '7.50',
      settledAt: new Date('2026-11-06T10:15:30.123Z'),
    });
    const [row] = await db.history.all();
    return row?.after;
  });
};

describe('history · values a jsonb number or a session zone would change', () => {
  test('the trigger records the digits and the UTC instant, as memory does', async () => {
    const postgres = await run(postgresDriver());
    expect(postgres).toMatchObject({
      serial: '9007199254740993',
      rate: '7.50',
      settled_at: '2026-11-06T10:15:30.123Z',
    });
    expect(await run(memoryDriver())).toEqual(postgres);
  });

  test('the description names those columns for the trigger', () => {
    expect(ledger.$describe().history).toMatchObject({
      text: ['serial', 'rate'],
      instants: ['settled_at'],
    });
  });
});
