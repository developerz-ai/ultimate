// One declaration of an action's exercise: `.contract({ exercise })` handed the app's
// `defineExercise()` value reads the entry named for the action — the one `x exercise` reads.

import { describe, expect, test } from 'bun:test';
import { EXERCISE_RUNS, isUltimateError, type UltimateError } from '@ultimat3/core';
import { allow, can, testActor } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import type { ContractTest } from './contract-test';
import type { ExerciseDeclarations, ExerciseOptions } from './exercise-declarations';

const Input = t.object({ title: t.string.min(1).max(40) });
const Output = t.object({ by: t.string });
const ADA = testActor('ada', { permissions: ['note:write'] }).actor;

const declared = (entries: Record<string, ExerciseOptions>): ExerciseDeclarations => ({
  kind: 'exercise-overrides',
  entries: new Map(Object.entries(entries)),
});

const fourth = (contracts: readonly ContractTest[]): ContractTest =>
  contracts[3] ?? expect.unreachable('contractTestsFor emitted no fourth test');

const failureOf = async (run: () => Promise<unknown>): Promise<UltimateError> => {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return error;
    expect.unreachable(`a coded refusal, got ${String(error)}`);
  }
  return expect.unreachable('the exercise passed');
};

/** A guarded action recording who each reached run acted as. */
const guarded = (name: string, seen: string[]) =>
  action({
    input: Input,
    output: Output,
    policy: can('note:write'),
    handle: ({ ctx }) => {
      seen.push(ctx.actor.id);
      return { by: ctx.actor.id };
    },
  }).named(name);

describe('.contract({ exercise }) with the app declarations', () => {
  test('runs the entry named for the action, as its actor', async () => {
    const seen: string[] = [];
    const target = guarded('declaredNote', seen);
    const exercise = declared({ declaredNote: { actor: ADA }, otherNote: { off: 'n/a' } });
    await fourth(target.contract({ exercise })).run();
    expect(seen).toEqual(Array.from({ length: EXERCISE_RUNS }, () => ADA.id));
  });

  test('an entry turned off is listed with its reason', () => {
    const target = guarded('offNote', []);
    const contract = fourth(
      target.contract({ exercise: declared({ offNote: { off: 'a vendor' } }) }),
    );
    expect(contract.name).toBe('offNote: handler exercise off: a vendor');
  });

  test('no entry for a guarded action is X_CONTRACT_EXERCISE_UNDECLARED, naming exercise.ts', async () => {
    const target = guarded('missingNote', []);
    const failure = await failureOf(() =>
      fourth(target.contract({ exercise: declared({ otherNote: { actor: ADA } }) })).run(),
    );
    expect(failure.code).toBe('X_CONTRACT_EXERCISE_UNDECLARED');
    expect(failure.cause).toContain('apps/web/exercise.ts');
    expect(failure.fix).toContain('defineExercise({ missingNote: { actor } })');
  });

  test('no entry for a public action exercises as the signed-out caller', async () => {
    const seen: string[] = [];
    const target = action({
      input: Input,
      output: Output,
      policy: allow(),
      handle: ({ ctx }) => {
        seen.push(ctx.actor.id);
        return { by: ctx.actor.id };
      },
    }).named('publicNote');
    await fourth(target.contract({ exercise: declared({}) })).run();
    expect(seen).toHaveLength(EXERCISE_RUNS);
  });

  test('nothing declared at all points at the one home, apps/web/exercise.ts', async () => {
    const failure = await failureOf(() => fourth(guarded('bareNote', []).contract()).run());
    expect(failure.code).toBe('X_CONTRACT_EXERCISE_UNDECLARED');
    expect(failure.fix).toContain('defineExercise({ bareNote: { actor } })');
    expect(failure.fix).toContain('apps/web/exercise.ts');
  });
});

test('an unreached exercise names the entry to fix in apps/web/exercise.ts', async () => {
  // The declared actor holds nothing the policy asks for, so no run reaches the handler.
  const nobody = testActor('nobody', { permissions: [] }).actor;
  const target = guarded('deniedNote', []);
  const exercise = declared({ deniedNote: { actor: nobody } });
  const failure = await failureOf(() => fourth(target.contract({ exercise })).run());
  expect(failure.code).toBe('X_CONTRACT_EXERCISE_UNREACHED');
  expect(failure.fix).toContain(
    'defineExercise({ deniedNote: { actor } })   # in apps/web/exercise.ts',
  );
});
