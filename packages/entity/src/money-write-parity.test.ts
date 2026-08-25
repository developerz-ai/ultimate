// Money is the one column whose write type is wider than its row type, and both drivers narrow it
// at the same position: the write method the caller reached, before anything else reads the row.
// The observer is an invariant — `$assert` runs in JS, in both drivers, before a statement exists —
// so it can say WHEN the narrowing happened and not only that it had by the time the row landed.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createRecordingClient, type RecordingClient, setDbClient } from '@ultimat3/db';
import { money, text, uuid } from './columns';
import { entity } from './entity';
import { invariant } from './invariants';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';
import type { Repo } from './repo';
import type { RowWrite } from './types';

/** The one amount this fixture's rows carry, so an invariant can name it exactly. */
const AMOUNT = 129_900;

/**
 * The observer, and the reason it is an `eq`: `assertInvariants` runs `holds` for every invariant
 * kind, `.eq()` compares with `===`, and `===` is the one operator in this DSL that can tell
 * `129900n` from `129900` — `.atLeast()` and every SQL comparison accept both. `$assert` is called
 * before a statement exists in BOTH drivers, so a rule reading `total.minor` is the only thing that
 * can say WHEN the narrowing ran rather than merely that it ran by the time the row was stored.
 *
 * A money property cannot be named whole in an invariant (`total is money: name total.minor or
 * total.currency`), which is why this reads the part.
 */
const invoices = entity('money_write_parity_invoices', {
  columns: { id: uuid().primaryKey(), reference: text({ max: 40 }), total: money() },
  invariants: (c) => [invariant('total_minor_is_the_fixture_amount', c.total.minor.eq(AMOUNT))],
});

type Invoice = typeof invoices.$row;

const ID = '00000000-0000-7000-8000-0000000000b1';

/**
 * A minor unit read straight off a `bigint` column — hand-written SQL, a backfill, a replication
 * frame — reaching a write with no conversion at the call site. `MoneyInput` is what documents it
 * and `RowWrite<Row>` is what lets a caller spell it; the row type stays `MoneyValue`.
 */
const wide: RowWrite<Invoice> = {
  id: ID,
  reference: 'INV-1',
  total: { minor: BigInt(AMOUNT), currency: 'EUR' },
};

const narrow = { minor: AMOUNT, currency: 'EUR' };

/** What Postgres answers a write with `returning *`: the row as the table holds it. */
const stored = { id: ID, reference: 'INV-1', total_minor: '129900', total_currency: 'EUR' };

let client: RecordingClient;

beforeEach(() => {
  client = createRecordingClient();
  setDbClient(client);
});

afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

/** Both drivers, one table of cases: a rule proved against memory alone says nothing about SQL. */
const drivers = (): readonly (readonly [string, () => Repo<Invoice>])[] => [
  ['memory', () => memoryRepo(invoices)],
  ['postgres', () => postgresRepo(invoices)],
];

describe('a bigint minor unit is narrowed where the caller wrote it', () => {
  for (const [name, build] of drivers()) {
    test(`${name} · insert judges and stores the value type, never the spelling`, async () => {
      client.on('insert into', { rows: [stored] });
      const row = await build().insert(wide);
      expect(row.total).toEqual(narrow);
      expect(JSON.parse(JSON.stringify(row)).total).toEqual(narrow);
    });

    test(`${name} · insertAll judges the batch after narrowing it`, async () => {
      // The batch loop that makes an insert all-or-nothing runs `$assert` per row BEFORE any of
      // them lands. Narrowed only at `bindValues`/`write`, that loop was handed the caller's
      // `bigint` and the rule rejected a row every driver then stored correctly.
      client.on('insert into', { rows: [stored] });
      const [row] = await build().insertAll([wide]);
      expect(row?.total).toEqual(narrow);
    });

    test(`${name} · upsertAll judges the incoming rows after narrowing them`, async () => {
      client.on('insert into', { rows: [stored] });
      const [row] = await build().upsertAll([wide], { onConflict: ['id'] });
      expect(row?.total).toEqual(narrow);
    });
  }

  test('the two drivers answer with the same row', async () => {
    client.on('insert into', { rows: [stored] });
    const fromPostgres = await postgresRepo(invoices).insert(wide);
    const fromMemory = await memoryRepo(invoices).insert(wide);
    expect(fromMemory.total).toEqual(fromPostgres.total);
  });

  test('nothing bigint reaches the statement, and the caller keeps their own object', async () => {
    client.on('insert into', { rows: [stored] });
    await postgresRepo(invoices).insert(wide);
    const values = client.statements.at(-1)?.values ?? [];
    expect(values).toContain(AMOUNT);
    expect(values.every((value) => typeof value !== 'bigint')).toBe(true);
    // Narrowing copies; the row the caller built is theirs and is unchanged.
    expect(wide.total).toEqual({ minor: BigInt(AMOUNT), currency: 'EUR' });
  });
});
