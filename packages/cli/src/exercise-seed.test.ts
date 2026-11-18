// Which seed `x exercise` runs on: one constant unless told otherwise, because the gate's verdict
// must not change between two runs of the same code, and exploring is asked for by name.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { DEFAULT_SEED } from '@ultimat3/testing';
import { EXERCISE_SEED_MAX, readExerciseSeed } from './exercise-seed';
import type { FlagValue, ParsedArgs } from './parse';

const args = (seed?: string): ParsedArgs => ({
  command: 'exercise',
  subcommand: undefined,
  positionals: [],
  flags: new Map<string, FlagValue>(seed === undefined ? [] : [['seed', seed]]),
  json: true,
  help: false,
  passthrough: [],
});

describe('unit · readExerciseSeed', () => {
  test('no flag is the one constant seed, and draws nothing', () => {
    const never = (): number => expect.unreachable('no --seed never draws');
    expect(readExerciseSeed(args(), never)).toBe(DEFAULT_SEED);
  });

  test('a number is that seed, 0 and the maximum included', () => {
    expect(readExerciseSeed(args('0'))).toBe(0);
    expect(readExerciseSeed(args(String(EXERCISE_SEED_MAX)))).toBe(EXERCISE_SEED_MAX);
  });

  test('random is what the draw answers', () => {
    expect(readExerciseSeed(args('random'), () => 41)).toBe(41);
  });

  // A drawn seed the flag refuses could never be replayed: uint32 is twice the flag's range.
  test('a real draw is always a seed --seed accepts', () => {
    for (let i = 0; i < 200; i += 1) {
      const drawn = readExerciseSeed(args('random'));
      expect(readExerciseSeed(args(String(drawn)))).toBe(drawn);
    }
  });

  test.each(['-1', 'abc', '1.5', String(EXERCISE_SEED_MAX + 1)])('%s is refused', (raw) => {
    let code = 'accepted';
    try {
      readExerciseSeed(args(raw));
    } catch (error) {
      code = isUltimateError(error) ? error.code : 'uncoded';
    }
    expect(code).toBe('X_CLI_BAD_FLAG');
  });
});
