// A generator's entries in `apps/web/exercise.ts`: what `x g sign-in` writes that the exercise pass
// cannot run as generated, each turned off with its reason, so the app's next `x verify` is green.
// An entry the app already declares is the app's and is never touched.

import { editExerciseFile } from './exercise-entry-edit';
import { exerciseFiles } from './templates/scaffold-exercise';

export const EXERCISE_FILE = 'apps/web/exercise.ts';

/**
 * The password sign-in's two actions the pass cannot drive, by the file that declares each. One line
 * each in the app's file, inside Biome's 100 columns: `login()` refuses the drawn address and password.
 */
const SIGN_IN_OFF: ReadonlyMap<string, readonly [string, string]> = new Map([
  [
    'apps/web/app/auth/actions/create-session.ts',
    ['createSession', 'needs a real password; the pass draws one no account holds'],
  ],
  [
    'apps/web/app/auth/actions/confirm-session.ts',
    ['confirmSession', 'answers the challenge createSession holds; the pass holds none'],
  ],
]);

/** The `off` entries the written files are owed, by primitive name. */
export const signInExerciseEntries = (
  written: readonly string[],
): readonly (readonly [string, string])[] =>
  written.flatMap((path) => {
    const entry = SIGN_IN_OFF.get(path);
    return entry === undefined ? [] : [entry];
  });

/**
 * `source` with each entry not already named in it inserted at the top of `defineExercise({ … })`;
 * `undefined` when there is no file, which starts from `x new`'s. A file the one editor
 * (`exercise-entry-edit.ts`) cannot read is the app's own shape and is left as it is.
 */
export function exerciseWithEntries(
  source: string | undefined,
  entries: readonly (readonly [string, string])[],
): string {
  const edit = editExerciseFile(
    source,
    entries.map(([name, why]) => ({ name, value: `{ off: ${singleQuoted(why)} }` })),
  );
  return edit.kind === 'refused'
    ? (source ?? String(exerciseFiles()[0]?.contents ?? ''))
    : edit.source;
}

/** A single-quoted TypeScript string literal, Biome's own quote style. */
const singleQuoted = (text: string): string =>
  `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
