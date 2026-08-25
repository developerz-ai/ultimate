// The one assertion in this package that WAITS. Split from `matchers.ts` because everything about
// it is different from the others: it has a budget, it has a direction (`.not` waits for the
// element to go), and its message has to say what it waited for and what it saw instead.

import { TestLocatorExpectedError } from './errors';
import type { MatcherResult } from './matcher-result';
import { DEFAULT_RETRY_BUDGET, type RetryBudget, retryUntil } from './retry';

/** What a caller may narrow. Both halves default to `DEFAULT_RETRY_BUDGET`. */
export type VisibleOptions = Partial<RetryBudget>;

/**
 * Structural, and the ONE member it insists on is the one it calls. `LocatorLike` declares four,
 * but a matcher demanding all four would refuse a driver's element handle over members this
 * assertion never touches — and the receiver here is whatever a test passed to `expect()`.
 */
export interface VisibilityProbe {
  isVisible(): Promise<boolean>;
}

/**
 * SYNCHRONOUS, and that is the whole reason it is a function of its own.
 *
 * Measured against Bun 1.4.0: a matcher declared `async` that throws has its error replaced by
 * bun's own `Matcher \`x\` returned a promise that rejected` — the code, the cause and the fix are
 * all gone, and the reader is told nothing. A matcher that is NOT async and throws before it
 * returns a promise keeps the error intact. So the receiver check runs here, in the synchronous
 * prologue, and the waiting happens in the promise that follows it.
 */
export const assertVisibilityProbe = (received: unknown): VisibilityProbe => {
  const probe = received as { isVisible?: unknown };
  if (typeof received !== 'object' || received === null || typeof probe.isVisible !== 'function') {
    throw new TestLocatorExpectedError();
  }
  return received as VisibilityProbe;
};

/**
 * `pass` is the RAW fact — whether the element was visible on the last look — because `.not`
 * inverts it and a matcher that pre-inverted would report the wrong direction. What `isNot` decides
 * is what this WAITS FOR: `.not.toBeVisible()` must wait for the element to disappear, not check
 * once and invert. Inverting a single look is a no-op that passes on a page which has not painted
 * yet, which is the exact failure a retrying assertion exists to remove.
 */
export const visibilityResult = async (
  probe: VisibilityProbe,
  isNot: boolean,
  options: VisibleOptions = {},
): Promise<MatcherResult> => {
  const budget: RetryBudget = {
    timeout: options.timeout ?? DEFAULT_RETRY_BUDGET.timeout,
    interval: options.interval ?? DEFAULT_RETRY_BUDGET.interval,
  };
  const wanted = !isNot;
  const outcome = await retryUntil(
    () => probe.isVisible(),
    (visible) => visible === wanted,
    budget,
  );
  const looks = `${outcome.attempts} look${outcome.attempts === 1 ? '' : 's'}, ${budget.interval}ms apart`;
  // The BUDGET is reported, never an elapsed measurement: this package freezes `Date.now()`, so an
  // "after 4993ms" would be a number nothing in the process could have produced.
  const waited = `within ${budget.timeout}ms (${looks})`;
  const message = isNot
    ? `expected the locator to stop being visible ${waited}, and it was visible every time`
    : `expected the locator to be visible ${waited}, and it was hidden every time`;
  return { pass: outcome.last, message: () => message };
};
