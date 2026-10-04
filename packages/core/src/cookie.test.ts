// The one `Cookie:` reader. `@ultimat3/auth`, `@ultimat3/http` and `@ultimat3/i18n` each parsed the
// header themselves — two at tier 2 that could never import each other, one at tier 1 — and each
// had to rediscover that `decodeURIComponent('%')` throws on a client-authored value.

import { describe, expect, test } from 'bun:test';
import { readCookie } from './cookie';

describe('readCookie', () => {
  test('an absent header or an absent cookie is null', () => {
    expect(readCookie(null, 'x_locale')).toBeNull();
    expect(readCookie(undefined, 'x_locale')).toBeNull();
    expect(readCookie('foo=bar', 'x_locale')).toBeNull();
    expect(readCookie('', 'x_locale')).toBeNull();
  });

  test('finds the named cookie among several, trimming the whitespace around names and values', () => {
    expect(readCookie('foo=bar; x_locale=de', 'x_locale')).toBe('de');
    expect(readCookie('foo=bar;  x_locale = de ; baz=qux', 'x_locale')).toBe('de');
  });

  test('a name is matched whole, never as a prefix or a suffix', () => {
    expect(readCookie('x_locale_old=fr; x_locale=de', 'x_locale')).toBe('de');
    expect(readCookie('a_x_locale=fr', 'x_locale')).toBeNull();
  });

  test('the first occurrence wins, and a part with no `=` is skipped', () => {
    expect(readCookie('junk; x=1; x=2', 'x')).toBe('1');
  });

  test('a value keeps every `=` after the first', () => {
    expect(readCookie('sealed=a.b==; other=1', 'sealed')).toBe('a.b==');
  });

  test('percent-decodes the value', () => {
    expect(readCookie('x_locale=en%2DUS', 'x_locale')).toBe('en-US');
  });

  test('a malformed escape is the raw value, never a thrown URIError', () => {
    expect(readCookie('x_locale=%', 'x_locale')).toBe('%');
    expect(readCookie('x_locale=%ZZ', 'x_locale')).toBe('%ZZ');
    expect(readCookie('foo=bar; x_timezone=%E0%A4%A', 'x_timezone')).toBe('%E0%A4%A');
  });

  test('a header that is not a string reads as no cookie rather than a bare TypeError', () => {
    expect(readCookie(42 as unknown as string, 'x')).toBeNull();
  });
});
