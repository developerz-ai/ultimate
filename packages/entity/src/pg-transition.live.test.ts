// The claim a unit test cannot make: that the transition is atomic under REAL concurrency. Twenty
// callers all read `pending`, all find `pending -> paid` legal, and all issue the move at once —
// exactly one row-move may land. This repo has shipped a paging bug that reasoning said was fine
// and a live test found in three rows, so this one counts winners against a real server.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createContext, runWithContext, UltimateError, userActor } from '@ultimat3/core';
import {
  createPostgresClient,
  generateMigration,
  type PostgresClient,
  raw,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import { enumerated, text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';
import type { TransitionTable } from './state-machine';
import { transitionRow } from './transition';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const STATES = ['pending', 'paid', 'shipped', 'cancelled'] as const;
type State = (typeof STATES)[number];

const MOVES: TransitionTable<State> = {
  pending: ['paid', 'cancelled'],
  paid: ['shipped', 'cancelled'],
  shipped: [],
  cancelled: [],
};

const orders = entity('pg_tx_orders', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    reference: text({ max: 40 }),
    status: enumerated(STATES).transitions(MOVES).default('pending'),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
});

type Order = typeof orders.$row;

const DROP = 'drop table if exists "pg_tx_orders" cascade';
const ACME = '00000000-0000-7000-8000-00000000aaaa';
const OTHER = '00000000-0000-7000-8000-00000000bbbb';
const id = (n: number): string => `00000000-0000-7000-8000-0000000007${String(n).padStart(2, '0')}`;

const inOrg = <T>(orgId: string, work: () => Promise<T>): Promise<T> =>
  runWithContext(createContext({ actor: userActor({ id: 'live-mover', orgId }) }), work);

/** The repo call `Table.transition` makes, with the same `touch` the table applies. */
const move = (rowId: string, from: State, to: State): Promise<Order> =>
  transitionRow(
    orders,
    postgresRepo(orders),
    'status',
    rowId,
    { from, to },
    (patch) => ({ ...patch, updatedAt: new Date() }),
    undefined,
  );

describe.skipIf(!hasPostgres)('live · postgres · a state machine transition', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = createPostgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      entities: [orders.$describe()],
      name: 'live transition',
      now: new Date('2026-08-24T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
    // The states reach the database as the CHECK `enumerated()` already emits — the machine adds
    // no DDL of its own, so there is one declaration of what a legal value is.
    expect(migration.up).toContain("check (status in ('pending', 'paid', 'shipped', 'cancelled'))");
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
    clearRegistry();
  });

  test('twenty concurrent callers naming the same from-state produce exactly one move', async () => {
    const rowId = id(1);
    await inOrg(ACME, () =>
      postgresRepo(orders).insert({
        id: rowId,
        orgId: ACME,
        reference: 'race',
        status: 'pending',
        updatedAt: new Date(),
      }),
    );
    const attempts = Array.from({ length: 20 }, () =>
      inOrg(ACME, () => move(rowId, 'pending', 'paid')).then(
        () => 'won' as const,
        (error: unknown) => (error instanceof UltimateError ? error.code : 'other'),
      ),
    );
    const outcomes = await Promise.all(attempts);
    expect(outcomes.filter((each) => each === 'won')).toHaveLength(1);
    // Every loser is a CONFLICT and nothing else: no lost update, no second move, no bare throw.
    expect(new Set(outcomes.filter((each) => each !== 'won'))).toEqual(
      new Set(['X_STATE_CONFLICT']),
    );
    const after = await inOrg(ACME, () => postgresRepo(orders).findById(rowId));
    expect(after?.status).toBe('paid');
  });

  test('two callers racing to DIFFERENT legal targets: one lands, and the row is in one of them', async () => {
    const rowId = id(2);
    await inOrg(ACME, () =>
      postgresRepo(orders).insert({
        id: rowId,
        orgId: ACME,
        reference: 'fork',
        status: 'pending',
        updatedAt: new Date(),
      }),
    );
    const outcomes = await Promise.all([
      inOrg(ACME, () => move(rowId, 'pending', 'paid')).then(
        (row) => row.status,
        () => 'refused',
      ),
      inOrg(ACME, () => move(rowId, 'pending', 'cancelled')).then(
        (row) => row.status,
        () => 'refused',
      ),
    ]);
    expect(outcomes.filter((each) => each === 'refused')).toHaveLength(1);
    const after = await inOrg(ACME, () => postgresRepo(orders).findById(rowId));
    expect(['paid', 'cancelled']).toContain(after?.status ?? '');
  });

  test('a transition carries the tenant predicate — another org cannot move the row', async () => {
    const rowId = id(3);
    await inOrg(ACME, () =>
      postgresRepo(orders).insert({
        id: rowId,
        orgId: ACME,
        reference: 'theirs',
        status: 'pending',
        updatedAt: new Date(),
      }),
    );
    let failure: UltimateError | undefined;
    try {
      await inOrg(OTHER, () => move(rowId, 'pending', 'paid'));
    } catch (error) {
      failure = error instanceof UltimateError ? error : undefined;
    }
    // NOT FOUND and never CONFLICT: a conflict would confirm the row exists and name its state.
    expect(failure?.code).toBe('X_NOT_FOUND');
    expect(failure?.cause ?? '').not.toContain('pending');
    const untouched = await inOrg(ACME, () => postgresRepo(orders).findById(rowId));
    expect(untouched?.status).toBe('pending');
  });

  test('the database refuses a state the enumerated() CHECK does not hold, whatever this layer thinks', async () => {
    const rowId = id(4);
    await inOrg(ACME, () =>
      postgresRepo(orders).insert({
        id: rowId,
        orgId: ACME,
        reference: 'check',
        status: 'pending',
        updatedAt: new Date(),
      }),
    );
    // The last line of defence, and it is not this package's: a statement written past every guard
    // above still meets the CHECK the column declared.
    await expect(
      client.execute(
        raw(`update "pg_tx_orders" set "status" = 'refunded' where "id" = '${rowId}'`),
      ),
    ).rejects.toThrow();
  });
});
