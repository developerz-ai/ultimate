// Which seed `x exercise` runs on. One constant unless told otherwise: row ids follow the seed and
// an app's helpers can pick rows by id, so a drawn seed made one tree's gate verdict change run to
// run. Every pass has a scratch database of its own, so repeating a seed collides with nothing.

import { DEFAULT_SEED } from '@ultimat3/testing';
import type { IntFlag } from './flag-number';
import { parseIntFlag } from './flag-number';
import type { ParsedArgs } from './parse';
import { flagString } from './parse';

/** The largest `--seed`: a drawn seed stays under it, so the report's figure always replays. */
export const EXERCISE_SEED_MAX = 2_147_483_647;

/** `--seed random`: explore a seed the gate never runs, named in the report for its replay. */
export const RANDOM_EXERCISE_SEED = 'random';

const SEED_FLAG: IntFlag = {
  name: 'seed',
  command: 'exercise',
  min: 0,
  max: EXERCISE_SEED_MAX,
  example: 'x exercise --seed 1 --json',
};

// Not `Math.random`: the frozen RNG answers the same sequence in every process.
const drawSeed = (): number =>
  (crypto.getRandomValues(new Uint32Array(1))[0] as number) & EXERCISE_SEED_MAX;

/** `--seed n`, `--seed random`, or the constant. `X_CLI_BAD_FLAG` on anything else. */
export function readExerciseSeed(args: ParsedArgs, draw: () => number = drawSeed): number {
  const raw = flagString(args, SEED_FLAG.name);
  if (raw === undefined) return DEFAULT_SEED;
  return raw === RANDOM_EXERCISE_SEED ? draw() : parseIntFlag(raw, SEED_FLAG);
}
