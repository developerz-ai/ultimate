/**
 * One declaration of a read's exercise: the app's `defineExercise()` value (apps/web/exercise.ts,
 * the file `x exercise` reads), handed whole to `.contract({ exercise })`, resolved here by the
 * query's own name. Action's twin (`exercise-declarations.ts` there): a sideways import is refused.
 */

import type { QueryExerciseOptions } from './exercise';

export type { QueryExerciseOptions };

/** The one file an app declares its exercise in — every refusal's fix names it. */
export const QUERY_EXERCISE_DECLARATIONS_FILE = 'apps/web/exercise.ts';

/** `defineExercise()`'s value, as far as a contract reads it: the entries, by primitive name. */
export interface QueryExerciseDeclarations {
  readonly kind: 'exercise-overrides';
  readonly entries: ReadonlyMap<string, QueryExerciseOptions>;
}

/** What `.contract({ exercise })` takes: the app's declarations, or one entry inline. */
export type QueryContractExercise = QueryExerciseOptions | QueryExerciseDeclarations;

export const isQueryExerciseDeclarations = (
  value: QueryContractExercise,
): value is QueryExerciseDeclarations => 'kind' in value && value.kind === 'exercise-overrides';

/**
 * The entry `name` reads: the declarations' own, or the inline one. `undefined` when none. A
 * `'query:<name>'` key wins over the bare name — the one `x exercise` reads for a query whose
 * name another kind shares (`@ultimat3/testing`'s `overrideFor`; action's twin keeps the same rule).
 */
export function resolveQueryExercise(
  name: string,
  exercise: QueryContractExercise | undefined,
): QueryExerciseOptions | undefined {
  if (exercise === undefined || !isQueryExerciseDeclarations(exercise)) return exercise;
  return exercise.entries.get(`query:${name}`) ?? exercise.entries.get(name);
}
