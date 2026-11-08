// An exercise entry as `defineExercise` declares it: `actor` optional (an input-only entry lets
// `x exercise` pick the actor), and a drift's fix naming the field the draw could not fill.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { allow, can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import type { ExerciseActorOptions, ExerciseOptions } from './exercise';
import { exerciseAction } from './exercise';
import { everyDrawRefused } from './exercise-errors';

const Input = t.object({ title: t.string.min(1).max(40) });
const Output = t.object({ ok: t.boolean });

const codeOf = async (run: () => Promise<unknown>): Promise<{ code: string; cause: string }> => {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: error.cause };
    expect.unreachable(`a coded refusal, got ${String(error)}`);
  }
  return expect.unreachable('the exercise passed');
};

describe('an input-only entry', () => {
  test('typechecks: `actor` is optional, as the pass reads it', () => {
    const entry: ExerciseActorOptions = { input: (drawn) => ({ ...drawn, title: 'x' }) };
    const options: ExerciseOptions = entry;
    expect('actor' in options).toBe(false);
  });

  test('runs as the signed-out caller when the policy admits one', async () => {
    const open = action({
      input: Input,
      output: Output,
      policy: allow(),
      handle: () => ({ ok: true }),
    }).named('entryOpen');
    const report = await exerciseAction(open, { input: (drawn) => drawn, runs: 2 });
    expect(report.reached).toBe(2);
  });

  test('is X_CONTRACT_EXERCISE_UNDECLARED on a guarded action: a contract test picks no actor', async () => {
    const guarded = action({
      input: Input,
      output: Output,
      policy: can('entry:write'),
      handle: () => ({ ok: true }),
    }).named('entryGuarded');
    const refused = await codeOf(() => exerciseAction(guarded, { input: (drawn) => drawn }));
    expect(refused.code).toBe('X_CONTRACT_EXERCISE_UNDECLARED');
    expect(refused.cause).toContain('names no actor');
  });
});

describe('X_CONTRACT_DRIFT', () => {
  test("names the field the draw cannot fill, in the cause and in the fix's input", () => {
    // A pattern no string matches: no draw, minimal or seeded, can ever fill it.
    const schema = t.object({ digits: t.string.pattern(/^(?=x)y$/), note: t.string });
    const drift = everyDrawRefused('signDigest', schema);
    expect(drift.code).toBe('X_CONTRACT_DRIFT');
    expect(drift.cause).toContain('digits (must match ^(?=x)y$)');
    expect(drift.fix).toContain(
      'defineExercise({ signDigest: { input: (drawn) => ({ ...drawn, digits: "<must match ^(?=x)y$>" }) } })',
    );
    expect(drift.fix).not.toContain('note');
  });

  test('a refinement the IR does not carry keeps the placeholder field', () => {
    const drift = everyDrawRefused('plain', t.object({ title: t.string }));
    expect(drift.fix).toContain("field: '<a value the refinement accepts>'");
  });
});
