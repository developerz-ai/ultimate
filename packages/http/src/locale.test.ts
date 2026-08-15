// Every date and number the app formats is formatted from what this negotiation returns —
// there is no ambient locale or time zone to fall back on anywhere in the framework. These
// tests pin the fallback chain so a header we cannot honour degrades to the configured
// default instead of to a zone no formatter accepts.
import { describe, expect, test } from 'bun:test';
import { isValidTimeZone, negotiateLocale, readCookie, resolveTimeZone } from './locale';

describe('readCookie', () => {
  test('a null header returns null', () => {
    expect(readCookie(null, 'x-locale')).toBeNull();
  });

  test('a header without the named cookie returns null', () => {
    expect(readCookie('foo=bar', 'x-locale')).toBeNull();
  });

  test('a single matching cookie is URI-decoded', () => {
    expect(readCookie('x-locale=en%2DUS', 'x-locale')).toBe('en-US');
  });

  test('finds the target among multiple "; "-separated cookies when it is not first', () => {
    expect(readCookie('foo=bar; x-locale=de', 'x-locale')).toBe('de');
  });

  test('trims whitespace around the name and value', () => {
    expect(readCookie('foo=bar;  x-locale = de ; baz=qux', 'x-locale')).toBe('de');
  });

  // `Cookie:` is attacker-controlled and this runs in the `locale` stage, on every request. A bare
  // `URIError` there is a 500 and a page for the on-call, sent by `curl -H 'Cookie: x-locale=%'`.
  test('a malformed escape yields the raw value instead of throwing', () => {
    expect(readCookie('x-locale=%', 'x-locale')).toBe('%');
    expect(readCookie('x-locale=%ZZ', 'x-locale')).toBe('%ZZ');
    expect(readCookie('foo=bar; x-timezone=%E0%A4%A', 'x-timezone')).toBe('%E0%A4%A');
    // …and it degrades to the configured default rather than to a value nothing can format.
    expect(negotiateLocale(null, undefined, readCookie('x-locale=%', 'x-locale'))).toBe('en');
    expect(resolveTimeZone(readCookie('x-timezone=%', 'x-timezone'))).toBe('UTC');
  });
});

describe('negotiateLocale', () => {
  const config = { supported: ['en', 'de-CH'], default: 'en', cookie: 'x-locale' };

  test('an explicit locale that resolves to a supported entry takes priority over accept-language', () => {
    expect(negotiateLocale('en', config, 'de-CH')).toBe('de-CH');
  });

  test('an explicit locale that does not resolve falls back to accept-language negotiation', () => {
    expect(negotiateLocale('en', config, 'fr')).toBe('en');
  });

  test('a non-matching higher-q entry falls through to a matching lower-q entry', () => {
    expect(negotiateLocale('fr;q=0.9, de-CH;q=0.5', config)).toBe('de-CH');
  });

  test('q-weight ordering governs which entry resolves first, exact or primary-subtag alike', () => {
    // 'de' is not itself in `supported`, but sorts first by q (0.9 > 0.5) and
    // resolves via primary-subtag fallback to 'de-CH' before the lower-q,
    // exact-matching 'de-CH' entry is ever considered.
    expect(negotiateLocale('de-CH;q=0.5, de;q=0.9', config)).toBe('de-CH');
  });

  test('primary-subtag fallback matches a configured locale with a different region', () => {
    expect(negotiateLocale('de-DE', config)).toBe('de-CH');
  });

  test('a q=0 entry is excluded entirely', () => {
    expect(negotiateLocale('de-CH;q=0, en;q=0.5', config)).toBe('en');
  });

  test('a bare "*" breaks the loop instead of matching the next tag', () => {
    expect(negotiateLocale('*;q=0.9, de-CH;q=0.5', config)).toBe('en');
  });

  test('accept-language values are matched case-insensitively', () => {
    expect(negotiateLocale('EN-us', config)).toBe('en');
  });

  test('no match anywhere and no explicit locale returns the config default', () => {
    expect(negotiateLocale('fr', config)).toBe('en');
  });

  test('a null accept-language and no explicit locale returns the config default', () => {
    expect(negotiateLocale(null, config)).toBe('en');
  });
});

describe('isValidTimeZone', () => {
  test('accepts well-known IANA zones', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
  });

  test('rejects an unknown zone name and an empty string', () => {
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('resolveTimeZone', () => {
  const config = { default: 'Europe/Berlin', header: 'x-timezone', cookie: 'x-timezone' };

  test('a valid candidate passes through unchanged', () => {
    expect(resolveTimeZone('America/New_York', config)).toBe('America/New_York');
  });

  test('null falls back to the config default', () => {
    expect(resolveTimeZone(null, config)).toBe('Europe/Berlin');
  });

  test('an empty string falls back to the config default', () => {
    expect(resolveTimeZone('', config)).toBe('Europe/Berlin');
  });

  test('an invalid IANA name falls back to the config default', () => {
    expect(resolveTimeZone('Not/AZone', config)).toBe('Europe/Berlin');
  });

  test('omitting config uses DEFAULT_TZ_CONFIG, whose default is UTC', () => {
    expect(resolveTimeZone(null)).toBe('UTC');
  });
});
