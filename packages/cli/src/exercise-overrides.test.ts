// Reading `apps/web/exercise.ts`: absent is no overrides, one `defineExercise()` export is the
// overrides, and none or two is a refusal — never a silent pick.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory or recursive-remove native; each case is a fresh tree.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { isUltimateError } from '@ultimat3/core';
import { EXERCISE_FILE } from './exercise-findings';
import { readExerciseOverrides } from './exercise-overrides';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The value `defineExercise()` returns, written literally: the reader keys on its `kind`. */
const OVERRIDES =
  "{ kind: 'exercise-overrides', entries: new Map([['publishPost', { off: 'x' }]]) }";

const app = async (source?: string): Promise<string> => {
  const root = mkdtempSync(join(tmpdir(), 'exercise-overrides-'));
  dirs.push(root);
  if (source !== undefined) await Bun.write(join(root, EXERCISE_FILE), source);
  return root;
};

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not an UltimateError';
  }
  return 'no refusal';
};

describe('unit · apps/web/exercise.ts', () => {
  test('no file is no overrides', async () => {
    expect(await readExerciseOverrides(await app())).toBeUndefined();
  });

  test('one defineExercise export is the overrides, whatever it is called', async () => {
    const root = await app(`export const mine = ${OVERRIDES};\nexport const other = 1;\n`);
    const read = await readExerciseOverrides(root);
    expect([...(read?.entries.keys() ?? [])]).toEqual(['publishPost']);
  });

  test('a file with no such export is refused, not read as empty', async () => {
    const root = await app('export const exercise = {};\n');
    expect(await codeOf(() => readExerciseOverrides(root))).toBe('X_CONTRACT_EXERCISE_UNDECLARED');
  });

  test('two exports are refused: two answers to one question', async () => {
    const root = await app(`export const a = ${OVERRIDES};\nexport const b = ${OVERRIDES};\n`);
    expect(await codeOf(() => readExerciseOverrides(root))).toBe('X_CONTRACT_EXERCISE_UNDECLARED');
  });
});
