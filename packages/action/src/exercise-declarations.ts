/**
 * One declaration of a primitive's exercise: the app's `defineExercise()` value (apps/web/exercise.ts,
 * the file `x exercise` reads), handed whole to `.contract({ exercise })`, resolved here by the
 * primitive's own name. Structural, so `@ultimat3/testing`'s value satisfies it without an import up.
 */

import type { ExerciseOptions } from './exercise';

export type { ExerciseOptions };

/** The one file an app declares its exercise in — every refusal's fix names it. */
export const EXERCISE_DECLARATIONS_FILE = 'apps/web/exercise.ts';

/** `defineExercise()`'s value, as far as a contract reads it: the entries, by primitive name. */
export interface ExerciseDeclarations {
  readonly kind: 'exercise-overrides';
  readonly entries: ReadonlyMap<string, ExerciseOptions>;
}

/** What `.contract({ exercise })` takes: the app's declarations, or one entry inline. */
export type ContractExercise = ExerciseOptions | ExerciseDeclarations;

export const isExerciseDeclarations = (value: ContractExercise): value is ExerciseDeclarations =>
  'kind' in value && value.kind === 'exercise-overrides';

/** The entry `name` reads: the declarations' own, or the inline one. `undefined` when none. */
export function resolveExercise(
  name: string,
  exercise: ContractExercise | undefined,
): ExerciseOptions | undefined {
  if (exercise === undefined || !isExerciseDeclarations(exercise)) return exercise;
  return exercise.entries.get(name);
}
