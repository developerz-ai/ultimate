// `x new` writes `apps/web/exercise.ts`: one `defineExercise()` export, empty, so `x exercise` has
// the file its fixes name before anyone pastes a line into it.

import { describe, expect, test } from 'bun:test';
import { EXERCISE_FILE } from '../exercise-findings';
import { names } from './naming';
import { appFiles } from './scaffold-app';
import { exerciseFiles } from './scaffold-exercise';

describe('unit · the scaffold exercise file', () => {
  test('is written at the path every unreached finding names, with one defineExercise export', () => {
    const [file] = exerciseFiles();
    expect(file?.path).toBe(EXERCISE_FILE);
    const text = String(file?.contents);
    expect(text).toContain("import { defineExercise } from '@ultimat3/testing';");
    expect(text.match(/export const \w+ = defineExercise\(/g)).toHaveLength(1);
  });

  test('both scaffold shapes carry it', () => {
    for (const example of [true, false]) {
      const paths = appFiles(names('demoapp'), example).map((one) => one.path);
      expect(paths).toContain(EXERCISE_FILE);
    }
  });
});
