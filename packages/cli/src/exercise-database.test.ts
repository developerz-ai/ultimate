// The environment `x exercise` runs as: always test, whatever local one is named, and a deploy
// refused before any database is opened.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import {
  captureDeterminism,
  DEFAULT_NOW,
  isDeterminismInstalled,
  restoreCapturedDeterminism,
  restoreDeterminism,
} from '@ultimat3/testing';
import { exerciseEnvironment, withExerciseProcess } from './exercise-database';

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

describe('unit · the exercise clock', () => {
  // PGlite's Postgres arms its timers off `Date.now()`. Booted on the real clock and then frozen
  // under, a 10 s timer armed at real-now is re-armed at (real-now − frozen-now): ~2^34 ms,
  // clamped to 1 ms by `setTimeout` — a TimeoutOverflowWarning busy loop for the whole pass.
  test('the clock is frozen before the work starts, and handed back as found', async () => {
    const outer = captureDeterminism();
    restoreDeterminism();
    try {
      const seen = await withExerciseProcess(import.meta.dir, {}, async () => ({
        installed: isDeterminismInstalled(),
        now: Date.now(),
      }));
      expect(seen).toEqual({ installed: true, now: new Date(DEFAULT_NOW).getTime() });
      expect(isDeterminismInstalled()).toBe(false);
    } finally {
      restoreCapturedDeterminism(outer);
    }
  });
});
