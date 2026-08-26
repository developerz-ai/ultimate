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

/**
 * The fourth runtime number, and the one that WEDGES rather than fails — the shape `mfa.drift`
 * already had. `createFlightGate` asks `active < maxConcurrent` and then
 * `waiters.length >= maxQueued`, and both are false for `NaN`: every `hashPassword` and
 * `verifyPassword` on the box parks in a queue with no bound and nothing to release it, so login
 * stops answering at all instead of shedding. Screened at the constructor, so `configureKdfGate`
 * and a direct `createKdfGate(limits)` are the same door.
 */
describe('the kdf limits are screened numbers', () => {
  const refusal = (limits: { maxConcurrent: number; maxQueued: number }): AuthError => {
    try {
      createKdfGate(limits);
    } catch (error) {
      if (error instanceof AuthError) return error;
      throw error;
    }
    // Never `await gate.run(...)` here: an unscreened NaN queues for ever and wedges the runner.
    return expect.unreachable('a gate was built on a bound no comparison can be true against');
  };

  test('a width that is not a whole count is refused, not queued behind', () => {
    for (const maxConcurrent of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      const error = refusal({ maxConcurrent, maxQueued: 64 });
      expect(error.code).toBe('X_CONFIG_INVALID');
      expect(error.meta?.['option']).toBe('kdf.maxConcurrent');
    }
  });

  test('a queue bound that is not delta-countable is refused', () => {
    for (const maxQueued of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      const error = refusal({ maxConcurrent: 8, maxQueued });
      expect(error.code).toBe('X_CONFIG_INVALID');
      expect(error.meta?.['option']).toBe('kdf.maxQueued');
    }
  });

  test('a zero queue stays legal — it sheds at the width instead of waiting', async () => {
    const gate = createKdfGate({ maxConcurrent: 1, maxQueued: 0 });
    expect(await gate.run(async () => 'hashed')).toBe('hashed');
  });

  /**
   * The minimum is 0 at BOTH, and this is the case that decides it: a zero-width gate with a zero
   * queue refuses every hash, which is how `password.test.ts` proves the unreadable-hash path
   * burns the same KDF a wrong password does. A `min: 1` would have read as tightening a bound
   * and would have broken a control that is already shipped.
   */
  test('a zero width with a zero queue stays legal — it sheds every hash, it does not hang', async () => {
    const gate = createKdfGate({ maxConcurrent: 0, maxQueued: 0 });
    const answer = await gate.run(async () => 'hashed').catch((error: unknown) => error);
    expect(answer instanceof AuthError ? answer.code : answer).toBe('X_OVERLOADED');
  });

  test('the shipped defaults pass their own screen', () => {
    expect(createKdfGate(DEFAULT_KDF_LIMITS)).toBeDefined();
  });
});
