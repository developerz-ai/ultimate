// What this file still owns after the negotiators moved to their owners: reading a named cookie
// off an attacker-controlled `Cookie:` header without throwing, and the two config objects that
// say only WHERE the request's locale and zone are read from. What a locale or a zone IS is
// asserted in `@ultimat3/i18n` and `@ultimat3/time`; the request path is `locale-stage.test.ts`.
import { describe, expect, test } from 'bun:test';
import { LOCALE_COOKIE } from '@ultimat3/i18n';
import { TIMEZONE_HEADER } from '@ultimat3/time';
import { DEFAULT_LOCALE_CONFIG, DEFAULT_TZ_CONFIG, readCookie } from './locale';

describe('readCookie', () => {
  test('a null header returns null', () => {
    expect(readCookie(null, 'x_locale')).toBeNull();
  });

  test('a header without the named cookie returns null', () => {
    expect(readCookie('foo=bar', 'x_locale')).toBeNull();
  });

  test('a single matching cookie is URI-decoded', () => {
    expect(readCookie('x_locale=en%2DUS', 'x_locale')).toBe('en-US');
  });

  test('finds the target among multiple "; "-separated cookies when it is not first', () => {
    expect(readCookie('foo=bar; x_locale=de', 'x_locale')).toBe('de');
  });

  test('trims whitespace around the name and value', () => {
    expect(readCookie('foo=bar;  x_locale = de ; baz=qux', 'x_locale')).toBe('de');
  });

  // `Cookie:` is attacker-controlled and this runs in the `locale` stage, on every request. A bare
  // `URIError` there is a 500 and a page for the on-call, sent by `curl -H 'Cookie: x_locale=%'`.
  test('a malformed escape yields the raw value instead of throwing', () => {
    expect(readCookie('x_locale=%', 'x_locale')).toBe('%');
    expect(readCookie('x_locale=%ZZ', 'x_locale')).toBe('%ZZ');
    expect(readCookie('foo=bar; x_timezone=%E0%A4%A', 'x_timezone')).toBe('%E0%A4%A');
  });
});

describe('the request-scoped config', () => {
  // A switcher writes the cookie `@ultimat3/i18n` documents, and a client sets the header
  // `@ultimat3/time` documents. This package spelling either one itself is how `x-locale` shipped
  // beside `LOCALE_COOKIE` and neither side ever read the other.
  test('names come from the owning packages, never from a literal here', () => {
    expect(DEFAULT_LOCALE_CONFIG.cookie).toBe(LOCALE_COOKIE);
    expect(DEFAULT_TZ_CONFIG.header).toBe(TIMEZONE_HEADER);
  });
});
