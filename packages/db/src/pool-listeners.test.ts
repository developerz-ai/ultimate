// Single responsibility: a LISTEN session across a retired pool. `close()` ends a session for good
// (`bun-sql.ts`), so without a re-dial `startQueueWake` keeps reporting a wake that nobody delivers.
// The ordinary subscription contract is `listen.test.ts`; a real retirement, `client-wedge.live.test.ts`.

import { describe, expect, test } from 'bun:test';
import type { Scheduler } from '@ultimat3/core';
import { dbUnavailable } from './errors';
import { poolListeners } from './pool-listeners';

interface FakePool {
  readonly channels: string[];
  unlistens: number;
  refuse: boolean;
  gate: Promise<void>;
  listen(
    channel: string,
    onNotify: (payload: string) => void,
    onListening?: () => void,
  ): Promise<{ unlisten(): Promise<void> }>;
}

function fakePool(): FakePool {
  const pool: FakePool = {
    channels: [],
    unlistens: 0,
    refuse: false,
    gate: Promise.resolve(),
    async listen(channel, _onNotify, onListening) {
      await pool.gate;
      if (pool.refuse) throw dbUnavailable('connection refused');
      pool.channels.push(channel);
      onListening?.();
      return {
        unlisten: async () => {
          pool.unlistens += 1;
        },
      };
    },
  };
  return pool;
}

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

const turn = (): Promise<void> => Bun.sleep(0);

describe('poolListeners across a retired pool', () => {
  test('every session is established again on the new pool, and says so', async () => {
    const first = fakePool();
    const second = fakePool();
    let current = first;
    const listeners = poolListeners(() => current);
    let established = 0;
    const subscription = await listeners.listen(
      'x_jobs_wake',
      () => undefined,
      () => {
        established += 1;
      },
    );
    expect(established).toBe(1);

    current = second;
    listeners.redial();
    await turn();

    expect(second.channels).toEqual(['x_jobs_wake']);
    // Twice: once as the old session is lost, once as the new one lands. `startQueueWake` un-proves
    // the wake on the first and re-probes on the second.
    expect(established).toBe(3);

    await subscription.unlisten();
    expect(second.unlistens).toBe(1);
    expect(first.unlistens).toBe(0);
  });

  test('a retirement un-proves the session at once, even when every re-dial is refused', async () => {
    // Reproduced: wake live, pool retired, every redial refused, `wake.live()` still true 3 s
    // later — so `queue_wake_live` stayed on and the loops kept the 5 s ceiling, not 2 s.
    const first = fakePool();
    const second = fakePool();
    second.refuse = true;
    let current = first;
    const timers = manualTimers();
    const listeners = poolListeners(() => current, timers.schedule);
    let established = 0;
    await listeners.listen(
      'x_jobs_wake',
      () => undefined,
      () => {
        established += 1;
      },
    );
    expect(established).toBe(1);

    current = second;
    listeners.redial();
    expect(established).toBe(2);
    await turn();
    timers.fire();
    await turn();
    // Once per retirement, not once per refused attempt: each one would send a probe.
    expect(established).toBe(2);
  });

  test('a refused re-dial retries on its timer until the database is back', async () => {
    const first = fakePool();
    const second = fakePool();
    second.refuse = true;
    let current = first;
    const timers = manualTimers();
    const listeners = poolListeners(() => current, timers.schedule);
    await listeners.listen('x_jobs_wake', () => undefined);

    current = second;
    listeners.redial();
    await turn();
    expect(second.channels).toEqual([]);
    expect(timers.armed()).toBe(1);

    second.refuse = false;
    timers.fire();
    await turn();
    expect(second.channels).toEqual(['x_jobs_wake']);
    expect(timers.armed()).toBe(0);
  });

  test('a pool that cannot be built lands in the retry too', async () => {
    const pool = fakePool();
    let broken = false;
    const timers = manualTimers();
    const listeners = poolListeners(() => {
      if (broken) throw dbUnavailable('DATABASE_URL is not set');
      return pool;
    }, timers.schedule);
    await listeners.listen('x_jobs_wake', () => undefined);

    broken = true;
    expect(() => listeners.redial()).not.toThrow();
    await turn();
    expect(timers.armed()).toBe(1);
  });

  test('unlisten during a retry stops it', async () => {
    const first = fakePool();
    const second = fakePool();
    second.refuse = true;
    let current = first;
    const timers = manualTimers();
    const listeners = poolListeners(() => current, timers.schedule);
    const subscription = await listeners.listen('x_jobs_wake', () => undefined);

    current = second;
    listeners.redial();
    await turn();
    await subscription.unlisten();

    expect(timers.armed()).toBe(0);
  });

  test('drop() ends them for good: a later retirement dials nothing', async () => {
    const first = fakePool();
    const second = fakePool();
    let current = first;
    const listeners = poolListeners(() => current);
    await listeners.listen('x_jobs_wake', () => undefined);

    listeners.drop();
    current = second;
    listeners.redial();
    await turn();

    expect(second.channels).toEqual([]);
  });

  test('a retirement mid-dial: the session on the closed pool is ended, and the caller keeps one', async () => {
    const first = fakePool();
    const second = fakePool();
    let open: () => void = () => undefined;
    first.gate = new Promise((resolve) => {
      open = resolve;
    });
    let current = first;
    const listeners = poolListeners(() => current);
    const dialling = listeners.listen('x_jobs_wake', () => undefined);

    current = second;
    listeners.redial();
    open();
    const subscription = await dialling;
    await turn();

    expect(first.unlistens).toBe(1);
    expect(second.channels).toEqual(['x_jobs_wake']);
    await subscription.unlisten();
    expect(second.unlistens).toBe(1);
  });

  test('a first dial refused with no retirement is the caller to hear, and is not held', async () => {
    const pool = fakePool();
    pool.refuse = true;
    const listeners = poolListeners(() => pool);
    await expect(listeners.listen('x_jobs_wake', () => undefined)).rejects.toMatchObject({
      code: 'X_DB_UNAVAILABLE',
    });

    pool.refuse = false;
    listeners.redial();
    await turn();
    expect(pool.channels).toEqual([]);
  });
});
