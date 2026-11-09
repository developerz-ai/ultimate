// The memo in front of image variants: one decode per key however many ask at once, a byte bound
// that holds, and the coldest entry out first. Each rule is a production failure when it breaks —
// a burst of first visitors decoding N times, or a process whose memory grows with its catalogue.

import { describe, expect, test } from 'bun:test';
import { variantLru } from './runtime-assets-site-cache';

/** A value is its own size: `'aaa'` costs 3 bytes. */
const bySize = (value: string): number => value.length;

const counted = () => {
  const made: string[] = [];
  const make = (key: string, value: string) => () => {
    made.push(key);
    return Promise.resolve(value);
  };
  return { made, make };
};

describe('unit · variantLru', () => {
  test('concurrent first requests for one key share one make', async () => {
    const lru = variantLru(100, bySize);
    const gate = Promise.withResolvers<string>();
    let calls = 0;
    const make = () => {
      calls += 1;
      return gate.promise;
    };
    const burst = [lru.get('k', make), lru.get('k', make), lru.get('k', make)];
    gate.resolve('abc');
    expect(await Promise.all(burst)).toEqual(['abc', 'abc', 'abc']);
    expect(calls).toBe(1);
  });

  test('a kept answer is served without making it again', async () => {
    const lru = variantLru(100, bySize);
    const { made, make } = counted();
    await lru.get('a', make('a', 'aaa'));
    expect(await lru.get('a', make('a', 'zzz'))).toBe('aaa');
    expect(made).toEqual(['a']);
  });

  test('the byte bound holds, evicting the least recently used first', async () => {
    const lru = variantLru(6, bySize);
    const { made, make } = counted();
    await lru.get('a', make('a', 'aaa'));
    await lru.get('b', make('b', 'bbb'));
    // A hit refreshes `a`: `b` is now the coldest.
    await lru.get('a', make('a', 'aaa'));
    await lru.get('c', make('c', 'ccc'));
    made.length = 0;
    await lru.get('a', make('a', 'aaa'));
    await lru.get('c', make('c', 'ccc'));
    expect(made).toEqual([]);
    await lru.get('b', make('b', 'bbb'));
    expect(made).toEqual(['b']);
  });

  test('an entry larger than the whole budget is answered and never kept', async () => {
    const lru = variantLru(4, bySize);
    const { made, make } = counted();
    expect(await lru.get('big', make('big', 'xxxxx'))).toBe('xxxxx');
    await lru.get('big', make('big', 'xxxxx'));
    expect(made).toEqual(['big', 'big']);
  });

  test('`sizeOf` answering undefined is answered and never kept', async () => {
    const lru = variantLru<string>(100, () => undefined);
    const { made, make } = counted();
    await lru.get('r', make('r', 'refused'));
    await lru.get('r', make('r', 'refused'));
    expect(made).toEqual(['r', 'r']);
  });

  test('a failed make is not kept: the next request tries again', async () => {
    const lru = variantLru(100, bySize);
    const failing = () => Promise.reject(new TypeError('decode failed'));
    await expect(lru.get('k', failing)).rejects.toThrow('decode failed');
    expect(await lru.get('k', () => Promise.resolve('ok'))).toBe('ok');
  });
});
