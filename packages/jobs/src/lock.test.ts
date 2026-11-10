// `withLock()` on the memory lease store and a frozen clock: one winner, a bounded wait that
// refuses with the holder named, a TTL expiry that hands the key over and aborts the stale holder.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { installJobDriver, resetJobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { memoryLeaseStore } from './leases';
import type { HeldLock } from './lock';
import { lockLeaseKey, withLock } from './lock';
import type { IntervalScheduler } from './renewal-timer';

const codeOf = (error: unknown): string | undefined =>
  isUltimateError(error) ? error.code : undefined;

/** A scheduler a test fires by hand: the renewal happens when the test says, never on the wall. */
function manualSchedule(): { schedule: IntervalScheduler; tick(): Promise<void> } {
  const ticks: (() => void)[] = [];
  return {
    schedule: (tick) => {
      ticks.push(tick);
      return () => {
        ticks.splice(ticks.indexOf(tick), 1);
      };
    },
    async tick() {
      for (const tick of [...ticks]) tick();
      // The renewal body is a promise chain: one macrotask lets every link of it settle.
      await settle();
    },
  };
}

/** One macrotask: an acquire, its timer arming and a renewal chain all settle inside it. */
const settle = (): Promise<void> => new Promise<void>((done) => setImmediate(done));

const deferred = (): { promise: Promise<void>; resolve(): void } => {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

afterEach(() => {
  resetJobDriver();
});

describe('withLock', () => {
  test('two holders: the second is refused within wait, naming the first', async () => {
    const clock = frozenClock('2026-11-09T00:00:00Z');
    const store = memoryLeaseStore({ clock });
    const gate = deferred();
    let first: HeldLock | undefined;
    const holding = withLock(
      'invoice:1',
      async (lock) => {
        first = lock;
        await gate.promise;
        return 'a';
      },
      { ttl: '1h', store, clock, schedule: manualSchedule().schedule },
    );
    await settle();
    const refused = await withLock('invoice:1', () => 'b', {
      ttl: '1h',
      wait: 500,
      store,
      clock,
    }).catch((error: unknown) => error);
    expect(codeOf(refused)).toBe('X_LOCK_NOT_ACQUIRED');
    expect(isUltimateError(refused) && refused.meta?.['holders']).toHaveLength(1);
    expect(typeof first?.token).toBe('number');
    gate.resolve();
    expect(await holding).toBe('a');
    expect(await store.held(lockLeaseKey('invoice:1'))).toBe(0);
  });

  test('a waiter takes the key once the holder releases, with a greater token', async () => {
    const clock = frozenClock('2026-11-09T00:00:00Z');
    const store = memoryLeaseStore({ clock });
    const gate = deferred();
    let firstToken = 0;
    const holding = withLock(
      'k',
      async (lock) => {
        firstToken = lock.token;
        await gate.promise;
      },
      { ttl: '1h', store, clock, schedule: manualSchedule().schedule },
    );
    await settle();
    // The frozen clock's sleep advances it, so release the holder on the waiter's first poll.
    const waiting = withLock('k', (lock) => lock.token, { ttl: '1h', wait: '1m', store, clock });
    gate.resolve();
    await holding;
    const secondToken = await waiting;
    expect(secondToken > firstToken).toBe(true);
  });

  test('a TTL expiry hands the key over; the stale holder is aborted with X_LOCK_LOST', async () => {
    const clock = frozenClock('2026-11-09T00:00:00Z');
    const store = memoryLeaseStore({ clock });
    const renewals = manualSchedule();
    const gate = deferred();
    let seen: unknown;
    const stale = withLock(
      'k',
      async (lock) => {
        await gate.promise;
        seen = lock.signal.reason;
        return 'stale';
      },
      { ttl: 1_000, store, clock, schedule: renewals.schedule },
    ).catch((error: unknown) => error);
    await settle();
    clock.advance(1_500);
    expect(await withLock('k', () => 'next', { ttl: 1_000, wait: 0, store, clock })).toBe('next');
    // Re-take it so the stale holder's renewal meets a key that is somebody else's.
    const third = withLock('k', () => gate.promise, { ttl: '1h', wait: 0, store, clock });
    await settle();
    await renewals.tick();
    gate.resolve();
    await third;
    expect(codeOf(seen)).toBe('X_LOCK_LOST');
    expect(codeOf(await stale)).toBe('X_LOCK_LOST');
  });

  test('a renewal that lands keeps the key past one ttl', async () => {
    const clock = frozenClock('2026-11-09T00:00:00Z');
    const store = memoryLeaseStore({ clock });
    const renewals = manualSchedule();
    const gate = deferred();
    const holding = withLock('k', () => gate.promise, {
      ttl: 900,
      store,
      clock,
      schedule: renewals.schedule,
    });
    await settle();
    for (let round = 0; round < 4; round += 1) {
      clock.advance(300);
      await renewals.tick();
    }
    const refused = await withLock('k', () => 'b', { ttl: 900, wait: 0, store, clock }).catch(
      (error: unknown) => error,
    );
    expect(codeOf(refused)).toBe('X_LOCK_NOT_ACQUIRED');
    gate.resolve();
    await holding;
  });

  test('a renewal that throws is a loss only once a whole ttl passed without one landing', async () => {
    const clock = frozenClock('2026-11-09T00:00:00Z');
    const inner = memoryLeaseStore({ clock });
    let failing = false;
    const store = {
      ...inner,
      renew: (lease: Parameters<typeof inner.renew>[0], ttlMs: number) =>
        failing ? Promise.reject(new TypeError('pool closed')) : inner.renew(lease, ttlMs),
    };
    const renewals = manualSchedule();
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const holding = withLock(
      'k',
      async (lock) => {
        signal = lock.signal;
        await gate.promise;
      },
      { ttl: 900, store, clock, schedule: renewals.schedule },
    ).catch((error: unknown) => error);
    await settle();
    clock.advance(600);
    await renewals.tick();
    failing = true;
    clock.advance(600);
    await renewals.tick();
    expect(signal?.aborted).toBe(false);
    clock.advance(400);
    await renewals.tick();
    expect(codeOf(signal?.reason)).toBe('X_LOCK_LOST');
    gate.resolve();
    expect(codeOf(await holding)).toBe('X_LOCK_LOST');
  });

  test('an abort landing during the final acquire reaches fn’s signal', async () => {
    const inner = memoryLeaseStore();
    const outer = new AbortController();
    const reason = new TypeError('caller gave up');
    // The acquire that SUCCEEDS is in flight when the caller aborts.
    const store = {
      ...inner,
      acquire: async (...args: Parameters<typeof inner.acquire>) => {
        const lease = await inner.acquire(...args);
        outer.abort(reason);
        return lease;
      },
    };
    let seen: AbortSignal | undefined;
    await withLock(
      'k',
      (lock) => {
        seen = lock.signal;
      },
      { ttl: '1m', store, signal: outer.signal, schedule: manualSchedule().schedule },
    );
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBe(reason);
  });

  test('a renewal that never settles is a loss once the ttl lapses — decided before the call', async () => {
    const clock = frozenClock('2026-11-09T00:00:00Z');
    const inner = memoryLeaseStore({ clock });
    let calls = 0;
    // A dead socket: the renew is sent and never answers, neither way.
    const store = {
      ...inner,
      renew: () => {
        calls += 1;
        return new Promise<boolean>(() => {});
      },
    };
    const renewals = manualSchedule();
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const holding = withLock(
      'k',
      async (lock) => {
        signal = lock.signal;
        await gate.promise;
      },
      { ttl: 900, store, clock, schedule: renewals.schedule },
    ).catch((error: unknown) => error);
    await settle();
    clock.advance(600);
    await renewals.tick();
    clock.advance(600);
    await renewals.tick();
    expect(codeOf(signal?.reason)).toBe('X_LOCK_LOST');
    // One renewal in flight at a time: the hung one is not joined by a second.
    expect(calls).toBe(1);
    gate.resolve();
    expect(codeOf(await holding)).toBe('X_LOCK_LOST');
  });

  test('a renewal answering after the ttl lapsed is a loss, though it says true', async () => {
    const clock = frozenClock('2026-11-09T00:00:00Z');
    const inner = memoryLeaseStore({ clock });
    let answer = (_held: boolean): void => {};
    const store = {
      ...inner,
      renew: () =>
        new Promise<boolean>((done) => {
          answer = done;
        }),
    };
    const renewals = manualSchedule();
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const holding = withLock(
      'k',
      async (lock) => {
        signal = lock.signal;
        await gate.promise;
      },
      { ttl: 900, store, clock, schedule: renewals.schedule },
    ).catch((error: unknown) => error);
    await settle();
    clock.advance(300);
    await renewals.tick();
    // Sent at 300, answered at 1,300: the store dated the expiry at 300 + 900 = 1,200.
    clock.advance(1_000);
    answer(true);
    await settle();
    expect(codeOf(signal?.reason)).toBe('X_LOCK_LOST');
    gate.resolve();
    expect(codeOf(await holding)).toBe('X_LOCK_LOST');
  });

  test('a throw between the acquire and fn hands the lease back', async () => {
    const store = memoryLeaseStore();
    const boom = new TypeError('schedule refused');
    const thrown = await withLock('k', () => 1, {
      ttl: '1m',
      store,
      // INPUT to the code under test: a renewal scheduler that throws when armed.
      schedule: () => {
        throw boom;
      },
    }).catch((error: unknown) => error);
    expect(thrown).toBe(boom);
    expect(await store.held(lockLeaseKey('k'))).toBe(0);
  });

  test('fn throwing releases the key and rethrows', async () => {
    const store = memoryLeaseStore();
    // INPUT to the code under test: the failure an app's body rejects with.
    const boom = new TypeError('boom');
    const thrown = await withLock('k', () => Promise.reject(boom), { ttl: '1m', store }).catch(
      (error: unknown) => error,
    );
    expect(thrown).toBe(boom);
    expect(await store.held(lockLeaseKey('k'))).toBe(0);
  });

  test('defaults to the installed driver’s lease store, and refuses with none', async () => {
    const refused = await withLock('k', () => 1, { ttl: '1m' }).catch((error: unknown) => error);
    expect(codeOf(refused)).toBe('X_LOCK_STORE_MISSING');
    installJobDriver(memoryJobDriver());
    expect(await withLock('k', () => 1, { ttl: '1m' })).toBe(1);
  });

  test('a ttl under 3ms is refused before anything is acquired', async () => {
    const store = memoryLeaseStore();
    const refused = await withLock('k', () => 1, { ttl: 1, store }).catch((e: unknown) => e);
    expect(codeOf(refused)).toBe('X_INVARIANT');
    expect(await store.held(lockLeaseKey('k'))).toBe(0);
  });

  test('the token is the STORE’s fence, never this process’s clock', async () => {
    const store = memoryLeaseStore();
    // A clock far in the past must not make a later holder's token smaller.
    const behind = frozenClock('2000-01-01T00:00:00Z');
    const first = await withLock('k', (lock) => lock.token, { ttl: '1m', store });
    const second = await withLock('k', (lock) => lock.token, { ttl: '1m', store, clock: behind });
    expect(second).toBeGreaterThan(first);
  });

  test('a store that answers no fence is refused, its lease handed back', async () => {
    const inner = memoryLeaseStore();
    const fenceless = {
      ...inner,
      acquire: async (...args: Parameters<typeof inner.acquire>) => {
        const lease = await inner.acquire(...args);
        return lease === undefined
          ? undefined
          : { key: lease.key, slot: lease.slot, holder: lease.holder };
      },
    };
    let ran = false;
    const refused = await withLock(
      'k',
      () => {
        ran = true;
      },
      { ttl: '1m', store: fenceless },
    ).catch((error: unknown) => error);
    expect(codeOf(refused)).toBe('X_LOCK_STORE_MISSING');
    expect(ran).toBe(false);
    expect(await inner.held(lockLeaseKey('k'))).toBe(0);
  });

  test('a lock never shares a slot table with a job cap', () => {
    expect(lockLeaseKey('job:a')).toBe('lock:job%3Aa');
  });
});
