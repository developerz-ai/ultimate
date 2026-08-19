// The real clock, which every other test in this package deliberately replaces. Its one hard rule
// is that a sleep RACES the signal rather than checking it afterwards: the watchdog aborts a
// wedged run precisely so nothing waits out the rest of a five-minute budget, and a sleep that
// only noticed the abort when its timer expired would wait out every one of them.

import { describe, expect, test } from 'bun:test';
import { deadline, systemScrapeClock, testClock, throwIfAborted } from './clock';

describe('unit · systemScrapeClock', () => {
  test('now() is a Date and monotonic() never goes backwards', () => {
    const first = systemScrapeClock.now();
    expect(first).toBeInstanceOf(Date);
    expect(Number.isFinite(first.getTime())).toBe(true);
    const a = systemScrapeClock.monotonic();
    const b = systemScrapeClock.monotonic();
    expect(typeof a).toBe('number');
    expect(b).toBeGreaterThanOrEqual(a);
  });

  test('a sleep with no signal resolves', async () => {
    await expect(systemScrapeClock.sleep(0)).resolves.toBeUndefined();
  });

  test('an ALREADY aborted signal never starts the timer, and rejects with the reason verbatim', async () => {
    const reason = { code: 'X_SCRAPE_WEDGED', fix: 'raise watchdog.idleMs' };
    const controller = new AbortController();
    controller.abort(reason);
    // A ten-second budget: if this waited it out, the test would time out rather than pass.
    await expect(systemScrapeClock.sleep(10_000, controller.signal)).rejects.toBe(reason);
  });

  test('an abort DURING the wait rejects immediately, with the same object the aborter put there', async () => {
    // Verbatim, never wrapped: whoever aborted put a ScrapeError with a code and a fix in the
    // reason, and re-wrapping it would replace an instruction with a bare Error.
    const reason = new Error('watchdog');
    const controller = new AbortController();
    const sleeping = systemScrapeClock.sleep(10_000, controller.signal);
    controller.abort(reason);
    await expect(sleeping).rejects.toBe(reason);
  });

  test('a signal that never aborts lets the sleep finish normally', async () => {
    const controller = new AbortController();
    await expect(systemScrapeClock.sleep(1, controller.signal)).resolves.toBeUndefined();
    expect(controller.signal.aborted).toBe(false);
  });
});

describe('unit · throwIfAborted', () => {
  test('it throws the reason unwrapped, and does nothing at all while live', () => {
    const live = new AbortController();
    expect(() => throwIfAborted(live.signal)).not.toThrow();

    const reason = { code: 'X_ABORTED' };
    const dead = new AbortController();
    dead.abort(reason);
    let thrown: unknown;
    try {
      throwIfAborted(dead.signal);
    } catch (error) {
      thrown = error;
    }
    // The reason OBJECT, not a copy and not a wrapper: callers read `.code` off it.
    expect(thrown).toBe(reason);
  });
});

describe('unit · testClock', () => {
  test('sleeping IS advancing, so a 30-second poll finishes on the next microtask', async () => {
    const clock = testClock(1_000);
    expect(clock.now().getTime()).toBe(1_000);
    expect(clock.monotonic()).toBe(0);

    await clock.sleep(30_000);

    expect(clock.now().getTime()).toBe(31_000);
    expect(clock.monotonic()).toBe(30_000);
  });

  test('it accepts a Date as well as an epoch', () => {
    expect(testClock(new Date('2026-01-01T00:00:00.000Z')).now().toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    // The default is the epoch, which is what makes every recorded `at` in this package a 0.
    expect(testClock().now().getTime()).toBe(0);
  });

  test('a slept signal still throws — a cancelled run must not keep polling under a test clock', async () => {
    const clock = testClock();
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);
    await expect(clock.sleep(5_000, controller.signal)).rejects.toBe(reason);
    // Time still moved: the loop under test sees the budget it burned before being cancelled.
    expect(clock.monotonic()).toBe(5_000);
  });
});

describe('unit · deadline', () => {
  test('it is read from ONE clock, so an advancing clock burns it down to zero and no further', () => {
    const clock = testClock();
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
    const clock = testClock();
    clock.advance(10_000);
    expect(deadline(clock, 1_000).remainingMs()).toBe(1_000);
  });
});
