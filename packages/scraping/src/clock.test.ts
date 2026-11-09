// The two properties of core's clocks this package's waits are built on — held here because a
// scrape's watchdog is what breaks if they drift — and the one thing still this package's own: a
// `deadline` read from one clock. Its one hard rule is that a sleep RACES the signal rather than checking it afterwards: the watchdog aborts a
// wedged run precisely so nothing waits out the rest of a five-minute budget, and a sleep that
// only noticed the abort when its timer expired would wait out every one of them.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { systemClock } from '@ultimat3/core/adapter';
import { deadline } from './clock';

describe('unit · systemClock', () => {
  test('now() is a Date and monotonic() never goes backwards', () => {
    const first = systemClock.now();
    expect(first).toBeInstanceOf(Date);
    expect(Number.isFinite(first.getTime())).toBe(true);
    const a = systemClock.monotonic();
    const b = systemClock.monotonic();
    expect(typeof a).toBe('number');
    expect(b).toBeGreaterThanOrEqual(a);
  });

  test('a sleep with no signal resolves', async () => {
    await expect(systemClock.sleep(0)).resolves.toBeUndefined();
  });

  test('an ALREADY aborted signal never starts the timer, and rejects with the reason verbatim', async () => {
    const reason = { code: 'X_SCRAPE_WEDGED', fix: 'raise watchdog.idleMs' };
    const controller = new AbortController();
    controller.abort(reason);
    // A ten-second budget: if this waited it out, the test would time out rather than pass.
    await expect(systemClock.sleep(10_000, controller.signal)).rejects.toBe(reason);
  });

  test('an abort DURING the wait rejects immediately, with the same object the aborter put there', async () => {
    // Verbatim, never wrapped: whoever aborted put a ScrapeError with a code and a fix in the
    // reason, and re-wrapping it would replace an instruction with a bare Error.
    const reason = new Error('watchdog');
    const controller = new AbortController();
    const sleeping = systemClock.sleep(10_000, controller.signal);
    controller.abort(reason);
    await expect(sleeping).rejects.toBe(reason);
  });

  test('a signal that never aborts lets the sleep finish normally', async () => {
    const controller = new AbortController();
    await expect(systemClock.sleep(1, controller.signal)).resolves.toBeUndefined();
    expect(controller.signal.aborted).toBe(false);
  });
});

describe('unit · an aborted sleep', () => {
  test('it rejects with the reason unwrapped, on both clocks', async () => {
    const reason = { code: 'X_ABORTED' };
    const dead = new AbortController();
    dead.abort(reason);
    // The reason OBJECT, not a copy and not a wrapper: callers read `.code` off it.
    for (const clock of [systemClock, frozenClock()]) {
      let thrown: unknown;
      try {
        await clock.sleep(60_000, dead.signal);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(reason);
    }
  });
});

describe('unit · testClock', () => {
  test('sleeping IS advancing, so a 30-second poll finishes on the next microtask', async () => {
    const clock = frozenClock(1_000);
    expect(clock.now().getTime()).toBe(1_000);
    expect(clock.monotonic()).toBe(0);

    await clock.sleep(30_000);

    expect(clock.now().getTime()).toBe(31_000);
    expect(clock.monotonic()).toBe(30_000);
  });

  test('it accepts a Date as well as an epoch', () => {
    expect(frozenClock(new Date('2026-01-01T00:00:00.000Z')).now().toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    // The default is the epoch, which is what makes every recorded `at` in this package a 0.
    expect(frozenClock().now().getTime()).toBe(0);
  });

  test('a slept signal still throws — a cancelled run must not keep polling under a test clock', async () => {
    const clock = frozenClock();
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);
    await expect(clock.sleep(5_000, controller.signal)).rejects.toBe(reason);
    // Core's frozen clock behaves as the system clock does: an ALREADY aborted signal never starts
    // the wait, so no time passes (31.0.0; `testScrapeClock` used to advance first).
    expect(clock.monotonic()).toBe(0);
  });
});

describe('unit · deadline', () => {
  test('it is read from ONE clock, so an advancing clock burns it down to zero and no further', () => {
    const clock = frozenClock();
    const budget = deadline(clock, 1_000);
    expect(budget.totalMs).toBe(1_000);
    expect(budget.remainingMs()).toBe(1_000);
    expect(budget.expired()).toBe(false);

    clock.advance(400);
    expect(budget.remainingMs()).toBe(600);
    expect(budget.expired()).toBe(false);

    clock.advance(600);
    expect(budget.remainingMs()).toBe(0);
    expect(budget.expired()).toBe(true);

    // Never negative: a remaining time below zero handed to `AbortSignal.timeout` is an immediate
    // abort in some builds and a never-firing timer in others.
    clock.advance(5_000);
    expect(budget.remainingMs()).toBe(0);
  });

  test('a budget started later is not affected by time that passed before it', () => {
    const clock = frozenClock();
    clock.advance(10_000);
    expect(deadline(clock, 1_000).remainingMs()).toBe(1_000);
  });
});
