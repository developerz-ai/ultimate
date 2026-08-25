// A move through a state machine, as a MUTATOR. Two things are under test and they are different
// questions: that the factory does not undo the compare-and-set underneath it (`from` reaches the
// statement, an unknown state never reaches a database, the entity's refusal arrives un-wrapped),
// and that what comes back is a mutator — every projection, or "not a ninth primitive" is a claim.
//
// The table is a local fake: `@ultimat3/action` holds no dependency edge on `@ultimat3/entity`, so
// the seam is structural and this file exercises the seam. That a REAL `Table` satisfies it is a
// type-level fact this package cannot assert; see the file header.

import { describe, expect, test } from 'bun:test';
import { createContext, UltimateError, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { LocalRow, LocalTable, LocalTx } from './mutator';
import { type TransitionTarget, transition } from './transition';

const STATES = ['pending', 'paid', 'shipped'] as const;
type State = (typeof STATES)[number];

const ID = '00000000-0000-4000-8000-0000000000aa';
const ctx = createContext({ actor: { ...userActor({ id: 'u1' }), permissions: ['order:move'] } });

const OrderView = t.object({ id: t.uuid, reference: t.string, status: t.enum(STATES) });

interface OrderRow extends LocalRow {
  readonly reference: string;
  readonly status: State;
}

interface Call {
  readonly column: string;
  readonly id: string;
  readonly from: State;
  readonly to: State;
}

const calls: Call[] = [];
/** Set to make the fake table refuse exactly as `@ultimat3/entity` does. */
let refuseWith: UltimateError | null = null;

const table: TransitionTarget<OrderRow, State> = {
  transition: (column, id, move) => {
    calls.push({ column, id, from: move.from, to: move.to });
    if (refuseWith !== null) return Promise.reject(refuseWith);
    // An extra member the output schema does not declare: a row is wider than its view.
    return Promise.resolve({
      id,
      reference: 'r-1',
      status: move.to,
      secret: 'internal',
    } as OrderRow);
  },
};

const moveOrder = transition({
  table: () => table,
  column: 'status',
  states: STATES,
  localTable: 'orders',
  output: OrderView,
  policy: can('order:move'),
}).named('moveOrder');

const audited = transition({
  table: () => table,
  column: 'status',
  states: STATES,
  localTable: 'orders',
  output: OrderView,
  policy: can('order:move'),
  audit: true,
}).named('auditedMoveOrder');

const fakeTx = (rows: Map<string, OrderRow>): LocalTx => {
  const local: LocalTable<OrderRow> = {
    insert: (row) => {
      rows.set(row.id, row);
    },
    update: (id, patch) => {
      const current = rows.get(id);
      if (current === undefined) return;
      rows.set(id, { ...current, ...(typeof patch === 'function' ? patch(current) : patch) });
    },
    delete: (id) => {
      rows.delete(id);
    },
  };
  return { table: () => local } as unknown as LocalTx;
};

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof UltimateError) return error.code;
    return expect.unreachable('not an UltimateError');
  }
  return expect.unreachable('nothing was refused');
};

describe('transition(), against the statement underneath it', () => {
  test('a state the machine does not declare never reaches a database', async () => {
    calls.length = 0;
    expect(
      await codeOf(() =>
        // @ts-expect-error — 'refunded' is not in the declared union, and THAT IS HALF THE TEST:
        // the directive fails if the typed surface ever stops refusing an undeclared state. The
        // assertion below is the other half — a caller reaching this at runtime is still refused.
        moveOrder({ id: ID, from: 'pending', to: 'refunded' }, { ctx }),
      ),
    ).toBe('X_INPUT_INVALID');
    expect(calls).toEqual([]);
  });

  test('`from` reaches the statement verbatim — it is the predicate, not a hint', async () => {
    calls.length = 0;
    refuseWith = null;
    await moveOrder({ id: ID, from: 'pending', to: 'paid' }, { ctx });
    expect(calls).toEqual([{ column: 'status', id: ID, from: 'pending', to: 'paid' }]);
  });

  test('the entity’s refusal arrives as itself — no second error class over one failure', async () => {
    refuseWith = new UltimateError({
      code: 'X_STATE_CONFLICT',
      cause: 'orders.status for row … is "paid", not "pending"',
      fix: 're-read the row and send the state it is really in',
    });
    const failure = await moveOrder({ id: ID, from: 'pending', to: 'paid' }, { ctx }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBe(refuseWith);
    refuseWith = null;
  });

  test('answers the output projection, not the row — a wider row loses its extra members', async () => {
    refuseWith = null;
    const moved = await moveOrder({ id: ID, from: 'pending', to: 'paid' }, { ctx });
    expect(moved).toEqual({ id: ID, reference: 'r-1', status: 'paid' });
    expect(Object.keys(moved)).not.toContain('secret');
  });

  test('the optimistic twin patches the column, and only it', () => {
    const rows = new Map<string, OrderRow>([[ID, { id: ID, reference: 'r-1', status: 'pending' }]]);
    moveOrder.local(fakeTx(rows), { id: ID, from: 'pending', to: 'paid' });
    expect(rows.get(ID)).toEqual({ id: ID, reference: 'r-1', status: 'paid' });
  });
});

describe('transition() is a mutator, so it inherits every projection', () => {
  test('describes as one, and the server always wins the rebase', () => {
    expect(moveOrder.isMutator).toBe(true);
    expect(moveOrder.describeMutator().kind).toBe('mutator');
    expect(moveOrder.describeMutator().conflict).toBe('server-wins');
    expect(moveOrder.describe().mutator).toBe(true);
  });

  test('projects a route, an OpenAPI operation, a client method, a tool, a job and its tests', () => {
    expect(moveOrder.describe().path).toBe('/api/orders/move');
    expect(moveOrder.openapi().operationId).toBe('moveOrder');
    expect(typeof moveOrder.client({ baseUrl: 'https://app.test' })).toBe('function');
    expect(moveOrder.tool().name).toBe('moveOrder');
    expect(moveOrder.job().name).toBe('action:moveOrder');
    expect(moveOrder.contract().length).toBeGreaterThan(0);
  });

  /**
   * The legal set is IN the contract, not only in the handler: the MCP tool's `inputSchema` and the
   * OpenAPI component both come from `input`, so an agent reads the states it may name — and the
   * typed client refuses the others at compile time, which no test can assert from in here.
   */
  test('publishes the states as an enum, so a typo is refused before a round trip', () => {
    const schema: Record<string, unknown> = moveOrder.tool().inputSchema;
    const properties = schema['properties'];
    // Narrowed rather than cast: an `inputSchema` that stopped carrying `properties` would make a
    // cast index `undefined` and both assertions below vacuous.
    expect(properties).toBeTypeOf('object');
    const bag = properties as Record<string, unknown>;
    expect(bag['from']).toMatchObject({ enum: [...STATES] });
    expect(bag['to']).toMatchObject({ enum: [...STATES] });
  });

  test('audits only when the app says so — an on-by-default sink is a hostage', () => {
    expect(moveOrder.describe().audited).toBe(false);
    expect(audited.describe().audited).toBe(true);
  });
});
