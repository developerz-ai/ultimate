// Money's write type is wider than its row type. What every driver answers for a `bigint` minor
// unit — narrowed where the caller wrote it — and every predicate on a whole money property are
// `@ultimat3/testing`'s `entityDriverConformance`. Left here: what the Postgres driver binds.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { type RecordingClient, recordingClient, setDbClient } from '@ultimat3/db';
import { money, text, uuid } from './columns';
import { entity } from './entity';
import { invariant } from './invariants';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';
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

/** What Postgres answers a write with `returning *`: the row as the table holds it. */
const stored = { id: ID, reference: 'INV-1', total_minor: '129900', total_currency: 'EUR' };

let client: RecordingClient;

beforeEach(() => {
  client = recordingClient();
  setDbClient(client);
});

afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

describe('the Postgres driver binds the narrowed value', () => {
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
