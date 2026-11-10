// Swallowing a tier refusal is only correct if it stays visible: what is pinned here is that
// `bestEffort` hands back the tier's answer untouched on success, absorbs every throw shape on
// failure, and that every refusal is one `cache.tier_failure` event on the bus.

import { describe, expect, test } from 'bun:test';
import { installLogSink, subscribe, UltimateError } from '@ultimat3/core';
import { recordCacheEvents } from './cache-events-fixture';
import { bestEffort } from './tier-failures';

const events = recordCacheEvents();

describe('bestEffort', () => {
  test('returns the tier answer unchanged and records nothing when the call succeeds', async () => {
    const answer = await bestEffort('lru', 'get', 'k', () =>
      Promise.resolve({ value: 'v', tags: [] }),
    );

    expect(answer).toEqual({ value: 'v', tags: [] });
    expect(events.failures()).toEqual([]);
  });

  test('a resolved undefined is not a failure — a miss is an answer', async () => {
    const answer = await bestEffort('lru', 'get', 'k', () => Promise.resolve(undefined));

    expect(answer).toBeUndefined();
    expect(events.failures()).toEqual([]);
  });

  test('a cache OFF the ladder degrades into the same one event', async () => {
    // `@ultimat3/query`'s read cache is not a rung of the ladder and refuses the same way. It has
    // to reach this log, not a private try/catch of its own: a second, invisible failure record
    // is exactly what one bounded log exists to prevent — and it needs a name it can pass
    // honestly, because attributing a query-cache refusal to `redis` is a lie in the `/_x` panel.
    const answer = await bestEffort('query-read', 'get', 'cache:posts', () =>
      Promise.reject(new Error('read cache is down')),
    );

    expect(answer).toBeUndefined();
    expect(events.failures()[0]).toMatchObject({
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
    expect(events.failures().length).toBe(1);
  });

  test('a synchronous throw inside the callback is absorbed too', async () => {
    const answer = await bestEffort('lru', 'set', 'k', (): Promise<void> => {
      throw new Error('sync boom');
    });

    expect(answer).toBeUndefined();
    expect(events.failures()[0]?.message).toBe('Error: sync boom');
  });

  test('emits tier, op, key and message — and no timestamp, a subscriber reads its own clock', async () => {
    await bestEffort('redis', 'del', 'feed:org-1', () => Promise.reject(new Error('no socket')));

    const [failure] = events.failures();
    expect(failure?.tier).toBe('redis');
    expect(failure?.op).toBe('del');
    expect(failure?.key).toBe('feed:org-1');
    expect(failure?.message).toBe('Error: no socket');
    expect(Object.hasOwn(failure ?? {}, 'at')).toBe(false);
  });

  test('carries the X_* code when the tier threw an UltimateError', async () => {
    await bestEffort('lru', 'set', 'big', () =>
      Promise.reject(
        new UltimateError({ code: 'X_CACHE_TOO_LARGE', cause: 'too big', fix: 'raise maxBytes' }),
      ),
    );

    expect(events.failures()[0]?.code).toBe('X_CACHE_TOO_LARGE');
  });

  test('omits the code entirely for a throw that is not an UltimateError', async () => {
    await bestEffort('cdn', 'set', 'k', () => Promise.reject(new Error('plain')));

    const [failure] = events.failures();
    expect(failure?.code).toBeUndefined();
    expect(Object.hasOwn(failure ?? {}, 'code')).toBe(false);
  });

  test('renders a thrown non-Error rather than losing it', async () => {
    await bestEffort('redis', 'get', 'k', () => Promise.reject('just a string'));

    // Quoted, because `renderCauseValue` is the one renderer that cannot throw on an arbitrary
    // value, and a quoted string is what distinguishes a thrown `'null'` from a thrown `null`.
    expect(events.failures()[0]?.message).toBe('"just a string"');
  });
});

describe('cache.tier_failure', () => {
  // Observability must never turn a degraded cache into a failed read: the bus contains a
  // subscriber that throws and logs it once.
  test('a throwing subscriber never escapes into the business read, and is logged once', async () => {
    const lines: string[] = [];
    const releaseLogSink = installLogSink((line) => void lines.push(line));
    const broken = new RangeError('subscriber is broken');
    const off = subscribe('cache.tier_failure', () => {
      throw broken;
    });
    try {
      for (let i = 0; i < 3; i += 1) {
        const answer = await bestEffort('redis', 'get', `k${i}`, () =>
          Promise.reject(new Error('down')),
        );
        expect(answer).toBeUndefined();
      }
    } finally {
      off();
      releaseLogSink();
    }
    expect(lines.filter((line) => line.includes('instrument.subscriber_failed'))).toHaveLength(1);
  });

  test('one event per absorbed refusal, every subscriber hearing it', async () => {
    const second: string[] = [];
    const off = subscribe('cache.tier_failure', (event) => void second.push(event.payload.key));
    try {
      await bestEffort('lru', 'set', 'first', () => Promise.reject(new Error('one')));
      await bestEffort('redis', 'set', 'second', () => Promise.reject(new Error('two')));
    } finally {
      off();
    }

    expect(events.failures().map((failure) => failure.key)).toEqual(['second', 'first']);
    expect(second).toEqual(['first', 'second']);
  });

  test('a call the tier answered emits nothing', async () => {
    expect(await bestEffort('lru', 'get', 'k', async () => 'value')).toBe('value');
    expect(events.failures()).toEqual([]);
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
    const [failure] = events.failures();
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
    expect(events.failures()).toHaveLength(1);
    expect(typeof events.failures()[0]?.message).toBe('string');
  });
});
