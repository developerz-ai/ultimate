// `toBeVisible` is the one matcher in this package that WAITS, so its tests are about waiting: how
// many times it looked, that it stopped, and that `.not` waits for the opposite rather than
// inverting a single look. The locator flips on the Nth OBSERVATION and never on a timer, so every
// count here is exact whatever the machine is doing.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import './matchers';
import type { LocatorLike } from './test-types';

/** Visible from the `nth` observation onward. `Number.POSITIVE_INFINITY` is never visible. */
const locatorVisibleFrom = (nth: number): LocatorLike & { looks(): number } => {
  let looks = 0;
  const self = {
    count: async () => 1,
    click: async () => undefined,
    first: () => self as LocatorLike,
    isVisible: async () => {
      looks += 1;
      return looks >= nth;
    },
    looks: () => looks,
  };
  return self;
};

/** Visible until the `nth` observation, then gone — what `.not.toBeVisible()` has to wait for. */
const locatorHiddenFrom = (nth: number): LocatorLike & { looks(): number } => {
  let looks = 0;
  const self = {
    count: async () => 1,
    click: async () => undefined,
    first: () => self as LocatorLike,
    isVisible: async () => {
      looks += 1;
      return looks < nth;
    },
    looks: () => looks,
  };
  return self;
};

/** A tight budget: four looks, a millisecond apart. The COUNT is what the assertions read. */
const FAST = { timeout: 3, interval: 1 };

const failure = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return expect.unreachable('the assertion passed where it had to fail');
};

describe('toBeVisible', () => {
  test('passes on the first look when the element is already there, and looks once', async () => {
    const locator = locatorVisibleFrom(1);
    await expect(locator).toBeVisible(FAST);
    expect(locator.looks()).toBe(1);
  });

  test('keeps looking until it appears — the whole reason it is not isVisible()', async () => {
    const locator = locatorVisibleFrom(3);
    await expect(locator).toBeVisible(FAST);
    expect(locator.looks()).toBe(3);
  });

  test('stops at the budget and says what it waited for and what it saw', async () => {
    const locator = locatorVisibleFrom(Number.POSITIVE_INFINITY);
    const message = await failure(() => expect(locator).toBeVisible(FAST));
    // Four looks: one free, plus one per whole interval in the budget.
    expect(locator.looks()).toBe(4);
    expect(message).toContain('to be visible');
    expect(message).toContain('3ms');
    expect(message).toContain('4 look');
    expect(message).toContain('hidden');
  });

  test('.not waits for it to GO, rather than inverting one look', async () => {
    const locator = locatorHiddenFrom(3);
    await expect(locator).not.toBeVisible(FAST);
    // Two looks would be a matcher that inverted a single answer; three is one that waited.
    expect(locator.looks()).toBe(3);
  });

  test('.not fails at the budget when it never goes, and says so in that direction', async () => {
    const locator = locatorVisibleFrom(1);
    const message = await failure(() => expect(locator).not.toBeVisible(FAST));
    expect(locator.looks()).toBe(4);
    expect(message).toContain('to stop being visible');
    expect(message).toContain('visible every time');
  });

  test('a budget bigger than the default is honoured, and a smaller one too', async () => {
    const wide = locatorVisibleFrom(6);
    await expect(wide).toBeVisible({ timeout: 10, interval: 1 });
    expect(wide.looks()).toBe(6);

    const single = locatorVisibleFrom(Number.POSITIVE_INFINITY);
    await failure(() => expect(single).toBeVisible({ timeout: 0, interval: 1 }));
    // `timeout: 0` is the non-retrying spelling, and it is the one the caller has to ask for.
    expect(single.looks()).toBe(1);
  });

  test('refuses a receiver that is not a locator, naming the call that is', async () => {
    let thrown: unknown;
    try {
      await expect({ hello: 'world' }).toBeVisible(FAST);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UltimateError);
    expect((thrown as UltimateError).code).toBe('X_TEST_LOCATOR_EXPECTED');
    expect((thrown as UltimateError).fix).toContain('page.getByRole');
  });
});
