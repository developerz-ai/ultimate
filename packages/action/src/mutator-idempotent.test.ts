// A mutator is replayable by construction: its write is retried and drained from an offline queue
// under one key, and the server reads that key only for `idempotent: true`. So a mutator that does
// not declare it is refused where it is declared — never left to apply a replay twice.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { MutatorDef } from './mutator';
import { mutator } from './mutator';
import { transition } from './transition';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ likes: t.number });

const base = {
  input: Input,
  output: Output,
  policy: allow(),
  local() {},
  server: () => ({ likes: 1 }),
  conflict: 'server-wins',
} as const;

/** What an untyped caller — generated JS, a cast — can still hand over. */
const untyped = (def: object): MutatorDef<typeof Input, typeof Output> =>
  def as MutatorDef<typeof Input, typeof Output>;

const refusal = (def: object): UltimateError => {
  try {
    mutator(untyped(def));
  } catch (error) {
    if (error instanceof UltimateError) return error;
    return expect.unreachable('not an UltimateError');
  }
  return expect.unreachable('the declaration was accepted');
};

describe('mutator(): idempotent is part of the declaration', () => {
  test('omitted is refused at declaration, with the edit that fixes it', () => {
    const error = refusal(base);
    expect(error.code).toBe('X_MUTATOR_NOT_IDEMPOTENT');
    expect(error.fix).toContain('idempotent: true');
  });

  test('every value that is not `true` is refused — false, null, a truthy string', () => {
    for (const idempotent of [false, null, 'true', 1]) {
      expect(refusal({ ...base, idempotent }).code).toBe('X_MUTATOR_NOT_IDEMPOTENT');
    }
  });

  test('the type refuses it first: a definition without the member does not compile', () => {
    // @ts-expect-error — `idempotent: true` is required by `MutatorDef`; the runtime refusal above
    // is for a caller the compiler never saw.
    expect(() => mutator(base)).toThrow();
  });

  test('declared, the action underneath is idempotent on every surface', () => {
    const liked = mutator({ ...base, idempotent: true }).named('likePostDeclared');
    expect(liked.describe().idempotent).toBe(true);
    expect(liked.openapi().parameters.map((parameter) => parameter['name'])).toContain(
      'Idempotency-Key',
    );
  });

  test('transition() returns a mutator, so it declares it for the app', () => {
    const move = transition({
      table: () => ({
        transition: (_column, id, move) => Promise.resolve({ id, status: move.to }),
      }),
      column: 'status',
      states: ['pending', 'paid'],
      localTable: 'orders',
      output: t.object({ id: t.string, status: t.enum(['pending', 'paid']) }),
      policy: allow(),
    }).named('moveOrderDeclared');
    expect(move.describe().idempotent).toBe(true);
  });
});
