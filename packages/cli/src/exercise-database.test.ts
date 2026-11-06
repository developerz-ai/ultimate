// The environment `x exercise` runs as: always test, whatever local one is named, and a deploy
// refused before any database is opened.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { exerciseEnvironment } from './exercise-database';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not an UltimateError';
  }
  return 'no refusal';
};

describe('unit · the exercise environment', () => {
  // An app picks its store from this at module load: as `development`, social's embedded memory
  // store would read none of the rows the pass seeds into the scratch database.
  test('a local environment, named or not, runs the pass as test', () => {
    expect(exerciseEnvironment({})).toBe('test');
    expect(exerciseEnvironment({ ULTIMATE_ENV: 'development' })).toBe('test');
    expect(exerciseEnvironment({ NODE_ENV: 'test' })).toBe('test');
  });

  test('a deploy is refused', () => {
    expect(codeOf(() => exerciseEnvironment({ ULTIMATE_ENV: 'production' }))).toBe(
      'X_CONTRACT_EXERCISE_ENVIRONMENT',
    );
    expect(codeOf(() => exerciseEnvironment({ NODE_ENV: 'staging' }))).toBe(
      'X_CONTRACT_EXERCISE_ENVIRONMENT',
    );
  });
});
