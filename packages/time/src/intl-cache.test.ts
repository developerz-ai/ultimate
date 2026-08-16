import { describe, expect, test } from 'bun:test';
import { cachedFormatter, MAX_CACHED_FORMATTERS } from './intl-cache';

describe('cachedFormatter', () => {
  test('answers from the cache on the second ask', () => {
    const cache = new Map<string, number>();
    let built = 0;
    const build = (): number => {
      built += 1;
      return built;
    };
    expect(cachedFormatter(cache, 'en', build)).toBe(1);
    expect(cachedFormatter(cache, 'en', build)).toBe(1);
    expect(built).toBe(1);
  });

  test('evicts oldest-first at the cap, so a header cannot mint entries forever', () => {
    // The whole point: a locale or a zone arrives from a request header, and an unbounded Map
    // keyed on that string is memory the client chooses.
    const cache = new Map<string, number>();
    let built = 0;
    const build = (): number => {
      built += 1;
      return built;
    };
    for (let index = 0; index <= MAX_CACHED_FORMATTERS; index += 1) {
      cachedFormatter(cache, `key-${index}`, build);
    }
    expect(cache.size).toBe(MAX_CACHED_FORMATTERS);
    expect(built).toBe(MAX_CACHED_FORMATTERS + 1);
    // FIFO: the first key is the one that went.
    expect(cache.has('key-0')).toBe(false);
    expect(cache.has(`key-${MAX_CACHED_FORMATTERS}`)).toBe(true);
    cachedFormatter(cache, 'key-0', build);
    expect(built).toBe(MAX_CACHED_FORMATTERS + 2);
  });
});
