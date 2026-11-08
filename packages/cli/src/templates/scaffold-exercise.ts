// `apps/web/exercise.ts`: the app's overrides for `x exercise`, empty. Written by `x new` so the
// file every `X_CONTRACT_EXERCISE_UNREACHED` fix names exists before the first line is pasted in.

import type { GeneratedFile } from './naming';

const exercise =
  (): string => `// What \`x exercise\` cannot guess about this app: an input a primitive needs bound to a real
// row, an actor its policy permits, or a primitive that must not run in the pass and why. Empty
// runs every action, query and job as generated. \`x exercise --json\` prints the entry to paste
// for each one it could not reach. A contract test reads the same entry:
// \`target.contract({ exercise })\`, handed this file's export.
import { defineExercise } from '@ultimat3/testing';

export const exercise = defineExercise({});
`;

// The import IS the check: `defineExercise` refuses a blank `off` as the module loads, so a reason
// deleted from an entry fails `bun test` here, before the gate's `exercise` step runs at all.
const exerciseTest =
  (): string => `// The overrides load, and every primitive they turn off says why.
import { expect, unitTest } from '@ultimat3/testing';
import { exercise } from './exercise';

unitTest('apps/web/exercise.ts loads, and every off entry names its reason', () => {
  for (const [name, entry] of exercise.entries) {
    if ('off' in entry) {
      expect({ name, blank: entry.off.trim() === '' }).toEqual({ name, blank: false });
    }
  }
  expect(exercise.entries).toBeInstanceOf(Map);
});
`;

/** Written by `x new`, with or without the example slice: the gate's `exercise` step reads it. */
export const exerciseFiles = (): readonly GeneratedFile[] => [
  { path: 'apps/web/exercise.ts', contents: exercise() },
  { path: 'apps/web/exercise.test.ts', contents: exerciseTest() },
];
