// The one helper every numeric-bound test in this package asserts through: run it, and hand back
// the coded refusal or say what arrived instead. Shared rather than copied into a dozen suites,
// the same call `llm-fixture.ts` makes — and the reason is `expect.unreachable`: a test that
// reports its own verdict by throwing a bare `Error` is what `scripts/test-bare-error.ts` refuses,
// so getting that one line right in one place beats getting it right twelve times.
//
// Not shipped — `package.json` excludes `!src/**/*-fixture.ts`.

import { expect } from 'bun:test';
import type { UltimateError } from '@ultimat3/core';
import { isUltimateError, renderThrowable } from '@ultimat3/core';

/**
 * The refusal `run` made, or the assertion that it made none.
 *
 * `renderThrowable`, never `String(error)`: this line runs where an expectation has ALREADY gone
 * wrong, and `String` is not total — it throws on a null-prototype object, on a throwing
 * `toString` and on a `Proxy` whose `get` traps, replacing the report of the real failure with a
 * second one naming nothing.
 */
export function refusal(run: () => unknown): UltimateError {
  try {
    run();
  } catch (error) {
    if (isUltimateError(error)) return error;
    return expect.unreachable(`expected a coded refusal, got ${renderThrowable(error)}`);
  }
  return expect.unreachable('a bound that is not a number was accepted');
}

/** The same, for a bound only reachable through a call that returns a promise. */
// `unknown` rather than `Promise<unknown>`: `Scorer.score` is declared `Promise<number> | number`,
// so a sync scorer is a legal subject and `await` on a non-promise is a no-op. A narrower parameter
// would make the fixture refuse the very shape it exists to test.
export async function asyncRefusal(run: () => unknown): Promise<UltimateError> {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return error;
    return expect.unreachable(`expected a coded refusal, got ${renderThrowable(error)}`);
  }
  return expect.unreachable('a bound that is not a number was accepted');
}

/** The three values a `??` default never fires for, and that no clamp screens either. */
export const NOT_A_BOUND: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];
