// How much slower this machine runs than the one a test's declared deadline was measured on.
// `x verify` measures it (`packages/cli/src/verify-pace.ts`) and hands it to every test run it
// starts as `ULTIMATE_TEST_PACE`; a test's own timeout is read at that pace, so a 2-core 1.8 GHz
// box is held to the same bound a CI runner is instead of failing on a number set for the runner.

import { UltimateError } from '@ultimat3/core';

/** Set by `x verify` on each test run it starts. Absent — a hand-run `bun test` — is pace 1. */
export const TEST_PACE_ENV = 'ULTIMATE_TEST_PACE';

/** A pace that does not parse, or one below 1: a machine is never read as faster than the bound. */
export class TestPaceInvalidError extends UltimateError {
  constructor(value: string) {
    super({
      code: 'X_TEST_PACE_INVALID',
      cause: `${TEST_PACE_ENV}=${JSON.stringify(value)} is not a number at or above 1`,
      fix: `unset ${TEST_PACE_ENV}   # x verify measures and sets it; a hand-run bun test reads its absence as 1`,
    });
  }
}

/** The pace this process was started at. */
export function testPace(env: Readonly<Record<string, string | undefined>> = Bun.env): number {
  const raw = env[TEST_PACE_ENV];
  if (raw === undefined || raw.trim() === '') return 1;
  const pace = Number(raw);
  if (!Number.isFinite(pace) || pace < 1) throw new TestPaceInvalidError(raw);
  return pace;
}

/**
 * A declared test deadline at this machine's pace: `test(name, body, paced(90_000))`. The number
 * stays the one measured on a fast machine; only a slower one stretches it.
 */
export const paced = (ms: number, env?: Readonly<Record<string, string | undefined>>): number =>
  Math.round(ms * testPace(env));
