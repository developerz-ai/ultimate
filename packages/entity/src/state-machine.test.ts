import { describe, expect, test } from 'bun:test';
import { enumerated } from './columns';
import {
  canMove,
  isTerminal,
  movesFrom,
  stateMachineOf,
  type TransitionTable,
} from './state-machine';

const STATES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'] as const;
type State = (typeof STATES)[number];

const TABLE: TransitionTable<State> = {
  pending: ['paid', 'cancelled'],
  paid: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

describe('stateMachineOf', () => {
  test('answers the legal moves and nothing else', () => {
    const machine = stateMachineOf(STATES, TABLE);
    expect(canMove(machine, 'pending', 'paid')).toBe(true);
    expect(canMove(machine, 'pending', 'shipped')).toBe(false);
    expect(canMove(machine, 'shipped', 'pending')).toBe(false);
    expect(movesFrom(machine, 'pending')).toEqual(['paid', 'cancelled']);
  });

  test('a terminal state is one nothing leaves — derived, never declared', () => {
    const machine = stateMachineOf(STATES, TABLE);
    expect([...machine.terminal].sort()).toEqual(['cancelled', 'delivered']);
    expect(isTerminal(machine, 'cancelled')).toBe(true);
    expect(isTerminal(machine, 'pending')).toBe(false);
    // Nothing leaves it, whatever it is asked about.
    for (const to of STATES) expect(canMove(machine, 'cancelled', to)).toBe(false);
  });

  test('never answers a prototype member for a state that is not one', () => {
    const machine = stateMachineOf(STATES, TABLE);
    expect(canMove(machine, 'constructor', 'paid')).toBe(false);
    expect(canMove(machine, 'pending', 'toString')).toBe(false);
    expect(isTerminal(machine, 'hasOwnProperty')).toBe(false);
    expect(movesFrom(machine, '__proto__')).toEqual([]);
  });

  test('refuses a table that does not name every state', () => {
    expect(() =>
      stateMachineOf(STATES, { pending: ['paid'], paid: [], shipped: [], delivered: [] } as never),
    ).toThrow(/cancelled/);
  });

  test('refuses a key or a target the enumerated set does not contain', () => {
    expect(() => stateMachineOf(STATES, { ...TABLE, refunded: [] } as never)).toThrow(/refunded/);
    expect(() => stateMachineOf(STATES, { ...TABLE, paid: ['refunded'] } as never)).toThrow(
      /refunded/,
    );
  });

  test('refuses a self-loop — a transition that transitions nothing', () => {
    expect(() => stateMachineOf(STATES, { ...TABLE, paid: ['paid'] } as never)).toThrow(/paid/);
  });

  test('refuses a duplicate target', () => {
    expect(() => stateMachineOf(STATES, { ...TABLE, pending: ['paid', 'paid'] } as never)).toThrow(
      /paid/,
    );
  });
});

describe('enumerated().transitions()', () => {
  test('carries the machine on the column, built from the column values', () => {
    const status = enumerated(STATES).transitions(TABLE);
    expect(status.$meta.machine?.states).toEqual([...STATES]);
    expect(canMove(status.$meta.machine ?? stateMachineOf([], {}), 'pending', 'paid')).toBe(true);
  });

  test('survives the rest of the chain, in either order', () => {
    const a = enumerated(STATES).transitions(TABLE).default('pending').column('order_status');
    expect(a.$meta.machine).toBeDefined();
    expect(a.$meta.name).toBe('order_status');
    expect(a.$optional).toBe(true);
    const b = enumerated(STATES).default('pending').transitions(TABLE);
    expect(b.$meta.machine).toBeDefined();
    expect(b.$optional).toBe(true);
  });

  test('a state machine column may not be nullable, in either order', () => {
    expect(() => enumerated(STATES).transitions(TABLE).nullable()).toThrow(/null/);
    // The other order is not spellable at all: `nullable()` answers the general `Column`, which has
    // no `transitions` — so TypeScript refuses it before the runtime guard is reached. The guard
    // stays because a JS caller and a re-wrapped `$meta` both reach it.
    const nullable = enumerated(STATES).nullable() as unknown as {
      transitions: (table: TransitionTable<State>) => unknown;
    };
    expect(typeof nullable.transitions).toBe('undefined');
  });

  test('an ordinary enumerated column is unchanged — nullable, and carrying no machine', () => {
    const plain = enumerated(STATES).nullable();
    expect(plain.$meta.machine).toBeUndefined();
    expect(plain.$parse(null)).toBeNull();
  });
});
