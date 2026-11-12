// Single responsibility: the counter in front of the pool on its own — who goes when, who is refused,
// and that nobody leaves a slot behind. `client-pool.test.ts` proves the client actually asks it.

import { describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, type Scheduler, UltimateError } from '@ultimat3/core';
import { dbUnavailable } from './errors';
import { type GatedPool, poolGate, type QueueExit, takeSlot } from './pool-gate';

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

/** A coded abort, as a deadline or a job's cancel hands it. */
const coded = (): UltimateError =>
  new UltimateError({ code: 'X_TIMEOUT', cause: 'the deadline passed', fix: 'raise the deadline' });

/** The exit `takeSlot` builds, by hand: leaves with whatever `reason` names, stays on `undefined`. */
function exitOn(
  controller: AbortController,
  reason: () => unknown = () => coded(),
): () => QueueExit {
  return () => ({ signal: controller.signal, reason });
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

  test('abort while queued: the waiter is gone, the next leave() admits the live waiter', async () => {
    const timers = manualTimers();
    const gate = poolGate(1, timers.schedule);
    expect(gate.enter(250)).toBeUndefined();
    const controller = new AbortController();
    const dead = gate.enter(250, exitOn(controller))?.catch((error: unknown) => error);
    let liveAdmitted = false;
    const live = gate.enter(250)?.then((admitted) => {
      liveAdmitted = admitted;
    });

    controller.abort();

    expect(await dead).toMatchObject({ code: 'X_TIMEOUT' });
    // The dead waiter's deadline is disarmed; only the live one's is still armed.
    expect(timers.armed()).toBe(1);
    gate.leave();
    await live;
    expect(liveAdmitted).toBe(true);
  });

  test('an abort that names no reason to leave keeps its place in the queue', async () => {
    const gate = poolGate(1, manualTimers().schedule);
    void gate.enter(250);
    const controller = new AbortController();
    const waiting = gate.enter(
      250,
      exitOn(controller, () => undefined),
    );

    controller.abort();
    gate.leave();

    expect(await waiting).toBe(true);
  });

  test('a waiter admitted before the abort is not refused by it', async () => {
    const gate = poolGate(1, manualTimers().schedule);
    void gate.enter(250);
    const controller = new AbortController();
    const waiting = gate.enter(250, exitOn(controller));

    gate.leave();
    expect(await waiting).toBe(true);
    controller.abort();
    // Still exactly one slot out: the late abort freed nothing and refused nothing.
    expect(gate.enter(250)).toBeInstanceOf(Promise);
  });
});

describe('takeSlot under a scope', () => {
  function gated(): GatedPool {
    return {
      gate: poolGate(1, manualTimers().schedule),
      demand: { enter: () => undefined, leave: () => undefined, close: () => undefined },
    };
  }

  test('a queued read leaves on a hang-up, refused as X_ABORTED', async () => {
    const pool = gated();
    void pool.gate.enter(250);
    const controller = new AbortController();
    const waiting = runWithContext(ctxOf({ signal: controller.signal }), () =>
      Promise.resolve(takeSlot(() => pool, 250, 'select 1')).catch((error: unknown) => error),
    );

    controller.abort();

    expect(await waiting).toMatchObject({ code: 'X_ABORTED' });
  });

  test('a queued write stays through a hang-up, and leaves on a coded abort with its reason', async () => {
    const pool = gated();
    void pool.gate.enter(250);
    const hangUp = new AbortController();
    const write = runWithContext(ctxOf({ signal: hangUp.signal }), () =>
      Promise.resolve(takeSlot(() => pool, 250, 'update t set a = 1')),
    );
    hangUp.abort();
    pool.gate.leave();
    expect(await write).toBe(pool);

    const deadline = new AbortController();
    const reason = coded();
    const late = runWithContext(ctxOf({ signal: deadline.signal }), () =>
      Promise.resolve(takeSlot(() => pool, 250, 'update t set a = 1')).catch(
        (error: unknown) => error,
      ),
    );
    deadline.abort(reason);
    expect(await late).toBe(reason);
  });

  test('a scope already aborted when it asks queues as before: it is not watched', async () => {
    const pool = gated();
    void pool.gate.enter(250);
    const controller = new AbortController();
    controller.abort(coded());
    const waiting = runWithContext(ctxOf({ signal: controller.signal }), () =>
      Promise.resolve(takeSlot(() => pool, 250, 'select 1')),
    );

    pool.gate.leave();
    expect(await waiting).toBe(pool);
  });
});
