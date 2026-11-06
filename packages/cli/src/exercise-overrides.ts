// `apps/web/exercise.ts`, read: the one `defineExercise()` export an app may declare, or none. A
// file with no such export, or with two, is refused — an override nobody reads is a silent skip,
// and two are two answers to one question.

// why: Bun ships no path joiner.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import type { ExerciseOverrides } from '@ultimat3/testing';
import { EXERCISE_FILE } from './exercise-findings';

const isOverrides = (value: unknown): value is ExerciseOverrides =>
  typeof value === 'object' &&
  value !== null &&
  (value as { readonly kind?: unknown }).kind === 'exercise-overrides';

/**
 * The file exists and declares no single `defineExercise()` export. `X_CONTRACT_EXERCISE_UNDECLARED`
 * — `@ultimat3/action`'s code for an exercise option that says nothing — because that is what a
 * file of overrides the pass cannot find is.
 */
export class ExerciseOverridesUnreadableError extends UltimateError {
  constructor(found: number) {
    super({
      code: 'X_CONTRACT_EXERCISE_UNDECLARED',
      cause: `${EXERCISE_FILE} exports ${found === 0 ? 'no' : String(found)} defineExercise() value${found === 1 ? '' : 's'}, so x exercise cannot tell which overrides to apply`,
      fix: `export const exercise = defineExercise({});   # one export in ${EXERCISE_FILE}, imported from @ultimat3/testing`,
    });
  }
}

/** The overrides, or `undefined` when the app has no `apps/web/exercise.ts`. */
export async function readExerciseOverrides(root: string): Promise<ExerciseOverrides | undefined> {
  const path = join(root, EXERCISE_FILE);
  if (!(await Bun.file(path).exists())) return undefined;
  const module = (await import(path)) as Record<string, unknown>;
  const found = Object.values(module).filter(isOverrides);
  const [only] = found;
  if (found.length !== 1 || only === undefined) {
    throw new ExerciseOverridesUnreadableError(found.length);
  }
  return only;
}
