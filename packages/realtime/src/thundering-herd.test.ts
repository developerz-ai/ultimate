import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import {
  AcceptBudget,
  backoffDelay,
  defaultBackoff,
  drainPlan,
  timeoutScheduler,
} from './thundering-herd';

describe('thundering herd', () => {
  test('jittered backoff produces a spread of delays, not one value', () => {
    const samples = Array.from({ length: 200 }, () => backoffDelay(3, defaultBackoff));
    const ceiling = Math.min(
      defaultBackoff.maxMs,
      defaultBackoff.baseMs * defaultBackoff.factor ** 3,
    );

    expect(new Set(samples).size).toBeGreaterThan(50);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...samples)).toBeLessThanOrEqual(ceiling);
    // Full jitter must actually reach both halves of the window, or it is not decorrelating.
    expect(samples.some((delay) => delay < ceiling / 2)).toBe(true);
    expect(samples.some((delay) => delay > ceiling / 2)).toBe(true);
  });

  test('backoff is capped and monotonic in the attempt number', () => {
    const none = { ...defaultBackoff, jitter: 'none' as const };
    expect(backoffDelay(0, none)).toBe(500);
    expect(backoffDelay(1, none)).toBe(1_000);
    expect(backoffDelay(99, none)).toBe(none.maxMs);
  });

  test('a drain assigns every socket its own slot instead of one shared delay', () => {
    const ids = Array.from({ length: 20 }, (_, index) => `s${index}`);
    const plan = drainPlan(ids, { spreadMs: 10_000, rng: () => 0.5 });

    expect(plan).toHaveLength(20);
    expect(new Set(plan.map((entry) => entry.afterMs)).size).toBe(20);
    for (const entry of plan) {
      expect(entry.afterMs).toBeGreaterThanOrEqual(0);
      expect(entry.afterMs).toBeLessThanOrEqual(10_000);
    }
    // Slot i is strictly later than slot i-1: the herd is spread, not reshuffled.
    const delays = plan.map((entry) => entry.afterMs);
    expect([...delays].sort((a, b) => a - b)).toEqual(delays);
  });

  test('the accept budget sheds load and hands back a retry delay', () => {
    const clock = frozenClock(0);
    const budget = new AcceptBudget({ perSecond: 10, burst: 2, clock });

    expect(budget.tryAccept()).toBe(true);
    expect(budget.tryAccept()).toBe(true);
    expect(budget.tryAccept()).toBe(false);

    clock.advance(1_000);
    expect(budget.tryAccept()).toBe(true);
    expect(budget.retryAfterMs(() => 0)).toBe(100);
  });
});

/**
 * The production scheduler. Ordering, never duration: both assertions are settled by a second
 * timer queued AFTER the one under test, so a slow machine cannot change the answer — a `setTimeout`
 * queued first with an equal-or-earlier deadline runs first.
 */
describe('timeoutScheduler', () => {
  const nextTick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

  test('runs the callback it was given', async () => {
    let fired = 0;
    timeoutScheduler(() => {
      fired += 1;
    }, 0);
    await nextTick();
    expect(fired).toBe(1);
  });

  test('the canceller it returns stops the callback from ever running', async () => {
    let fired = 0;
    const cancel = timeoutScheduler(() => {
      fired += 1;
    }, 0);
    cancel();
    await nextTick();
    expect(fired).toBe(0);
    // Cancelling twice is not a second failure — a reconnect races its own teardown.
    cancel();
    await nextTick();
    expect(fired).toBe(0);
  });

  test('cancelling one scheduled callback leaves the others alone', async () => {
    const fired: string[] = [];
    timeoutScheduler(() => fired.push('a'), 0);
    const cancelB = timeoutScheduler(() => fired.push('b'), 0);
    timeoutScheduler(() => fired.push('c'), 0);
    cancelB();
    await nextTick();
    expect(fired).toEqual(['a', 'c']);
  });
});
