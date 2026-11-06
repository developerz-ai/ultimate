// A generator's entries in `apps/web/exercise.ts`: what `x g sign-in` writes that the exercise pass
// cannot run as generated, each turned off with its reason, so the app's next `x verify` is green.
// An entry the app already declares is the app's and is never touched.

import { exerciseFiles } from './templates/scaffold-exercise';

export const EXERCISE_FILE = 'apps/web/exercise.ts';

/**
 * The password sign-in's two actions the pass cannot drive, by the file that declares each. One line
 * each in the app's file, inside Biome's 100 columns: `login()` refuses the drawn address and password.
 */
const SIGN_IN_OFF: Readonly<Record<string, readonly [string, string]>> = {
  'apps/web/app/auth/actions/create-session.ts': [
    'createSession',
    'needs a real password; the pass draws one no account holds',
  ],
  'apps/web/app/auth/actions/confirm-session.ts': [
    'confirmSession',
    'answers the challenge createSession holds; the pass holds none',
  ],
};

/** The `off` entries the written files are owed, by primitive name. */
export const signInExerciseEntries = (
  written: readonly string[],
): readonly (readonly [string, string])[] =>
  written.flatMap((path) => {
    const entry = SIGN_IN_OFF[path];
    return entry === undefined ? [] : [entry];
  });

const DEFINE = 'defineExercise({';

/**
 * `source` with each entry not already named in it inserted at the top of `defineExercise({ … })`;
 * `undefined` when there is no file, which starts from `x new`'s. A file with no `defineExercise({`
 * is the app's own shape and is left as it is.
 */
export function exerciseWithEntries(
  source: string | undefined,
  entries: readonly (readonly [string, string])[],
): string {
  const base = source ?? String(exerciseFiles()[0]?.contents ?? '');
  const at = base.indexOf(DEFINE);
  if (at === -1) return base;
  const missing = entries.filter(([name]) => !new RegExp(`\\b${name}\\s*:`).test(base));
  if (missing.length === 0) return base;
  const lines = missing.map(([name, why]) => `  ${name}: { off: ${singleQuoted(why)} },`);
  const after = at + DEFINE.length;
  // `defineExercise({})` — the scaffold's — opens onto its own close: the close gets its own line.
  const rest = base.slice(after);
  return `${base.slice(0, after)}\n${lines.join('\n')}${rest.startsWith('}') ? '\n' : ''}${rest}`;
}

/** A single-quoted TypeScript string literal, Biome's own quote style. */
const singleQuoted = (text: string): string =>
  `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
