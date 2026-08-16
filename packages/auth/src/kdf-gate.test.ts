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
