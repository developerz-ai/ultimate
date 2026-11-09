// A `runs` outside 1..EXERCISE_RUNS_MAX is refused before the first draw, and the fix is the entry
// in its one home — `apps/web/exercise.ts`, read by the contract step and `x exercise` alike.

import { expect, test } from 'bun:test';
import { isUltimateError } from './errors';
import { EXERCISE_RUNS, EXERCISE_RUNS_MAX, runExercise } from './exercise-run';

test('an out-of-range runs names the defineExercise entry to fix', async () => {
  const refusal = await runExercise({
    name: 'publishNote',
    runs: EXERCISE_RUNS_MAX + 1,
    env: { NODE_ENV: 'test' },
    stoppedLabel: 'stopped',
    draw: () => ({}),
    accepts: async () => true,
    attempt: async () => ({ ok: true, reached: true }),
    statusOf: () => 500,
  }).catch((error: unknown) => error);
  if (!isUltimateError(refusal)) return expect.unreachable('runExercise accepted the runs');
  expect(refusal.fix).toBe(
    `defineExercise({ publishNote: { actor, runs: ${EXERCISE_RUNS} } })   # in apps/web/exercise.ts — runs is 1 to ${EXERCISE_RUNS_MAX}`,
  );
});
