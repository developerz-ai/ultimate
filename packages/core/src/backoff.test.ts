import { describe, expect, test } from 'bun:test';
import { backoffDelay } from './backoff';

/** A seeded roll, so every number below is exact rather than a range. */
const roll = (value: number) => (): number => value;

describe('backoffDelay', () => {
  test('exponential with no jitter is base * factor ** (attempt - 1)', () => {
    const of = (attempt: number): number => backoffDelay({ attempt, base: 1_000, max: 3_600_000 });
    expect([of(1), of(2), of(3), of(4)]).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  test('linear is base * attempt and fixed is base', () => {
    const at = (curve: 'linear' | 'fixed', attempt: number): number =>
      backoffDelay({ attempt, base: 300, max: 3_600_000, curve });
    expect([at('linear', 1), at('linear', 3)]).toEqual([300, 900]);
    expect([at('fixed', 1), at('fixed', 5)]).toEqual([300, 300]);
  });

  test('clamps to max BEFORE jitter, so full jitter never exceeds the ceiling', () => {
    expect(backoffDelay({ attempt: 20, base: 1_000, max: 30_000 })).toBe(30_000);
    expect(
      backoffDelay({ attempt: 20, base: 1_000, max: 30_000, jitter: 'full', random: roll(1) }),
    ).toBe(30_000);
  });

  test('attempt below 1 is clamped to the first step', () => {
    expect(backoffDelay({ attempt: 0, base: 1_000, max: 30_000 })).toBe(1_000);
    expect(backoffDelay({ attempt: -5, base: 1_000, max: 30_000 })).toBe(1_000);
  });

  test('factor is honoured and defaults to 2', () => {
    expect(backoffDelay({ attempt: 3, base: 100, max: 1_000_000, factor: 3 })).toBe(900);
    expect(backoffDelay({ attempt: 3, base: 100, max: 1_000_000 })).toBe(400);
  });

  test('a negative base answers 0 rather than a negative delay', () => {
    expect(backoffDelay({ attempt: 2, base: -1_000, max: 1_000 })).toBe(0);
  });

  /**
   * Measured before the refusal landed, with `retry({ attempts: 5 })` counting its own sleeps:
   * `max: NaN` slept `[0, 0, 0, 0]` and `factor: NaN` slept `[1000, 0, 0, 0]` — a retry loop with
   * no wait at all, which is the failure backoff exists to prevent, on the tree's ONE curve.
   */
  test.each([
    ['base', { attempt: 2, base: Number.NaN, max: 1_000 }],
    ['max', { attempt: 2, base: 1_000, max: Number.NaN }],
    ['max', { attempt: 2, base: 1_000, max: Number.POSITIVE_INFINITY }],
    ['factor', { attempt: 2, base: 1_000, max: 30_000, factor: Number.NaN }],
    ['factor', { attempt: 2, base: 1_000, max: 30_000, factor: Number.POSITIVE_INFINITY }],
    ['attempt', { attempt: Number.NaN, base: 1_000, max: 30_000 }],
  ] as const)('refuses a non-finite %s, naming it in the fix', (option, options) => {
    try {
      backoffDelay(options);
      expect.unreachable('a non-finite bound is a delay of 0 on every attempt, not a schedule');
    } catch (error) {
      const rendered = String(error);
      expect(rendered).toContain('X_INVARIANT');
      expect(rendered).toContain(option);
      expect(rendered).toContain('backoffDelay');
    }
  });

  /** Still reachable with four finite inputs: `2 ** 1999` overflows and `0 * Infinity` is NaN. */
  test('a zero base whose curve overflows answers 0, not NaN', () => {
    expect(backoffDelay({ attempt: 2_000, base: 0, max: 30_000 })).toBe(0);
  });
});

/**
 * The three shipped formulas this one replaces. Each expectation is the number the ORIGINAL
 * produces, computed from its own source, so an edit here that changes any of them is a failing
 * test rather than a silent behaviour change in the package that adopts it.
 */
describe('backoffDelay reproduces the formula it replaces', () => {
  test("jobs' equal jitter — packages/jobs/src/retry.ts:40 backoffDelayMs", () => {
    // raw = 1000 * 2 ** (3 - 1) = 4000; capped = 4000; round(4000/2 + 4000/2 * 0.5) = 3000.
    expect(
      backoffDelay({
        attempt: 3,
        base: 1_000,
        max: 3_600_000,
        curve: 'exponential',
        jitter: 'equal',
        random: roll(0.5),
      }),
    ).toBe(3_000);
    // jitter off is the same `Math.round(capped)` its `retrySchedule()` prints.
    expect(backoffDelay({ attempt: 2, base: 1_000, max: 3_600_000, jitter: 'none' })).toBe(2_000);
  });

  test("ai's full jitter — packages/ai/src/gateway.ts:233 backoffMs", () => {
    // ceiling = min(500 * 2 ** (4 - 1), 8000) = 4000; 0.25 * 4000 = 1000.
    expect(
      backoffDelay({
        attempt: 4,
        base: 500,
        max: 8_000,
        jitter: 'full',
        random: roll(0.25),
      }),
    ).toBe(1_000);
  });

  test("realtime's factor-2 full jitter — packages/realtime/src/thundering-herd.ts:36", () => {
    // Its `attempt` is 0-BASED: attempt 2 there is attempt 3 here.
    // ceiling = min(30000, 500 * 2 ** 2) = 2000; round(0.5 * 2000) = 1000.
    expect(
      backoffDelay({
        attempt: 3,
        base: 500,
        max: 30_000,
        factor: 2,
        jitter: 'full',
        random: roll(0.5),
      }),
    ).toBe(1_000);
    // Its `none` mode, which is `Math.round(ceiling)`.
    expect(backoffDelay({ attempt: 1, base: 500, max: 30_000, jitter: 'none' })).toBe(500);
  });

  test('equal jitter keeps a floor of half the ceiling and full jitter does not', () => {
    const equal = backoffDelay({
      attempt: 3,
      base: 1_000,
      max: 60_000,
      jitter: 'equal',
      random: roll(0),
    });
    const full = backoffDelay({
      attempt: 3,
      base: 1_000,
      max: 60_000,
      jitter: 'full',
      random: roll(0),
    });
    expect(equal).toBe(2_000);
    expect(full).toBe(0);
  });
});
