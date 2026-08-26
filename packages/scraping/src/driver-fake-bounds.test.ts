// `fakePage({ timeoutMs })` is the default deadline for every wait on that page, so it is the same
// bound `scrape-run.ts` derives from `pageTimeout:` — one level down, and reachable from a test
// helper rather than from a definition. A non-finite one makes `expired()` false forever, so the
// poll loop under it never leaves; the screen is at the option so the refusal names what the
// caller wrote rather than the budget it became.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, renderThrowable } from '@ultimat3/core';
import { fakePage } from './driver-fake';

const NOT_A_BOUND: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

function refusal(run: () => unknown): { code: string; cause: string } {
  try {
    run();
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: error.cause };
    return expect.unreachable(`expected a coded refusal, got ${renderThrowable(error)}`);
  }
  return expect.unreachable('a page timeout that is not a number was accepted');
}

describe('unit · the fake page, bounded', () => {
  for (const value of NOT_A_BOUND) {
    test(`a timeoutMs of ${String(value)} is refused when the page is built`, () => {
      const error = refusal(() => fakePage('<p>hi</p>', { timeoutMs: value }));
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('timeoutMs');
    });
  }

  // A SESSION default of 0 is not the same claim as a per-call `waitFor({ timeout: 0 })`, which is
  // a legitimate "is it there right now": it makes every wait AND every navigation on the page
  // already out of time. The floor is 1 here and 0 on the per-call budget for that reason.
  test('a timeoutMs of 0 is refused, while one look per call stays reachable', async () => {
    expect(refusal(() => fakePage('<p>hi</p>', { timeoutMs: 0 })).cause).toContain('timeoutMs');
    const page = fakePage('<p id="here">hi</p>', { timeoutMs: 1 });
    // `state: 'visible'` because 'actionable' asks for STABILITY, which is two agreeing looks by
    // definition and so can never be satisfied by one — a property of the state, not of the budget.
    expect((await page.waitFor('#here', { timeout: 0, state: 'visible' })).text).toBe('hi');
  });

  test('the default is unchanged and the page still works', async () => {
    const page = fakePage('<p id="here">hi</p>');
    expect(await page.text('#here')).toBe('hi');
  });
});
