// The runner's contract: a failure names its seed, the seed (and the draw) replay it exactly,
// the counterexample is shrunk to the boundary, and a promise or an unreadable option is refused.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { PropertyFailedError, property } from './property';
import { gen } from './property-gen';

/** The failure `fn` throws, or the test's verdict that it did not. */
const failureOf = (fn: () => void): PropertyFailedError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof PropertyFailedError) return error;
    throw error;
  }
  return expect.unreachable('the property held, and it should not have');
};

describe('property()', () => {
  test('a claim that holds passes every draw', () => {
    let calls = 0;
    property(
      gen.int(-50, 50),
      (n) => {
        calls += 1;
        expect(Math.abs(n)).toBeLessThanOrEqual(50);
      },
      { runs: 300 },
    );
    expect(calls).toBe(300);
  });

  test('a failure reports its seed, and that seed reproduces the same shrunk input', () => {
    const claim = (n: number): boolean => n < 1000;
    const first = failureOf(() => property(gen.int(0, 1_000_000), claim, { seed: 7 }));
    const again = failureOf(() => property(gen.int(0, 1_000_000), claim, { seed: 7 }));
    expect(first.code).toBe('X_TEST_PROPERTY_FAILED');
    expect(first.meta?.['seed']).toBe(7);
    expect(first.cause).toContain('seed 7');
    expect(again.input).toBe(first.input);
    expect(again.meta?.['run']).toBe(first.meta?.['run']);
  });

  test('the seed is what the draws come from: another seed, another sequence', () => {
    const drawn = (seed: number): readonly number[] => {
      const seen: number[] = [];
      property(
        gen.int(0, 1_000_000),
        (n) => {
          seen.push(n);
        },
        { seed, runs: 20 },
      );
      return seen;
    };
    expect(drawn(1)).toEqual(drawn(1));
    expect(drawn(1)).not.toEqual(drawn(2));
  });

  test('halving shrinks a number to the exact boundary', () => {
    const failure = failureOf(() => property(gen.int(0, 1_000_000), (n) => n < 1000));
    expect(failure.input).toBe(1000);
    // Halving, not counting down: a million-wide range shrinks in a few dozen steps.
    expect(failure.meta?.['shrinkSteps']).toBeLessThan(200);
  });

  test('a list shrinks to its shortest failing length with minimal items', () => {
    const failure = failureOf(() =>
      property(gen.array(gen.int(0, 100), { maxLength: 40 }), (xs) => xs.length < 3),
    );
    expect(failure.input).toEqual([0, 0, 0]);
  });

  test('a mapped generator shrinks through its source', () => {
    const failure = failureOf(() =>
      property(gen.string({ maxLength: 30 }), (text) => !text.includes(';')),
    );
    expect(failure.input).toBe(';');
  });

  test("the fix's options replay exactly the failing draw", () => {
    const claim = (xs: readonly number[]): boolean => xs.reduce((a, b) => a + b, 0) < 500;
    const failing = failureOf(() => property(gen.array(gen.int(0, 100)), claim, { seed: 99 }));
    const run = failing.meta?.['run'];
    if (typeof run !== 'number') return expect.unreachable('meta.run is not a number');
    expect(failing.fix).toContain(`{ seed: 99, runs: ${run} }`);
    const replayed = failureOf(() =>
      property(gen.array(gen.int(0, 100)), claim, { seed: 99, runs: run }),
    );
    expect(replayed.meta?.['run']).toBe(run);
    expect(replayed.input).toEqual(failing.input);
  });

  test('a throw is a failure, and its message is the reason', () => {
    const failure = failureOf(() =>
      property(gen.int(0, 10), (n) => {
        expect(n).toBeLessThan(5);
      }),
    );
    expect(failure.input).toBe(5);
    expect(failure.cause).toContain('toBeLessThan');
  });

  test('a property that returns a promise is refused, never passed', () => {
    let caught: unknown;
    try {
      property(gen.int(0, 10), async () => {});
    } catch (error) {
      caught = error;
    }
    expect(isUltimateError(caught) && caught.code).toBe('X_TEST_PROPERTY_FAILED');
    expect(caught).not.toBeInstanceOf(PropertyFailedError);
  });

  test('an unreadable runs or seed is refused, not a loop that never runs', () => {
    expect(() => property(gen.int(0, 1), () => true, { runs: Number.NaN })).toThrow(/runs/);
    expect(() => property(gen.int(0, 1), () => true, { seed: 1.5 })).toThrow(/seed/);
  });

  test('an unreadable length is refused, not a list whose bound does not exist', () => {
    const nan = gen.array(gen.int(0, 1), { maxLength: Number.NaN });
    expect(() => property(nan, () => true, { runs: 1 })).toThrow(/maxLength/);
    const half = gen.string({ minLength: 0.5 });
    expect(() => property(half, () => true, { runs: 1 })).toThrow(/minLength/);
  });
});
