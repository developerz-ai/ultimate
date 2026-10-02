// The `id` a transition takes is the entity's KEY, whatever its type. It was `t.uuid`, so a move on
// an entity keyed by `text()` or `bigint()` was `X_INPUT_INVALID` on every call — the mechanism
// underneath (`transitionRow`) addresses any single-column key.

import { describe, expect, test } from 'bun:test';
import { createContext, UltimateError, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';
import { type TransitionTarget, transition } from './transition';

const STATES = ['pending', 'paid'] as const;
type State = (typeof STATES)[number];
interface Row {
  readonly id: string;
  readonly status: State;
}

const ctx = createContext({ actor: { ...userActor({ id: 'u1' }), permissions: ['order:move'] } });
const UUID = '00000000-0000-4000-8000-0000000000aa';

const moved: string[] = [];
const table: TransitionTarget<Row, State> = {
  transition: (_column, id, move) => {
    moved.push(id);
    return Promise.resolve({ id, status: move.to });
  },
};

const over = <TOutput extends StandardSchemaV1<unknown, Row>>(output: TOutput, name: string) =>
  transition({
    table: () => table,
    column: 'status',
    states: STATES,
    localTable: 'orders',
    output,
    policy: can('order:move'),
  }).named(name);

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof UltimateError) return error.code;
    return expect.unreachable('not an UltimateError');
  }
  return 'ran';
};

const move = { from: 'pending', to: 'paid' } as const;

describe('transition(): the id schema is the key the output declares', () => {
  test('a text key moves — and still refuses the empty string, which names no row', async () => {
    const byText = over(t.object({ id: t.string.max(40), status: t.enum(STATES) }), 'moveByText');
    moved.length = 0;
    expect(await codeOf(() => byText({ id: 'ord_2026_0001', ...move }, { ctx }))).toBe('ran');
    expect(moved).toEqual(['ord_2026_0001']);
    expect(await codeOf(() => byText({ id: '', ...move }, { ctx }))).toBe('X_INPUT_INVALID');
    expect(await codeOf(() => byText({ id: 'x'.repeat(41), ...move }, { ctx }))).toBe(
      'X_INPUT_INVALID',
    );
  });

  test('a bigint key — digits as a string, the shape an entity view publishes — moves', async () => {
    const digits = t.string.pattern(/^-?\d+$/);
    const byBigint = over(t.object({ id: digits, status: t.enum(STATES) }), 'moveByBigint');
    moved.length = 0;
    expect(await codeOf(() => byBigint({ id: '9007199254740993', ...move }, { ctx }))).toBe('ran');
    expect(moved).toEqual(['9007199254740993']);
    expect(await codeOf(() => byBigint({ id: 'ord_1', ...move }, { ctx }))).toBe('X_INPUT_INVALID');
  });

  test('a uuid key still refuses a string that is not one, before a database is touched', async () => {
    const byUuid = over(t.object({ id: t.uuid, status: t.enum(STATES) }), 'moveByUuid');
    moved.length = 0;
    expect(await codeOf(() => byUuid({ id: 'ord_1', ...move }, { ctx }))).toBe('X_INPUT_INVALID');
    expect(await codeOf(() => byUuid({ id: UUID, ...move }, { ctx }))).toBe('ran');
    expect(moved).toEqual([UUID]);
  });

  test('the published input carries the key’s own shape, on every projection', () => {
    const byText = over(t.object({ id: t.string.max(40), status: t.enum(STATES) }), 'moveDocText');
    const properties = byText.tool().inputSchema['properties'] as Record<string, unknown>;
    expect(properties['id']).toEqual({ type: 'string', minLength: 1, maxLength: 40 });
  });
});
