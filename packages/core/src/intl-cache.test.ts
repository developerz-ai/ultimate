// The one bounded formatter cache and the one canonical key it is keyed on — two halves of one
// rule. It must reuse on the second ask, evict oldest-first at the cap, and collapse every
// spelling of a locale, because the keys are locales and zones a request header chooses.

import { describe, expect, test } from 'bun:test';
import { cachedFormatter, canonicalLocale, MAX_CACHED_FORMATTERS } from './intl-cache';

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

  test('a stored value is a hit even when it is `undefined` — membership, not truthiness', () => {
    // Latent, not live: every shipped caller stores an `Intl.*` formatter. This pins the generic
    // contract `T` advertises — reading a hit off `get(key) !== undefined` makes a cache
    // instantiated with a nullable `T` rebuild on every single call, silently.
    const cache = new Map<string, number | undefined>();
    let built = 0;
    const build = (): number | undefined => {
      built += 1;
      return undefined;
    };
    expect(cachedFormatter(cache, 'en', build)).toBe(undefined);
    expect(cachedFormatter(cache, 'en', build)).toBe(undefined);
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

describe('canonicalLocale', () => {
  test('every spelling of one locale collapses to one key', () => {
    expect(canonicalLocale('EN-us')).toBe('en-US');
    expect(canonicalLocale('en-US')).toBe('en-US');
    expect(canonicalLocale('en-latn-us')).toBe('en-Latn-US');
    expect(canonicalLocale('DE')).toBe('de');
    // Casing inside a `-u-` extension collapses too; the *values* still do not, which is why
    // `intl-cache.ts` keeps its bound as well as this key.
    expect(canonicalLocale('de-DE-u-ca-Gregory')).toBe('de-DE-u-ca-gregory');
  });

  test('a tag Intl cannot parse is undefined, never a silent passthrough', () => {
    expect(canonicalLocale('en_US')).toBe(undefined);
    expect(canonicalLocale('')).toBe(undefined);
    expect(canonicalLocale('not a locale')).toBe(undefined);
  });

  test('well-formed but unknown to ICU is still a locale', () => {
    // `Intl` falls back for `zz`; refusing it here would be stricter than the formatters this
    // feeds, and would turn a fallback into an error for a tag that renders fine.
    expect(canonicalLocale('zz')).toBe('zz');
  });
});
