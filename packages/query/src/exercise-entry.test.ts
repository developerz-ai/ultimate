// A read's exercise entry as `defineExercise` declares it: `actor` optional, and a drift's fix
// naming the field the draw could not fill. Action's `exercise-entry.test.ts`, twinned.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { allow, can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { QueryExerciseActorOptions, QueryExerciseOptions } from './exercise';
import { exerciseQuery } from './exercise';
import { query } from './query';
import { from } from './source';

const failureOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return error;
    expect.unreachable(`a coded refusal, got ${String(error)}`);
  }
  return expect.unreachable('the exercise passed');
};

const read = (name: string, input: Parameters<typeof query>[0]['input'], open: boolean) =>
  query({
    input,
    policy: open ? allow() : can('entry:read'),
    sql: () => from<{ id: string }>('rows', [{ id: 'a' }]),
  }).named(name);

describe('an input-only read entry', () => {
  test('typechecks: `actor` is optional', () => {
    const entry: QueryExerciseActorOptions = { input: (drawn) => drawn };
    const options: QueryExerciseOptions = entry;
    expect('actor' in options).toBe(false);
  });

  test('reads signed out where the policy admits it', async () => {
    const open = read('entryReadOpen', t.object({ term: t.string.max(5) }), true);
    expect((await exerciseQuery(open, { input: (drawn) => drawn, runs: 2 })).reached).toBe(2);
  });

  test('is X_CONTRACT_EXERCISE_UNDECLARED on a guarded read', async () => {
    const guarded = read('entryReadGuarded', t.object({ term: t.string.max(5) }), false);
    const refused = await failureOf(() => exerciseQuery(guarded, { input: (drawn) => drawn }));
    expect(refused.code).toBe('X_CONTRACT_EXERCISE_UNDECLARED');
    expect(refused.cause).toContain('names no actor');
  });
});

describe('X_CONTRACT_DRIFT on a read', () => {
  test("names the field in the cause and binds it in the fix's input", async () => {
    // A pattern no string matches: no draw, minimal or seeded, can ever fill it.
    const schema = t.object({ digits: t.string.pattern(/^(?=x)y$/) });
    const drift = await failureOf(() =>
      exerciseQuery(read('entryReadDrift', schema, true), { actor: null }),
    );
    expect(drift.code).toBe('X_CONTRACT_DRIFT');
    expect(drift.cause).toContain('digits (must match ^(?=x)y$)');
    expect(drift.fix).toContain(
      'defineExercise({ entryReadDrift: { input: (drawn) => ({ ...drawn, digits: "<must match ^(?=x)y$>" }) } })',
    );
  });
});
