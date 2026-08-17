// One locale, one formatter-cache key: every spelling `Intl` treats as the same locale has to
// collapse to one string before it reaches a cache, because the caller is `Accept-Language`.

import { describe, expect, test } from 'bun:test';
import { canonicalLocale } from './locale-canonical';

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
