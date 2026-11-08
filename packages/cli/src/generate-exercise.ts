// `x g`'s half of the one exercise declaration: each written contract test's entry inserted into
// `apps/web/exercise.ts` (created from `x new`'s shape when the app has none), since the test reads
// it from there. A file the editor cannot read is `X_EXERCISE_FILE_UNEDITABLE`, the entry in its fix.

import { UltimateError } from '@ultimat3/core';
import type { ExerciseEntry } from './exercise-entry-edit';
import { editExerciseFile } from './exercise-entry-edit';
import { EXERCISE_FILE } from './exercise-registration';
import type { GenerateDisk } from './generate-disk';
import type { Finding } from './output';
import type { GeneratedFile } from './templates';

/** The entries the files this run WROTE carry — a skipped or conflicting file is owed none. */
export const writtenExercises = (
  files: readonly GeneratedFile[],
  written: readonly string[],
): readonly ExerciseEntry[] =>
  files.flatMap((file) =>
    'exercise' in file && file.exercise !== undefined && written.includes(file.path)
      ? [file.exercise]
      : [],
  );

/** One line of an entry: what the fix asks to paste, whitespace folded. */
const oneLine = (entry: ExerciseEntry): string =>
  `${entry.name}: ${entry.value.replace(/\s*\n\s*/g, ' ').replace(/, }/g, ' }')}`;

/** Inserts `entries` into the app's exercise file; answers the path when it changed, or a refusal. */
export async function declareGeneratedExercises(
  entries: readonly ExerciseEntry[],
  disk: GenerateDisk,
): Promise<{ readonly edited: readonly string[]; readonly findings: readonly Finding[] }> {
  if (entries.length === 0) return { edited: [], findings: [] };
  const before = await disk.read(EXERCISE_FILE);
  const edit = editExerciseFile(before, entries);
  if (edit.kind === 'refused') {
    return {
      edited: [],
      findings: [
        {
          code: 'X_EXERCISE_FILE_UNEDITABLE',
          cause: `${EXERCISE_FILE} ${edit.reason}, so x g could not declare ${entries.map((e) => e.name).join(', ')} there and its contract test reads no entry`,
          // The code to paste first: a fix is pasted from its first character.
          fix: `${entries.map(oneLine).join(', ')},   # paste inside export const exercise = defineExercise({ … }) in ${EXERCISE_FILE}`,
          at: EXERCISE_FILE,
        },
      ],
    };
  }
  if (edit.kind === 'unchanged' && before !== undefined) return { edited: [], findings: [] };
  await disk.write(EXERCISE_FILE, edit.source);
  return { edited: [EXERCISE_FILE], findings: [] };
}

/**
 * `x new`'s file set with every contract test's entry already in its `apps/web/exercise.ts` — the
 * scaffold writes both at once, so there is no disk to edit. The file is the template's own, so a
 * refusal is this package's defect and is thrown, never written.
 */
export function withDeclaredExercises(files: readonly GeneratedFile[]): readonly GeneratedFile[] {
  const entries = writtenExercises(
    files,
    files.map((file) => file.path),
  );
  const at = files.findIndex((file) => file.path === EXERCISE_FILE);
  const file = files[at];
  if (entries.length === 0 || file === undefined || typeof file.contents !== 'string') return files;
  const edit = editExerciseFile(file.contents, entries);
  if (edit.kind === 'refused') {
    throw new UltimateError({
      code: 'X_EXERCISE_FILE_UNEDITABLE',
      cause: `x new's own ${EXERCISE_FILE} ${edit.reason}, so its contract tests would read no entry`,
      fix: 'bun test packages/cli/src/generate-exercise.test.ts   # the scaffold template and the editor disagree',
    });
  }
  return files.map((one, index) => (index === at ? { ...one, contents: edit.source } : one));
}
