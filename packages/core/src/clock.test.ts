// The framework's one clock: `now`, `monotonic` and `sleep`, frozen for tests, and the ambient slot
// every package that waits reads. A sleep that ignores its signal leaves a killed run still counting;
// a frozen sleep that does not advance turns a 30-second deadline test into a hang.

import { describe, expect, test } from 'bun:test';
import { installClock } from './adapter';
import { frozenClock, liveClock, type SleepClock, systemClock as wallClock } from './clock';
import { ctxOf } from './context';
import { isUltimateError } from './errors';
import { ambientClock, noWaitClock, systemClock } from './sleep-clock';

describe('systemClock.sleep', () => {
  test('resolves after the wait', async () => {
    const started = performance.now();
    await systemClock.sleep(5);
    expect(performance.now() - started).toBeGreaterThanOrEqual(4);
  });

  test('rejects with the signal reason verbatim the moment it aborts', async () => {
    const controller = new AbortController();
    const reason = { code: 'X_PROBE' };
    const started = performance.now();
    const waiting = systemClock.sleep(60_000, controller.signal);
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('an already-aborted signal never waits', async () => {
    const reason = { code: 'X_PROBE' };
    await expect(systemClock.sleep(60_000, AbortSignal.abort(reason))).rejects.toBe(reason);
  });

  // One rule for every `SleepClock`: `frozenClock` refuses a wait that is no number of
  // milliseconds, so the system clock must too — `setTimeout(fn, NaN)` fires at once, and a retry
  // loop handed a broken delay would spin instead of failing.
  test('a non-finite wait is refused as frozenClock refuses it, never a zero-length timer', async () => {
    for (const ms of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const system = await systemClock.sleep(ms).then(
        () => 'resolved',
        (error: unknown) => (isUltimateError(error) ? error.code : 'other'),
      );
      const frozen = await frozenClock(0)
        .sleep(ms)
        .then(
          () => 'resolved',
          (error: unknown) => (isUltimateError(error) ? error.code : 'other'),
        );
      expect([ms, system]).toEqual([ms, frozen]);
      expect([ms, system]).toEqual([ms, 'X_INVARIANT']);
    }
  });

  test('a negative wait is a zero-length wait, on both clocks', async () => {
    await expect(systemClock.sleep(-5)).resolves.toBeUndefined();
    await expect(frozenClock(0).sleep(-5)).resolves.toBeUndefined();
  });
});

describe('frozenClock', () => {
  test('sleeping is advancing: thirty seconds pass on the next microtask', async () => {
    const clock = frozenClock('2026-11-09T00:00:00Z');
    await clock.sleep(30_000);
    expect(clock.now().toISOString()).toBe('2026-11-09T00:00:30.000Z');
    expect(clock.monotonic()).toBe(30_000);
  });

  test('an aborted sleep passes no time', async () => {
    const clock = frozenClock(0);
    await expect(clock.sleep(1_000, AbortSignal.abort('stop'))).rejects.toBe('stop');
    expect(clock.monotonic()).toBe(0);
  });

  test('a sleep that is not a finite count is refused, never a poisoned instant', async () => {
    const clock = frozenClock(0);
    await expect(clock.sleep(Number.NaN)).rejects.toThrow(/frozenClock.sleep ms is NaN/);
    expect(clock.now().getTime()).toBe(0);
  });
});

describe('noWaitClock', () => {
  test('real time, one turn of the loop per sleep whatever was asked', async () => {
    const started = performance.now();
    await noWaitClock.sleep(60_000);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(Math.abs(noWaitClock.now().getTime() - Date.now())).toBeLessThan(1_000);
  });

  test('a non-finite wait is refused, as every SleepClock refuses it', async () => {
    const answer = await noWaitClock.sleep(Number.NaN).then(
      () => 'resolved',
      (error: unknown) => (isUltimateError(error) ? error.code : 'other'),
    );
    expect(answer).toBe('X_INVARIANT');
  });
});

describe('the page clock', () => {
  test('carries no sleep — the browser graph never pays for a timer it does not arm', () => {
    expect('sleep' in wallClock).toBe(false);
    expect(Math.abs(systemClock.now().getTime() - wallClock.now().getTime())).toBeLessThan(1_000);
  });
});

describe('ambientClock', () => {
  test('is the system clock until one is installed', () => {
    expect(ambientClock()).toBe(systemClock);
  });

  test('installClock swaps it; each release restores what was in force before it', () => {
    const frozen: SleepClock = frozenClock(0);
    const releaseFrozen = installClock(frozen);
    expect(ambientClock()).toBe(frozen);
    const releaseNoWait = installClock(noWaitClock);
    expect(ambientClock()).toBe(noWaitClock);
    releaseNoWait();
    expect(ambientClock()).toBe(frozen);
    releaseFrozen();
    expect(ambientClock()).toBe(systemClock);
  });
});

describe('the clock port reaches every reader of "now"', () => {
  test('installClock(frozen 2001) is what ctxOf(...).clock and liveClock read', () => {
    const release = installClock(frozenClock('2001-01-01T00:00:00Z'));
    try {
      expect(ctxOf({}).clock.now().toISOString()).toBe('2001-01-01T00:00:00.000Z');
      expect(liveClock.now().getUTCFullYear()).toBe(2001);
    } finally {
      release();
    }
    expect(ctxOf({}).clock.now().getUTCFullYear()).toBeGreaterThan(2001);
  });
});
