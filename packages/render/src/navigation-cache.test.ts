// The router's per-tab document memory: expiry, eviction, and that a failure is never remembered.
import { describe, expect, test } from 'bun:test';
import { cacheKey, NAVIGATION_CACHE_MAX_ENTRIES, navigationCache } from './navigation-cache';
import { NAVIGATION_CACHE_TTL_MS } from './navigation-rules';

const clock = () => {
  let at = 0;
  return {
    now: () => at,
    advance: (ms: number): void => {
      at += ms;
    },
  };
};

describe('navigationCache', () => {
  test('an entry is gone at the TTL, not after it', () => {
    const time = clock();
    const cache = navigationCache<string>({ now: time.now });
    cache.set('/a', Promise.resolve('a'));
    time.advance(NAVIGATION_CACHE_TTL_MS - 1);
    expect(cache.get('/a')).toBeDefined();
    time.advance(1);
    expect(cache.get('/a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test('a failed fetch is dropped, so the click after it asks again', async () => {
    const cache = navigationCache<string>();
    const failed = Promise.reject(new TypeError('network'));
    cache.set('/a', failed);
    await failed.catch(() => undefined);
    await Promise.resolve();
    expect(cache.get('/a')).toBeUndefined();
  });

  test('a failure does not drop the entry that replaced it', async () => {
    const cache = navigationCache<string>();
    let fail = (_e: Error): void => undefined;
    const first = new Promise<string>((_resolve, reject) => {
      fail = reject;
    });
    cache.set('/a', first);
    cache.set('/a', Promise.resolve('second'));
    fail(new TypeError('network'));
    await first.catch(() => undefined);
    await Promise.resolve();
    expect(await cache.get('/a')).toBe('second');
  });

  test('clear() empties it — what a POST does', () => {
    const cache = navigationCache<string>();
    cache.set('/a', Promise.resolve('a'));
    cache.set('/b', Promise.resolve('b'));
    cache.clear();
    expect([cache.get('/a'), cache.get('/b')]).toEqual([undefined, undefined]);
  });

  test('bounded, oldest first', () => {
    const cache = navigationCache<string>();
    for (let i = 0; i <= NAVIGATION_CACHE_MAX_ENTRIES; i += 1) {
      cache.set(`/p/${String(i)}`, Promise.resolve(String(i)));
    }
    expect(cache.size).toBe(NAVIGATION_CACHE_MAX_ENTRIES);
    expect(cache.get('/p/0')).toBeUndefined();
    expect(cache.get(`/p/${String(NAVIGATION_CACHE_MAX_ENTRIES)}`)).toBeDefined();
  });

  test('the fragment is not part of the key — the server never sees it', () => {
    const cache = navigationCache<string>();
    cache.set('https://app.test/a#one', Promise.resolve('a'));
    expect(cache.get('https://app.test/a#two')).toBeDefined();
    expect(cacheKey('https://app.test/a?q=1#x')).toBe('https://app.test/a?q=1');
  });
});

describe('navigationCache — keys and age', () => {
  test('query order is not part of the key: one query, however a link spells it', () => {
    expect(cacheKey('https://app.test/casos?b=2&a=1')).toBe(
      cacheKey('https://app.test/casos?a=1&b=2'),
    );
    expect(cacheKey('/casos?b=2&a=1#x')).toBe('/casos?a=1&b=2');
  });

  test('peek answers how old the held answer is — what a no-store reuse is judged by', () => {
    const time = clock();
    const cache = navigationCache<string>({ now: time.now });
    cache.set('/a', Promise.resolve('a'));
    time.advance(4_000);
    expect(cache.peek('/a')?.ageMs).toBe(4_000);
    expect(cache.peek('/b')).toBeUndefined();
  });
});
