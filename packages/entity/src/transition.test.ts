// The write half of a state machine: one conditional statement, and what happens when it matches
// no row. Against the in-memory driver, which implements the compare-and-set rather than refusing
// it — unlike full-text search, "the row is in this state, move it to that one" is a question a map
// can answer exactly as Postgres does. `pg-transition.live.test.ts` is the same file's other half.

import { afterAll, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { enumerated, text, timestamp, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { clearRegistry } from './registry';
import type { TransitionTable } from './state-machine';

const STATES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'] as const;
type State = (typeof STATES)[number];

const MOVES: TransitionTable<State> = {
  pending: ['paid', 'cancelled'],
  paid: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

const orders = entity('tx_orders', {
  columns: {
    id: uuid().primaryKey(),
    reference: text({ max: 40 }),
    status: enumerated(STATES).transitions(MOVES).default('pending'),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
});

const plain = entity('tx_plain', {
  columns: {
    id: uuid().primaryKey(),
    status: enumerated(STATES).default('pending'),
  },
});

afterAll(() => {
  clearRegistry();
});

const ID = '00000000-0000-7000-8000-000000000101';

const fresh = () => {
  const db = database({ orders, plain }, { driver: memoryDriver() });
  return db;
};

const code = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof UltimateError) return error.code;
    return expect.unreachable('not an UltimateError');
  }
  return expect.unreachable('nothing was refused');
};

describe('Table.transition', () => {
  test('moves a row the machine allows, and stamps the onUpdateNow column', async () => {
    const db = fresh();
    const written = await db.orders.insert({ id: ID, reference: 'a' });
    const moved = await db.orders.transition('status', ID, { from: 'pending', to: 'paid' });
    expect(moved.status).toBe('paid');
    expect(moved.id).toBe(ID);
    // The audit of WHEN it moved is the mechanism already there: a transition is an update.
    expect(moved.updatedAt.getTime()).toBeGreaterThanOrEqual(written.updatedAt.getTime());
    expect((await db.orders.where({ id: ID }).one())?.status).toBe('paid');
  });

  test('refuses a move the machine does not hold, before any statement runs', async () => {
    const db = fresh();
    await db.orders.insert({ id: ID, reference: 'a' });
    expect(
      await code(() => db.orders.transition('status', ID, { from: 'pending', to: 'shipped' })),
    ).toBe('X_STATE_TRANSITION_ILLEGAL');
    // Nothing moved: the refusal is the declaration's, not the database's.
    expect((await db.orders.where({ id: ID }).one())?.status).toBe('pending');
  });

  test('refuses every move out of a terminal state, and says it is terminal', async () => {
    const db = fresh();
    await db.orders.insert({ id: ID, reference: 'a' });
    await db.orders.transition('status', ID, { from: 'pending', to: 'cancelled' });
    let cause = '';
    try {
      await db.orders.transition('status', ID, { from: 'cancelled', to: 'paid' });
    } catch (error) {
      cause = error instanceof UltimateError ? error.cause : '';
    }
    expect(cause).toContain('terminal');
  });

  test('a row already moved on is a CONFLICT naming the state it is really in', async () => {
    const db = fresh();
    await db.orders.insert({ id: ID, reference: 'a' });
    await db.orders.transition('status', ID, { from: 'pending', to: 'paid' });
    let failure: UltimateError | undefined;
    try {
      // The lost update, made visible: this caller read `pending` and the row is `paid` now.
      await db.orders.transition('status', ID, { from: 'pending', to: 'cancelled' });
    } catch (error) {
      failure = error instanceof UltimateError ? error : undefined;
    }
    expect(failure?.code).toBe('X_STATE_CONFLICT');
    expect(failure?.cause).toContain('paid');
    expect((await db.orders.where({ id: ID }).one())?.status).toBe('paid');
  });

  test('a row that is not there is NOT FOUND, never a conflict', async () => {
    const db = fresh();
    expect(
      await code(() => db.orders.transition('status', ID, { from: 'pending', to: 'paid' })),
    ).toBe('X_NOT_FOUND');
  });

  test('a column that declares no machine is refused, and names the ones that do', async () => {
    const db = fresh();
    await db.plain.insert({ id: ID });
    expect(
      await code(() => db.plain.transition('status', ID, { from: 'pending', to: 'paid' })),
    ).toBe('X_STATE_UNDECLARED');
  });
});

describe('Table.transition · a state the machine never declared', () => {
  test('is refused as an unknown state, never reported as terminal', async () => {
    const db = fresh();
    await db.orders.insert({ id: ID, reference: 'a' });
    let failure: UltimateError | undefined;
    try {
      // Reachable from JS and from a `from` that came out of parsed JSON. An unknown state has no
      // outgoing moves, so a check that only asked "are there any" would call this typo terminal.
      await db.orders.transition('status', ID, { from: 'pendign' as 'pending', to: 'paid' });
    } catch (error) {
      failure = error instanceof UltimateError ? error : undefined;
    }
    expect(failure?.code).toBe('X_STATE_TRANSITION_ILLEGAL');
    expect(failure?.cause).toContain('is not a state');
    expect(failure?.cause).not.toContain('terminal');
    expect(failure?.cause).toContain('pending | paid');
  });
});
