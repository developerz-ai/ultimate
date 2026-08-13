import { describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { CacheTooLargeError } from './errors';
import { estimateBytes, LruCache } from './lru';
import { tag } from './tags';

/** Manual clock: TTL tests must not depend on wall time. */
function fakeClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  } as Clock & { advance(ms: number): void };
}

const filler = (bytes: number): string => 'x'.repeat(bytes);

describe('LruCache byte budget', () => {
  test('evicts least-recently-used entries once the byte budget is exceeded', () => {
    const cache = new LruCache({ maxBytes: 400, defaultTtlMs: 0 });
    cache.set('a', filler(100));
    cache.set('b', filler(100));
    cache.set('c', filler(100));

    // Touch 'a' so 'b' becomes the eviction victim, not insertion order.
    expect(cache.get('a')).toBeDefined();
    cache.set('d', filler(100));

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('d')).toBeDefined();
    expect(cache.stats().bytes).toBeLessThanOrEqual(400);
    expect(cache.stats().evictions).toBe(1);
  });

  test('bytes accounting returns to zero when every entry is deleted', () => {
    const cache = new LruCache({ maxBytes: 10_000, defaultTtlMs: 0 });
    cache.set('a', { hello: 'world' });
    cache.set('b', [1, 2, 3]);
    expect(cache.stats().bytes).toBeGreaterThan(0);
    cache.del('a');
    cache.del('b');
    expect(cache.stats().bytes).toBe(0);
    expect(cache.stats().entries).toBe(0);
  });

  test('an entry larger than the whole budget throws X_CACHE_TOO_LARGE', () => {
    const cache = new LruCache({ maxBytes: 64 });
    expect(() => cache.set('big', filler(500))).toThrow(CacheTooLargeError);
    // The failed write must not corrupt accounting.
    expect(cache.stats().bytes).toBe(0);
  });

  test('entries expire on the injected clock, not wall time', () => {
    const clock = fakeClock(1_000_000);
    const cache = new LruCache({ maxBytes: 10_000, clock, defaultTtlMs: 1_000 });
    cache.set('a', 'v');
    expect(cache.get('a')?.value).toBe('v');
    clock.advance(1_001);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.stats().entries).toBe(0);
  });

  test('clear() resets hit/miss/eviction counters along with entries and bytes', () => {
    const cache = new LruCache({ maxBytes: 400, defaultTtlMs: 0 });
    cache.set('a', filler(100));
    cache.set('b', filler(100));
    cache.set('c', filler(100));
    expect(cache.get('a')).toBeDefined(); // a hit; also re-touches 'a' so 'b' is evicted next
    cache.set('d', filler(100)); // evicts 'b'
    expect(cache.get('b')).toBeUndefined(); // a miss
    const before = cache.stats();
    expect(before.evictions).toBeGreaterThan(0);
    expect(before.hits).toBeGreaterThan(0);
    expect(before.misses).toBeGreaterThan(0);

    cache.clear();

    expect(cache.stats()).toEqual({
      entries: 0,
      bytes: 0,
      maxBytes: 400,
      hits: 0,
      misses: 0,
      evictions: 0,
    });
  });
});

describe('LruCache tag invalidation', () => {
  test('invalidating a tag drops only entries carrying that tag', () => {
    const cache = new LruCache({ maxBytes: 10_000, defaultTtlMs: 0 });
    cache.set('post:list', ['a'], { tags: [tag('post')] });
    cache.set('post:1', { id: '1' }, { tags: [tag('post', '1')] });
    cache.set('post:2', { id: '2' }, { tags: [tag('post', '2')] });
    cache.set('user:list', ['u'], { tags: [tag('user')] });
    cache.set('untagged', 'keep');

    const removed = cache.invalidateTags([tag('post', '1')]);

    expect([...removed].sort()).toEqual(['post:1', 'post:list']);
    expect(cache.get('post:2')).toBeDefined();
    expect(cache.get('user:list')).toBeDefined();
    expect(cache.get('untagged')).toBeDefined();
  });

  test('invalidating a collection tag sweeps every row of that entity', () => {
    const cache = new LruCache({ maxBytes: 10_000, defaultTtlMs: 0 });
    cache.set('post:1', 1, { tags: [tag('post', '1')] });
    cache.set('post:2', 2, { tags: [tag('post', '2')] });
    cache.set('user:1', 3, { tags: [tag('user', '1')] });

    const removed = cache.invalidateTags([tag('post')]);

    expect([...removed].sort()).toEqual(['post:1', 'post:2']);
    expect(cache.get('user:1')).toBeDefined();
  });

  test('overwriting a key re-indexes its tags so the stale tag no longer matches', () => {
    const cache = new LruCache({ maxBytes: 10_000, defaultTtlMs: 0 });
    cache.set('k', 1, { tags: [tag('post', '1')] });
    cache.set('k', 2, { tags: [tag('user', '9')] });

    expect(cache.invalidateTags([tag('post')])).toEqual([]);
    expect(cache.get('k')?.value).toBe(2);
    expect(cache.invalidateTags([tag('user')])).toEqual(['k']);
  });
});

describe('estimateBytes', () => {
  test('measures utf-8 length, not code units', () => {
    expect(estimateBytes('abc')).toBe(3);
    expect(estimateBytes('€')).toBe(3);
    expect(estimateBytes(new Uint8Array(16))).toBe(16);
  });
});
