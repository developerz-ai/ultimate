// The entity driver suite over `postgresDriver()` on the embedded Postgres (PGlite): the driver
// `x dev` runs, in the unit step. The same suite against a server is the `.live.` twin. Two claims
// below the suite are this engine's alone — they turn on SESSION state and on PGlite's `C`
// collation, neither of which a driver can promise for a server it did not create.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { pgliteClient, raw, setDbClient } from '@ultimat3/db';
import {
  database,
  entity,
  integer,
  memoryDriver,
  postgresDriver,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';
import { recreateTables, sqlSubject } from './entity-conformance-sql-fixture';
import { idAt } from './entity-conformance-support';
import { entityDriverConformance } from './entity-driver-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

// A WASM compile plus an initdb, against bun's 5s default — a hang detector, not a budget.
const PGLITE_BOOT_MS = 30_000;

const client = pgliteClient();

beforeAll(() => {
  setDbClient(client);
}, PGLITE_BOOT_MS);

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
});

describe(testName('unit', 'the postgres entity driver on PGlite'), () => {
  behavesLike(entityDriverConformance, () => sqlSubject(() => client));
});

const events = remember(
  entity('ec_s_events', { columns: { id: uuid().primaryKey(), at: timestamp() } }),
);
const ledger = remember(
  entity('ec_s_ledger', {
    columns: { id: uuid().primaryKey(), account: text(), amount: integer() },
    appendOnly: true,
  }),
);
const labels = remember(
  entity('ec_s_labels', { columns: { id: uuid().primaryKey(), label: text() } }),
);

const AT = [
  new Date('0099-06-01T00:00:00.000Z'),
  new Date('1900-01-01T12:00:00.000Z'),
  new Date('2026-09-23T10:15:30.123Z'),
];

describe(testName('unit', 'PGlite · what the session and the collation decide'), () => {
  // Written under UTC, read under another session zone: an offset with seconds (`+00:19:32`,
  // Amsterdam's pre-1937 LMT) parsed as NaN, and year 0099 came back as 1999.
  test.each(['UTC', 'Europe/Amsterdam', 'America/New_York', 'Asia/Tokyo'])(
    'min/max over a timestamptz are the same instants under a %s session',
    async (zone) => {
      await recreateTables(client, [events]);
      await client.execute(raw("set time zone 'UTC'"));
      const db = database({ events }, { driver: postgresDriver() });
      for (const [index, at] of AT.entries()) await db.events.insert({ id: idAt(index + 1), at });
      await client.execute(raw(`set time zone '${zone}'`));
      try {
        expect([await db.events.min('at'), await db.events.max('at')]).toEqual([
          AT[0] ?? null,
          AT[2] ?? null,
        ]);
      } finally {
        await client.execute(raw("set time zone 'UTC'"));
      }
    },
    PGLITE_BOOT_MS,
  );

  // The repository never sends a rewrite (the suite proves it); the TABLE refuses the raw SQL too:
  // the trigger `x db gen` writes, run by a real engine, plpgsql included.
  test('an append-only table refuses a raw UPDATE and DELETE, and keeps the row', async () => {
    await recreateTables(client, [ledger]);
    const id = idAt(1);
    await database({ ledger }, { driver: postgresDriver() }).ledger.insert({
      id,
      account: 'cash',
      amount: 100,
    });
    for (const statement of [
      `update "ec_s_ledger" set amount = 0 where id = '${id}'`,
      `delete from "ec_s_ledger" where id = '${id}'`,
    ]) {
      const refused = await client.execute(raw(statement)).then(
        () => 'applied',
        () => 'refused',
      );
      expect([statement, refused]).toEqual([statement, 'refused']);
    }
    expect(await client.query<{ amount: number }>(raw('select amount from "ec_s_ledger"'))).toEqual(
      [{ amount: 100 }],
    );
  });

  // UTF-16 `<` put an astral character (lead surrogate 0xD83D) BEFORE U+FF01; code-point order
  // (`C`, what PGlite initialises with) puts it after. A server created `en_US.utf8` answers neither.
  test('a text column orders by code point, as memory does', async () => {
    await recreateTables(client, [labels]);
    const order = async (driver: ReturnType<typeof memoryDriver>) => {
      const db = database({ labels }, { driver });
      for (const [index, label] of ['big', '\u{1F600}', '！'].entries()) {
        await db.labels.insert({ id: idAt(index + 1), label });
      }
      return (await db.labels.orderBy('label', 'asc').all()).map((row) => row.label);
    };
    expect(await order(postgresDriver())).toEqual(['big', '！', '\u{1F600}']);
    expect(await order(memoryDriver())).toEqual(['big', '！', '\u{1F600}']);
  });
});
