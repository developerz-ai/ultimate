// `x g sign-in`'s entries in apps/web/exercise.ts: added once, never over the app's own, and a file
// the generator cannot read as `defineExercise({ … })` left exactly as it was.

import { describe, expect, test } from 'bun:test';
import { exerciseWithEntries, signInExerciseEntries } from './exercise-registration';

const WRITTEN = [
  'apps/web/app/auth/actions/create-session.ts',
  'apps/web/app/auth/actions/confirm-session.ts',
  'apps/web/app/auth/actions/destroy-session.ts',
];

describe('unit · the sign-in generator’s exercise entries', () => {
  test('the two actions the pass cannot drive are owed an entry; the one it can is not', () => {
    expect(signInExerciseEntries(WRITTEN).map(([name]) => name)).toEqual([
      'createSession',
      'confirmSession',
    ]);
    expect(signInExerciseEntries(['apps/web/app/auth/actions/destroy-session.ts'])).toEqual([]);
  });

  test('the scaffold’s empty file gains both, one line each, inside the call', () => {
    const out = exerciseWithEntries(
      'export const exercise = defineExercise({});\n',
      signInExerciseEntries(WRITTEN),
    );
    expect(out).toBe(
      [
        'export const exercise = defineExercise({',
        "  createSession: { off: 'needs a real password; the pass draws one no account holds' },",
        "  confirmSession: { off: 'answers the challenge createSession holds; the pass holds none' },",
        '});',
        '',
      ].join('\n'),
    );
    expect(out.split('\n').every((line) => line.length <= 100)).toBe(true);
  });

  test('no file starts from x new’s, so an app older than the step is green after the generator', () => {
    const out = exerciseWithEntries(undefined, signInExerciseEntries(WRITTEN));
    expect(out).toContain("import { defineExercise } from '@ultimat3/testing';");
    expect(out).toContain("createSession: { off: '");
  });

  test('an entry the app already wrote is the app’s; a second run adds nothing', () => {
    const own = "x = defineExercise({\n  createSession: { off: 'mine' },\n});\n";
    const once = exerciseWithEntries(own, signInExerciseEntries(WRITTEN));
    expect(once).toContain("createSession: { off: 'mine' }");
    expect(once.match(/createSession:/g)?.length).toBe(1);
    expect(exerciseWithEntries(once, signInExerciseEntries(WRITTEN))).toBe(once);
  });

  test('a file in a shape the generator cannot read is left as it is', () => {
    const other = 'export const exercise = makeMine();\n';
    expect(exerciseWithEntries(other, signInExerciseEntries(WRITTEN))).toBe(other);
  });
});
