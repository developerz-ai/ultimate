// Single responsibility: the counter in front of the pool on its own — who goes when, who is refused,
// and that nobody leaves a slot behind. `client-pool.test.ts` proves the client actually asks it.

import { describe, expect, test } from 'bun:test';
import type { Scheduler } from '@ultimat3/core';
import { dbUnavailable } from './errors';
import { poolGate } from './pool-gate';

/** Fires what is due when the test says so, so a deadline is provable without waiting one out. */
function manualTimers(): { schedule: Scheduler; fire(): void; armed(): number } {
  const armed = new Set<() => void>();
  return {
    schedule: (fn) => {
      armed.add(fn);
      return () => armed.delete(fn);
    },
    fire: () => {
      for (const fn of [...armed]) {
        armed.delete(fn);
        fn();
      }
    },
    armed: () => armed.size,
  };
}

describe('poolGate', () => {
  test('under the ceiling nobody waits, and no timer is armed', () => {
    const timers = manualTimers();
    const gate = poolGate(2, timers.schedule);

    expect(gate.enter(100)).toBeUndefined();
    expect(gate.enter(100)).toBeUndefined();
    expect(timers.armed()).toBe(0);
  });

  test('waiters go in the order they asked, each handed the slot that came free', async () => {
    const gate = poolGate(1, manualTimers().schedule);
    expect(gate.enter(100)).toBeUndefined();
    const order: string[] = [];
    const first = gate.enter(100)?.then(() => order.push('first'));
    const second = gate.enter(100)?.then(() => order.push('second'));

    gate.leave();
    await first;
    expect(order).toEqual(['first']);

    // Handed over, never released and re-taken: a newcomer cannot overtake the queue.
    const newcomer = gate.enter(100);
    expect(newcomer).toBeInstanceOf(Promise);

    gate.leave();
    await second;
    expect(order).toEqual(['first', 'second']);

    gate.leave();
    await newcomer;
  });

  test('a waiter past the bound refuses, and leaves no slot', async () => {
    const timers = manualTimers();
    const gate = poolGate(1, timers.schedule);
    expect(gate.enter(250)).toBeUndefined();

    const waiting = gate.enter(250);
    timers.fire();
    const caught = await waiting?.catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: 'X_DB_POOL_EXHAUSTED' });

    // The holder's slot is still the only one out: its leave frees it for the next ask.
    gate.leave();
    expect(gate.enter(250)).toBeUndefined();
    expect(gate.enter(250)).toBeInstanceOf(Promise);
  });

  test('a waiter handed a slot disarms its own deadline', async () => {
    const timers = manualTimers();
    const gate = poolGate(1, timers.schedule);
    void gate.enter(250);
    const waiting = gate.enter(250);
    expect(timers.armed()).toBe(1);

    gate.leave();
    await waiting;
    expect(timers.armed()).toBe(0);
  });

  test('0 waits with no deadline at all, which is what a run-once role wants', async () => {
    const timers = manualTimers();
    const gate = poolGate(1, timers.schedule);
    void gate.enter(0);

    const waiting = gate.enter(0);
    expect(timers.armed()).toBe(0);

    gate.leave();
    await waiting;
  });

  test('refuseWaiting rejects the queue and takes nothing from who holds a slot', async () => {
    const timers = manualTimers();
    const gate = poolGate(1, timers.schedule);
    void gate.enter(250);
    const waiting = gate.enter(250)?.catch((error: unknown) => error);

    gate.refuseWaiting(dbUnavailable('the pool closed'));

    expect(await waiting).toMatchObject({ code: 'X_DB_UNAVAILABLE' });
    expect(timers.armed()).toBe(0);
    expect(gate.enter(250)).toBeInstanceOf(Promise);
  });

  test('handOverWaiting tells the queue this pool is gone, and disarms their deadlines', async () => {
    const timers = manualTimers();
    const gate = poolGate(1, timers.schedule);
    void gate.enter(250);
    const waiting = gate.enter(250);

    gate.handOverWaiting();

    expect(await waiting).toBe(false);
    expect(timers.armed()).toBe(0);
  });

  test('a second leave for one enter frees nothing that was not held', () => {
    const gate = poolGate(1, manualTimers().schedule);
    void gate.enter(250);
    gate.leave();
    gate.leave();

    expect(gate.enter(250)).toBeUndefined();
    expect(gate.enter(250)).toBeInstanceOf(Promise);
  });
});
