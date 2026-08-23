// The gate exists because argon2id at the OWASP floor is 19 MiB of arena per attempt and every
// other limit in the framework is per-SOURCE: `ipKey(ip)` (5 attempts) and http's `auth` bucket
// (10 per `route|ip:`) both mint a fresh key for every address, so an attacker rotating an
// IPv6 /64 is never the same key twice — and both cap ATTEMPTS, not concurrent work. The only
// backstop left was `maxInflight: 1000`, which is ~19 GB of argon2 arenas queued.

import { describe, expect, test } from 'bun:test';
import { AuthError } from './errors';
import { createKdfGate, DEFAULT_KDF_LIMITS } from './kdf-gate';

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('createKdfGate', () => {
  test('never runs more than maxConcurrent at once', async () => {
    const gate = createKdfGate({ maxConcurrent: 2, maxQueued: 10 });
    const blocker = deferred();
    let running = 0;
    let peak = 0;
    const work = async (): Promise<void> => {
      running += 1;
      peak = Math.max(peak, running);
      await blocker.promise;
      running -= 1;
    };
    const all = Promise.all([1, 2, 3, 4, 5].map(async () => await gate.run(work)));
    await Promise.resolve();
    expect(peak).toBe(2);
    blocker.resolve();
    await all;
    expect(peak).toBe(2);
  });

  test('past the queue bound it refuses with X_OVERLOADED rather than queueing forever', async () => {
    const gate = createKdfGate({ maxConcurrent: 1, maxQueued: 1 });
    const blocker = deferred();
    const held = gate.run(async () => await blocker.promise);
    const queued = gate.run(async () => await blocker.promise);

    let code = 'did-not-throw';
    try {
      await gate.run(async () => undefined);
    } catch (error) {
      code = error instanceof AuthError ? error.code : `not-an-AuthError: ${String(error)}`;
    }
    expect(code).toBe('X_OVERLOADED');

    blocker.resolve();
    await held;
    await queued;
  });

  test('a slot is released even when the work throws', async () => {
    const gate = createKdfGate({ maxConcurrent: 1, maxQueued: 0 });
    await gate
      .run(async () => {
        throw new Error('kdf blew up');
      })
      .catch(() => undefined);
    // If the slot leaked, this call would be refused instead of running.
    expect(await gate.run(async () => 'ran')).toBe('ran');
  });

  test('the shipped defaults bound both the work and the queue', () => {
    expect(DEFAULT_KDF_LIMITS.maxConcurrent).toBeGreaterThan(0);
    expect(DEFAULT_KDF_LIMITS.maxQueued).toBeGreaterThan(0);
    // 19 MiB per hash: the ceiling has to be a number of megabytes, not a number of requests.
    expect(DEFAULT_KDF_LIMITS.maxConcurrent).toBeLessThanOrEqual(16);
  });
});

// The refusal is the whole of what a caller sees when the gate sheds, and `createKdfGate`
// delegates its mechanism to `@ultimat3/core`'s `createFlightGate` — which carries a refusal of
// its own (`X_FLIGHT_GATE_OVERLOADED`). These pin the three facts that must survive that: the
// code stays this package's borrowed `X_OVERLOADED`, the counts are the ones read at the instant
// of the shed, and `retryAfterSeconds` is still in `meta` for the host to put on the header.
describe('the shed refusal, whoever performs the queueing', () => {
  /** Fills `maxConcurrent` + `maxQueued`, then returns the refusal the next caller gets. */
  const shedOf = async (limits: {
    maxConcurrent: number;
    maxQueued: number;
  }): Promise<{ refusal: AuthError; release: () => Promise<void> }> => {
    const gate = createKdfGate(limits);
    const blocker = deferred();
    const held = Array.from({ length: limits.maxConcurrent + limits.maxQueued }, async () =>
      gate.run(async () => await blocker.promise),
    );
    // A microtask turn, so every queued caller is parked in the waiter list before the shed.
    await Promise.resolve();
    try {
      await gate.run(async () => undefined);
    } catch (error) {
      if (error instanceof AuthError) {
        return {
          refusal: error,
          release: async (): Promise<void> => {
            blocker.resolve();
            await Promise.all(held);
          },
        };
      }
    }
    blocker.resolve();
    await Promise.all(held);
    return expect.unreachable('the gate accepted a caller past its own queue bound');
  };

  test('the code is X_OVERLOADED, never the gate mechanism its own', async () => {
    const { refusal, release } = await shedOf({ maxConcurrent: 2, maxQueued: 3 });
    expect(refusal.code).toBe('X_OVERLOADED');
    await release();
  });

  test('the counts are the running and queued totals at the instant of the shed', async () => {
    const { refusal, release } = await shedOf({ maxConcurrent: 2, maxQueued: 3 });
    expect(refusal.meta?.['active']).toBe(2);
    expect(refusal.meta?.['queued']).toBe(3);
    expect(refusal.cause).toBe('2 password hashes are already running and 3 more are queued');
    await release();
  });

  test('retryAfterSeconds rides in meta, because this package cannot reach a header', async () => {
    const { refusal, release } = await shedOf({ maxConcurrent: 1, maxQueued: 1 });
    expect(refusal.meta?.['retryAfterSeconds']).toBe(1);
    expect(refusal.fix).toContain('configureKdfGate(');
    await release();
  });

  // A slot handed to a waiter, never released and re-acquired: decrementing first lets a caller
  // arriving in the same tick past the ceiling while the waiter's continuation is still a queued
  // microtask. Two waiters and a latecomer racing one freed slot is where that shows.
  test('a freed slot goes to the waiter, not to a caller arriving in the same tick', async () => {
    /** A macrotask turn: long enough for every queued continuation to have run. */
    const flush = async (): Promise<void> => {
      await new Promise<void>((done) => {
        setTimeout(done, 0);
      });
    };
    const gate = createKdfGate({ maxConcurrent: 1, maxQueued: 8 });
    const first = deferred();
    const second = deferred();
    const order: string[] = [];

    const held = gate.run(async () => {
      order.push('held');
      await first.promise;
    });
    await Promise.resolve();
    const waiter = gate.run(async () => {
      order.push('waiter');
      await second.promise;
    });
    await Promise.resolve();

    first.resolve();
    // The latecomer arrives in the tick the slot frees; the waiter is ahead of it either way.
    const latecomer = gate.run(async () => {
      order.push('latecomer');
    });
    await flush();
    expect(order).toEqual(['held', 'waiter']);

    second.resolve();
    await Promise.all([held, waiter, latecomer]);
    expect(order).toEqual(['held', 'waiter', 'latecomer']);
  });
});
