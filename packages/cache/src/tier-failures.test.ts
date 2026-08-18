// Swallowing a tier refusal is only correct if it stays visible: what is pinned here is that
// `bestEffort` hands back the tier's answer untouched on success, absorbs every throw shape on
// failure, and that the log it writes is bounded, newest-first and a copy.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { isolateTiers, resetTiers } from './invalidate';
import type { TierFailure } from './tier-failures';
import {
  bestEffort,
  isolateTierFailures,
  recentTierFailures,
  resetTierFailures,
} from './tier-failures';

// An empty log is what every assertion below counts from, so the per-test reset stays. The
// `resetTiers()` further down is the destructive one: it drops a neighbouring file's tiers,
// revalidator and both logs, and only this restores them.
const restoreTiers = isolateTiers();

beforeEach(() => {
  resetTierFailures();
});

afterAll(restoreTiers);

describe('bestEffort', () => {
  test('returns the tier answer unchanged and records nothing when the call succeeds', async () => {
    const answer = await bestEffort('lru', 'get', 'k', () =>
      Promise.resolve({ value: 'v', tags: [] }),
    );

    expect(answer).toEqual({ value: 'v', tags: [] });
    expect(recentTierFailures()).toEqual([]);
  });

  test('a resolved undefined is not a failure — a miss is an answer', async () => {
    const answer = await bestEffort('lru', 'get', 'k', () => Promise.resolve(undefined));

    expect(answer).toBeUndefined();
    expect(recentTierFailures()).toEqual([]);
  });

  test('a cache OFF the ladder degrades into the same one log', async () => {
    // `@ultimat3/query`'s read cache is not a rung of the ladder and refuses the same way. It has
    // to reach this log, not a private try/catch of its own: a second, invisible failure record
    // is exactly what one bounded log exists to prevent — and it needs a name it can pass
    // honestly, because attributing a query-cache refusal to `redis` is a lie in the `/_x` panel.
    const answer = await bestEffort('query-read', 'get', 'cache:posts', () =>
      Promise.reject(new Error('read cache is down')),
    );

    expect(answer).toBeUndefined();
    expect(recentTierFailures()[0]).toMatchObject({
      tier: 'query-read',
      op: 'get',
      key: 'cache:posts',
      // `renderThrowable`'s shape, not `error.message`: the name is carried because the renderer
      // that cannot throw is the only one a catch block may use.
      message: 'Error: read cache is down',
    });
  });

  test('a rejection resolves to undefined instead of propagating', async () => {
    const answer = await bestEffort('redis', 'set', 'k', () =>
      Promise.reject(new Error('connection refused')),
    );

    expect(answer).toBeUndefined();
    expect(recentTierFailures().length).toBe(1);
  });

  test('a synchronous throw inside the callback is absorbed too', async () => {
    const answer = await bestEffort('lru', 'set', 'k', (): Promise<void> => {
      throw new Error('sync boom');
    });

    expect(answer).toBeUndefined();
    expect(recentTierFailures()[0]?.message).toBe('Error: sync boom');
  });

  test('records tier, op, key, message and an ISO timestamp', async () => {
    await bestEffort('redis', 'del', 'feed:org-1', () => Promise.reject(new Error('no socket')));

    const [failure] = recentTierFailures();
    expect(failure?.tier).toBe('redis');
    expect(failure?.op).toBe('del');
    expect(failure?.key).toBe('feed:org-1');
    expect(failure?.message).toBe('Error: no socket');
    expect(failure?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('carries the X_* code when the tier threw an UltimateError', async () => {
    await bestEffort('lru', 'set', 'big', () =>
      Promise.reject(
        new UltimateError({ code: 'X_CACHE_TOO_LARGE', cause: 'too big', fix: 'raise maxBytes' }),
      ),
    );

    expect(recentTierFailures()[0]?.code).toBe('X_CACHE_TOO_LARGE');
  });

  test('omits the code entirely for a throw that is not an UltimateError', async () => {
    await bestEffort('cdn', 'set', 'k', () => Promise.reject(new Error('plain')));

    const [failure] = recentTierFailures();
    expect(failure?.code).toBeUndefined();
    expect(Object.hasOwn(failure ?? {}, 'code')).toBe(false);
  });

  test('renders a thrown non-Error rather than losing it', async () => {
    await bestEffort('redis', 'get', 'k', () => Promise.reject('just a string'));

    // Quoted, because `renderCauseValue` is the one renderer that cannot throw on an arbitrary
    // value, and a quoted string is what distinguishes a thrown `'null'` from a thrown `null`.
    expect(recentTierFailures()[0]?.message).toBe('"just a string"');
  });
});

describe('recentTierFailures', () => {
  test('is newest first', async () => {
    await bestEffort('lru', 'set', 'first', () => Promise.reject(new Error('one')));
    await bestEffort('redis', 'set', 'second', () => Promise.reject(new Error('two')));

    expect(recentTierFailures().map((failure) => failure.key)).toEqual(['second', 'first']);
  });

  test('is capped at 100 entries', async () => {
    for (let i = 0; i < 105; i += 1) {
      await bestEffort('lru', 'set', `k${i}`, () => Promise.reject(new Error(`boom ${i}`)));
    }

    const log = recentTierFailures();
    expect(log.length).toBe(100);
    expect(log[0]?.key).toBe('k104');
    expect(log.at(-1)?.key).toBe('k5');
  });

  test('hands back a copy: mutating it does not change the next answer', async () => {
    await bestEffort('lru', 'set', 'k', () => Promise.reject(new Error('boom')));

    const first = recentTierFailures() as TierFailure[];
    first.length = 0;

    expect(recentTierFailures().length).toBe(1);
  });
});

describe('resetTiers', () => {
  test('clears the swallowed-failure log too, not just the invalidation one', async () => {
    await bestEffort('lru', 'set', 'k', () => Promise.reject(new Error('boom')));
    expect(recentTierFailures().length).toBe(1);

    resetTiers();

    expect(recentTierFailures()).toEqual([]);
  });
});

describe('isolateTierFailures', () => {
  test('puts back exactly what it found, dropping only what was recorded after it', async () => {
    await bestEffort('lru', 'set', 'neighbour', () => Promise.reject(new Error('theirs')));

    const restore = isolateTierFailures();
    await bestEffort('redis', 'set', 'mine', () => Promise.reject(new Error('mine')));
    resetTierFailures();
    restore();

    expect(recentTierFailures().map((failure) => failure.key)).toEqual(['neighbour']);
  });
});

/**
 * The three sites `record()` reads a caught value at — `instanceof UltimateError`, `instanceof
 * Error`, `String(error)` — are all *calls* on a value this package did not build, and each one
 * can throw. A `bestEffort` that dies rendering the refusal it was absorbing replaces "that tier
 * did not answer" with a `TypeError` on the caller's business read, which is the one thing this
 * function exists to prevent.
 */
describe('bestEffort absorbs a throwable that fights being read', () => {
  /** `instanceof` runs this trap, so both `instanceof` probes throw before any renderer runs. */
  const trapped = (): unknown =>
    new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new TypeError('proxy trap');
        },
      },
    );

  test('a Proxy whose getPrototypeOf throws is still a recorded failure, not a rejection', async () => {
    const answer = await bestEffort('lru', 'get', 'k', () => Promise.reject(trapped()));

    expect(answer).toBeUndefined();
    const [failure] = recentTierFailures();
    expect(failure?.tier).toBe('lru');
    expect(failure?.key).toBe('k');
    expect(typeof failure?.message).toBe('string');
    // Nothing claimed a code: the probe answered "not an UltimateError" instead of throwing.
    expect(Object.hasOwn(failure ?? {}, 'code')).toBe(false);
  });

  test('a null-prototype object, which String() refuses to convert, is absorbed too', async () => {
    const answer = await bestEffort('redis', 'set', 'k', () =>
      Promise.reject(Object.create(null) as unknown),
    );

    expect(answer).toBeUndefined();
    expect(recentTierFailures()).toHaveLength(1);
    expect(typeof recentTierFailures()[0]?.message).toBe('string');
  });
});
