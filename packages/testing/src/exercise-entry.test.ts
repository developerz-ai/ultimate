// An input-only `defineExercise` entry (`{ input }`, no `actor`): it typechecks, the pass keeps
// the actor it would have picked, and the input is still bound — and awaited as that actor.

import { describe, expect, test } from 'bun:test';
import type { NamedActor } from '@ultimat3/policy';
import { can, definePermissions, testActor } from '@ultimat3/policy';
import type { ExerciseOverride } from './define-exercise';
import { chooseActor, exerciseActorId } from './exercise-actor';
import { isAsyncInput, overrideInput } from './exercise-override-input';
import { testName } from './test-types';

definePermissions(['exn:write']);

const grants = (tenant: string): readonly NamedActor[] => [
  { name: 'anonymous', actor: null },
  testActor('writer', { permissions: ['exn:write'], orgId: tenant }),
];

const inputOnly: ExerciseOverride = { input: async (drawn) => ({ ...drawn, slug: 'bound' }) };

describe(testName('unit', 'an input-only exercise entry'), () => {
  test('keeps the actor the pass picks, as a user id in the tenant', () => {
    const choice = chooseActor(can('exn:write'), ['exn:write'], grants, 't1', inputOnly);
    expect(choice).toMatchObject({ kind: 'actor', name: 'writer' });
    expect(choice.kind === 'actor' && choice.actor?.id).toBe(exerciseActorId('writer', 't1'));
  });

  test('an explicit `actor: undefined` is no declaration either', () => {
    const entry: ExerciseOverride = { actor: undefined, input: (drawn) => drawn };
    expect(chooseActor(can('exn:write'), ['exn:write'], grants, 't1', entry)).toMatchObject({
      name: 'writer',
    });
  });

  test('its input is bound, and counted async', async () => {
    const bind = overrideInput('exnBind', inputOnly);
    if (bind === undefined) return expect.unreachable('an input-only entry bound nothing');
    expect(await bind({ title: 'x' }, null)).toEqual({ title: 'x', slug: 'bound' });
    expect(isAsyncInput(inputOnly)).toBe(true);
  });
});
