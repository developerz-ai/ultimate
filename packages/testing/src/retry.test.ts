// A retrying assertion is only worth having if it demonstrably STOPS. These tests inject the sleep
// and count the observations, so every one of them asserts how many times it looked and when it
// gave up — never that it happened to pass.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { attemptsFor, DEFAULT_RETRY_BUDGET, retryUntil } from './retry';

/** Answers `false` until the Nth observation, then `true`. Observation-driven, never time-driven. */
const flipsOn = (nth: number): { observe: () => Promise<boolean>; seen: () => number } => {
  let seen = 0;
  return {
    observe: async () => {
      seen += 1;
      return seen >= nth;
    },
    seen: () => seen,
  };
};

const counter = (): { sleep: () => Promise<void>; slept: () => number } => {
  let slept = 0;
  return {
    sleep: async () => {
      slept += 1;
    },
    slept: () => slept,
  };
};

const isTrue = (value: boolean): boolean => value;

describe('attemptsFor', () => {
  test('is one free look plus one per interval in the budget', () => {
    expect(attemptsFor({ timeout: 5000, interval: 100 })).toBe(51);
    expect(attemptsFor({ timeout: 300, interval: 100 })).toBe(4);
    // An interval wider than the whole budget still buys the first look — the assertion is asked
    // once, which is what a non-retrying matcher would have done.
    expect(attemptsFor({ timeout: 50, interval: 100 })).toBe(1);
    expect(attemptsFor({ timeout: 0, interval: 100 })).toBe(1);
  });
});

describe('retryUntil', () => {
  test('does not sleep at all when the first look already matches', async () => {
    const subject = flipsOn(1);
    const clock = counter();
    const outcome = await retryUntil(subject.observe, isTrue, DEFAULT_RETRY_BUDGET, clock.sleep);
    expect(outcome.matched).toBe(true);
    expect(outcome.attempts).toBe(1);
    expect(subject.seen()).toBe(1);
    expect(clock.slept()).toBe(0);
  });

  test('stops on the observation that matches, and sleeps once between each pair', async () => {
    const subject = flipsOn(4);
    const clock = counter();
    const outcome = await retryUntil(subject.observe, isTrue, DEFAULT_RETRY_BUDGET, clock.sleep);
    expect(outcome.matched).toBe(true);
    expect(outcome.attempts).toBe(4);
    expect(subject.seen()).toBe(4);
    // Three gaps between four looks — never a sleep after the one that answered.
    expect(clock.slept()).toBe(3);
  });

  test('gives up after exactly the budget, and says what it last saw', async () => {
    const budget = { timeout: 300, interval: 100 };
    const subject = flipsOn(999);
    const clock = counter();
    const outcome = await retryUntil(subject.observe, isTrue, budget, clock.sleep);
    expect(outcome.matched).toBe(false);
    expect(outcome.attempts).toBe(attemptsFor(budget));
    expect(subject.seen()).toBe(4);
    expect(clock.slept()).toBe(3);
    expect(outcome.last).toBe(false);
  });

  test('carries the last value out, so a failure can report what it saw instead', async () => {
    let seen = 0;
    const outcome = await retryUntil(
      async () => {
        seen += 1;
        return `state-${seen}`;
      },
      (value) => value === 'never',
      { timeout: 200, interval: 100 },
      async () => undefined,
    );
    expect(outcome.matched).toBe(false);
    expect(outcome.last).toBe('state-3');
  });

  test('refuses a budget it could not stop on', async () => {
    const bad = [
      { timeout: 100, interval: 0 },
      { timeout: 100, interval: -1 },
      { timeout: -1, interval: 100 },
    ];
    for (const budget of bad) {
      let failure: unknown;
      try {
        await retryUntil(
          async () => true,
          isTrue,
          budget,
          async () => undefined,
        );
      } catch (error) {
        failure = error;
      }
      // A zero interval is an unbounded spin, which is the one failure mode a retry helper must
      // not have: the test never fails, it hangs, and CI reports a timeout with no assertion in it.
      expect(failure, JSON.stringify(budget)).toBeInstanceOf(UltimateError);
    }
  });
});
