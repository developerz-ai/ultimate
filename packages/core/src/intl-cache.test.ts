// The one bounded formatter cache and the one canonical key it is keyed on — two halves of one
// rule. It must reuse on the second ask, evict oldest-first at the cap, and collapse every
// spelling of a locale, because the keys are locales and zones a request header chooses.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, type UltimateError } from './errors';
import {
  assertLocale,
  cachedFormatter,
  canonicalLocale,
  localeInvalid,
  MAX_CACHED_FORMATTERS,
  MAX_LOCALE_EXCERPT,
} from './intl-cache';

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

describe('assertLocale', () => {
  test('canonicalizes a well-formed tag, so validating and keying are one step', () => {
    expect(assertLocale('EN-us')).toBe('en-US');
    expect(assertLocale('zz')).toBe('zz');
  });

  test('a tag Intl cannot parse is X_LOCALE_INVALID, never a bare RangeError', () => {
    // The tag arrives from `Accept-Language`, so a `RangeError` several frames from the header is
    // a caller-reachable uncoded throw. `@ultimat3/time` closed it at nine entry points and
    // `@ultimat3/money` at four; both read this one screen, because tier 1 has no sideways import.
    for (const tag of ['en_US', '', 'not a locale']) {
      let caught: unknown;
      try {
        assertLocale(tag);
      } catch (thrown) {
        caught = thrown;
      }
      expect(isUltimateError(caught)).toBe(true);
      expect((caught as UltimateError).code).toBe('X_LOCALE_INVALID');
      expect((caught as UltimateError).fix).toContain('supportedLocalesOf');
    }
  });

  test('the cause names the tag it refused', () => {
    expect(() => assertLocale('en_US')).toThrow(/en_US/);
  });
});

// A locale reaches this refusal from `?locale=`, a path segment or an action input, so the tag in
// it is a stranger's string on its way into a 400 body AND the shared log index (issue #366).
// Three properties, and the message is only one of them: bounded, escaped, and carried under a key
// a redactor can name.
describe('localeInvalid', () => {
  test('carries the tag under `meta.locale`, the one key a redactor can address', () => {
    // The half that did not exist at all: a value baked into a message string has no key left to
    // redact, which is the same argument `describeValue` is built on.
    expect(localeInvalid('en_US').meta?.['locale']).toBe('en_US');
  });

  test('a tag of a plausible length reads exactly as it always did', () => {
    // The diagnostic IS the message here — `describeValue` would render "a 5-character string" and
    // delete the only actionable content in a sentence whose whole job is to name the tag.
    expect(localeInvalid('en_US').cause).toContain('"en_US"');
    expect(localeInvalid('en_US').cause).not.toContain('truncated');
  });

  test('a tag past the cap is cut, and SAYS it was cut', () => {
    const long = 'x'.repeat(4096);
    const error = localeInvalid(long);
    expect(error.cause).toContain(`"${'x'.repeat(MAX_LOCALE_EXCERPT)}"`);
    expect(error.cause).not.toContain('x'.repeat(MAX_LOCALE_EXCERPT + 1));
    expect(error.cause).toContain('truncated');
    expect(error.cause.length).toBeLessThan(200);
    // The whole value still exists where a redactor — and only a redactor — has to deal with it.
    expect(error.meta?.['locale']).toBe(long);
  });

  test('a tag of exactly the cap is not marked truncated', () => {
    // A truncation marker on a complete value is the same lie in the other direction.
    const exact = 'y'.repeat(MAX_LOCALE_EXCERPT);
    expect(localeInvalid(exact).cause).toContain(`"${exact}"`);
    expect(localeInvalid(exact).cause).not.toContain('truncated');
  });

  test('the cap counts code points, so the excerpt never ends in half a pair', () => {
    // A lone surrogate is not text: it survives no encoder the log line crosses. The closing quote
    // sitting directly after 35 whole emoji is what proves the cut landed on a boundary.
    const error = localeInvalid('👍'.repeat(MAX_LOCALE_EXCERPT + 5));
    expect(error.cause).toContain(`"${'👍'.repeat(MAX_LOCALE_EXCERPT)}"`);
  });

  test('a control character cannot reach the rendered cause, so a tag cannot forge a log line', () => {
    const error = localeInvalid('en\nFAKE-LOG-LINE');
    expect(error.cause).not.toContain('\n');
    expect(error.cause).toContain(String.raw`\n`);
    expect(error.format().split('\n')).toHaveLength(3);
    // Escaped for the reader, intact for the machine.
    expect(error.meta?.['locale']).toBe('en\nFAKE-LOG-LINE');
  });
});
