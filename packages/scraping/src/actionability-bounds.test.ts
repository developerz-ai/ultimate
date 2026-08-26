/**
 * What the poll loop does when its own budget is not a number, in its own file because that is one
 * question and `actionability.test.ts` is about what "ready" means.
 *
 * Nothing here asserts on a wait that succeeds. Every test is about a loop that must NOT start: a
 * `NaN` deadline makes `expired()` false forever and a `NaN` interval makes `setTimeout(fn, NaN)`
 * a `setTimeout(fn, 0)`, so between them the repaired code's alternative is an unbounded loop
 * re-reading a real browser once per event-loop turn.
 */

import { describe, expect, test } from 'bun:test';
import { isUltimateError, renderThrowable } from '@ultimat3/core';
import { awaitActionable } from './actionability';
import { testClock } from './clock';
import type { ElementSnapshot } from './target';

/** The three values a `??` default never fires for, and that `Math.min` propagates rather than screens. */
const NOT_A_BOUND: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

const element = (over: Partial<ElementSnapshot> = {}): ElementSnapshot => ({
  tag: 'button',
  attrs: {},
  text: 'Go',
  value: '',
  visible: true,
  enabled: true,
  ...over,
});

/**
 * The refusal the wait made, or the assertion that it made none.
 *
 * `renderThrowable` and never `String(error)`: this line only runs where an expectation has already
 * gone wrong, and `String` throws on a null-prototype object, so it would replace the report of the
 * real failure with a second one naming nothing.
 */
async function refusal(run: () => Promise<unknown>): Promise<{ code: string; cause: string }> {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: error.cause };
    return expect.unreachable(`expected a coded refusal, got ${renderThrowable(error)}`);
  }
  return expect.unreachable('a wait budget that is not a number was accepted');
}

/**
 * A page whose element becomes ready on the `readyOn`th look, counting every look.
 *
 * The count is what makes an unbounded loop VISIBLE without hanging the suite: an unscreened
 * budget never expires, so the loop runs until this fixture lets it succeed and the test then
 * fails on "a wait budget that is not a number was accepted" instead of on a runner timeout.
 */
const eventually = (
  readyOn: number,
): { snapshot: () => Promise<ElementSnapshot | undefined>; looks: () => number } => {
  let looks = 0;
  return {
    looks: () => looks,
    snapshot: () => {
      looks += 1;
      return Promise.resolve(element({ visible: looks >= readyOn }));
    },
  };
};

describe('unit · a wait budget that is not a number', () => {
  for (const value of NOT_A_BOUND) {
    test(`timeoutMs of ${String(value)} is refused before the first look`, async () => {
      const page = eventually(3);
      const error = await refusal(() =>
        awaitActionable({
          selector: '#submit',
          url: 'https://shop.test/',
          state: 'visible',
          timeoutMs: value,
          clock: testClock(),
          snapshot: page.snapshot,
        }),
      );
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('timeoutMs');
      // Before the first look, not after some of them: a budget this wrong is the caller's bug and
      // reading a real browser once to find that out is a round trip nobody asked for.
      expect(page.looks()).toBe(0);
    });
  }

  for (const value of NOT_A_BOUND) {
    test(`pollMs of ${String(value)} is refused rather than spun on`, async () => {
      const page = eventually(3);
      const error = await refusal(() =>
        awaitActionable({
          selector: '#submit',
          url: 'https://shop.test/',
          state: 'visible',
          timeoutMs: 5_000,
          pollMs: value,
          clock: testClock(),
          snapshot: page.snapshot,
        }),
      );
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('pollMs');
      expect(page.looks()).toBe(0);
    });
  }

  // The floor, and it is a claim rather than a habit: `Math.min(0, remaining)` is 0, so a zero
  // interval sleeps zero and the poll becomes one full round trip to the browser per event-loop
  // turn — the same unbounded spin `packages/testing/src/retry.ts` refuses for its own interval.
  test('a pollMs of 0 is an unbounded spin, not a fast poll, and is refused', async () => {
    const page = eventually(3);
    const error = await refusal(() =>
      awaitActionable({
        selector: '#submit',
        url: 'https://shop.test/',
        state: 'visible',
        timeoutMs: 5_000,
        pollMs: 0,
        clock: testClock(),
        snapshot: page.snapshot,
      }),
    );
    expect(error.code).toBe('X_INVARIANT');
    expect(error.cause).toContain('pollMs');
  });

  // The other side of that floor: 1ms is the smallest interval that sleeps at all, and it must
  // still be a wait a caller can ask for.
  test('a pollMs of 1 is accepted and the wait completes', async () => {
    const page = eventually(3);
    const found = await awaitActionable({
      selector: '#submit',
      url: 'https://shop.test/',
      state: 'visible',
      timeoutMs: 5_000,
      pollMs: 1,
      clock: testClock(),
      snapshot: page.snapshot,
    });
    expect(found.visible).toBe(true);
    expect(page.looks()).toBe(3);
  });

  // A zero timeout is one look and no wait, which is a caller's legitimate "is it there now" —
  // refusing it would make this screen a behaviour change rather than a screen.
  test('a timeoutMs of 0 is one look, and is not refused', async () => {
    const page = eventually(99);
    const error = await refusal(() =>
      awaitActionable({
        selector: '#submit',
        url: 'https://shop.test/',
        state: 'visible',
        timeoutMs: 0,
        clock: testClock(),
        snapshot: page.snapshot,
      }),
    );
    expect(error.code).toBe('X_SCRAPE_NOT_ACTIONABLE');
    expect(page.looks()).toBe(1);
  });
});
