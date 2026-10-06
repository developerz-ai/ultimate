// The one `Cookie:` reader. `@ultimat3/auth`, `@ultimat3/http` and `@ultimat3/i18n` each parsed the
// header themselves — two at tier 2 that could never import each other, one at tier 1 — and each
// had to rediscover that `decodeURIComponent('%')` throws on a client-authored value.

import { describe, expect, test } from 'bun:test';
import { readCookie, serializeSetCookie } from './cookie';
import { UltimateError } from './errors';

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

/** The coded refusal a call threw, or a failed test when it threw nothing or something uncoded. */
function refusal(run: () => unknown): UltimateError {
  try {
    run();
  } catch (error) {
    if (error instanceof UltimateError) return error;
    expect.unreachable(`threw an uncoded ${String(error)}`);
  }
  return expect.unreachable('serializeSetCookie accepted input it must refuse');
}

describe('serializeSetCookie', () => {
  test('the defaults are the ones auth already ships: Path=/, HttpOnly, Secure, SameSite=Lax', () => {
    expect(serializeSetCookie('sid', 'abc')).toBe(
      'sid=abc; Path=/; HttpOnly; Secure; SameSite=Lax',
    );
  });

  test('every option is written, in a fixed order', () => {
    const header = serializeSetCookie('sid', 'abc', {
      maxAge: 3600,
      expires: new Date(Date.UTC(2026, 9, 6, 7, 8, 9)),
      path: '/app',
      domain: 'example.com',
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
      partitioned: true,
      priority: 'High',
    });
    expect(header).toBe(
      'sid=abc; Max-Age=3600; Expires=Tue, 06 Oct 2026 07:08:09 GMT; Domain=example.com; ' +
        'Path=/app; HttpOnly; Secure; SameSite=Strict; Partitioned; Priority=High',
    );
  });

  test('a default turned off is omitted, never written as a false flag', () => {
    expect(serializeSetCookie('x_locale', 'de', { httpOnly: false, secure: false })).toBe(
      'x_locale=de; Path=/; SameSite=Lax',
    );
  });

  test('Max-Age 0 is written — it is how a cookie is cleared', () => {
    expect(serializeSetCookie('sid', '', { maxAge: 0 })).toBe(
      'sid=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
    );
  });

  test('Expires is an IMF-fixdate in UTC whatever the process zone, zero-padded', () => {
    const before = process.env.TZ;
    process.env.TZ = 'Pacific/Kiritimati';
    try {
      const at = new Date(Date.UTC(2027, 0, 2, 3, 4, 5));
      expect(serializeSetCookie('a', 'b', { expires: at })).toContain(
        'Expires=Sat, 02 Jan 2027 03:04:05 GMT',
      );
      // The day before in UTC is the same calendar day in +14:00 — the zone must not leak in.
      const lateUtc = new Date(Date.UTC(2026, 11, 31, 23, 59, 59));
      expect(serializeSetCookie('a', 'b', { expires: lateUtc })).toContain(
        'Expires=Thu, 31 Dec 2026 23:59:59 GMT',
      );
      expect(serializeSetCookie('a', 'b', { expires: new Date(0) })).toContain(
        'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      );
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  test('round-trips through readCookie for any well-formed string', () => {
    const values = [
      'abc',
      'a.b==',
      '',
      'two words',
      'a;b,c',
      '"quoted"',
      'back\\slash',
      '100%',
      '100%25',
      'tab\there',
      'line\nbreak',
      '\u0000\u007f',
      'Grüße 日本 🍪',
      'en-US',
    ];
    for (const value of values) {
      const header = serializeSetCookie('v', value);
      const pair = header.slice(0, header.indexOf(';'));
      expect(readCookie(`other=1; ${pair}`, 'v')).toBe(value);
    }
  });

  test('a value already made of cookie-octets is written byte-identical', () => {
    // Base64url tokens and sealed values: migrating auth onto this must not change wire bytes.
    const token = "AbC-_09.xyz==!#$&'()*+/:<>?@[]^`{|}~";
    expect(serializeSetCookie('sid', token).startsWith(`sid=${token};`)).toBe(true);
  });

  test('octets outside cookie-octet, and %, are percent-encoded so nothing can split the header', () => {
    const header = serializeSetCookie('v', 'a b;c,d"e\\f%g\r\nSet-Cookie: x=1');
    expect(header.startsWith('v=a%20b%3Bc%2Cd%22e%5Cf%25g%0D%0ASet-Cookie:%20x=1;')).toBe(true);
  });

  test('refuses a name that is not an RFC 6265 token', () => {
    for (const name of [
      '',
      'a b',
      'a;b',
      'a=b',
      'a,b',
      'a"b',
      'a/b',
      'a(b',
      'a\tb',
      'a\u0000',
      'é',
      '{a}',
    ]) {
      const error = refusal(() => serializeSetCookie(name, 'v'));
      expect(error.code).toBe('X_COOKIE_INVALID');
      expect(error.meta?.['field']).toBe('name');
    }
  });

  test('accepts every token character in a name', () => {
    const name = "Ab0!#$%&'*+-.^_`|~";
    expect(serializeSetCookie(name, 'v').startsWith(`${name}=v;`)).toBe(true);
  });

  test('refuses a value that is not well-formed UTF-16, rather than a bare URIError', () => {
    for (const value of ['lone \ud800 surrogate', 'trailing \udc00', '\udc00\ud800']) {
      const error = refusal(() => serializeSetCookie('v', value));
      expect(error.code).toBe('X_COOKIE_INVALID');
      expect(error.meta?.['field']).toBe('value');
    }
    expect(serializeSetCookie('v', '\ud83c\udf6a')).toStartWith('v=%F0%9F%8D%AA;');
  });

  test('refuses a cookie a browser would silently drop for size', () => {
    expect(serializeSetCookie('v', 'x'.repeat(4095)).length).toBeGreaterThan(4096);
    const error = refusal(() => serializeSetCookie('v', 'x'.repeat(4096)));
    expect(error.code).toBe('X_COOKIE_INVALID');
    expect(error.meta?.['field']).toBe('value');
  });

  test('refuses SameSite=None without Secure', () => {
    const error = refusal(() => serializeSetCookie('v', '1', { sameSite: 'None', secure: false }));
    expect(error.code).toBe('X_COOKIE_INVALID');
    expect(error.meta?.['field']).toBe('sameSite');
    expect(serializeSetCookie('v', '1', { sameSite: 'None' })).toContain('; Secure; SameSite=None');
  });

  test('refuses Partitioned without Secure', () => {
    const error = refusal(() => serializeSetCookie('v', '1', { partitioned: true, secure: false }));
    expect(error.meta?.['field']).toBe('partitioned');
  });

  test('refuses an unknown SameSite or Priority rather than writing it', () => {
    const sameSite = 'lax' as unknown as 'Lax';
    expect(refusal(() => serializeSetCookie('v', '1', { sameSite })).meta?.['field']).toBe(
      'sameSite',
    );
    const priority = 'urgent' as unknown as 'High';
    expect(refusal(() => serializeSetCookie('v', '1', { priority })).meta?.['field']).toBe(
      'priority',
    );
  });

  test('refuses a Max-Age that is not a non-negative integer', () => {
    for (const maxAge of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(refusal(() => serializeSetCookie('v', '1', { maxAge })).meta?.['field']).toBe(
        'maxAge',
      );
    }
  });

  test('refuses an Expires that is not a valid Date with a four-digit year a parser accepts', () => {
    const bad = [
      new Date(Number.NaN),
      new Date(Date.UTC(1600, 0, 1)),
      new Date(Date.UTC(10000, 0, 1)),
    ];
    for (const expires of bad) {
      expect(refusal(() => serializeSetCookie('v', '1', { expires })).meta?.['field']).toBe(
        'expires',
      );
    }
    const notDate = '2026-10-06' as unknown as Date;
    expect(refusal(() => serializeSetCookie('v', '1', { expires: notDate })).meta?.['field']).toBe(
      'expires',
    );
  });

  test('refuses a Path or Domain that could inject an attribute or a header', () => {
    for (const path of ['/a;HttpOnly', '/a\r\nX: y', 'relative', '']) {
      expect(refusal(() => serializeSetCookie('v', '1', { path })).meta?.['field']).toBe('path');
    }
    for (const domain of ['a.com;Secure', 'a .com', 'a..com', '-a.com', 'a.com\n', '']) {
      expect(refusal(() => serializeSetCookie('v', '1', { domain })).meta?.['field']).toBe(
        'domain',
      );
    }
    expect(serializeSetCookie('v', '1', { domain: '.Sub.example-1.com' })).toContain(
      '; Domain=.Sub.example-1.com;',
    );
  });

  test('__Secure- requires Secure', () => {
    expect(
      refusal(() => serializeSetCookie('__Secure-sid', '1', { secure: false })).meta?.['field'],
    ).toBe('name');
    expect(
      serializeSetCookie('__Secure-sid', '1', { domain: 'example.com', path: '/a' }),
    ).toContain('__Secure-sid=1;');
  });

  test('__Host- requires Secure, no Domain and Path=/', () => {
    expect(serializeSetCookie('__Host-sid', '1')).toBe(
      '__Host-sid=1; Path=/; HttpOnly; Secure; SameSite=Lax',
    );
    const cases = [{ secure: false }, { domain: 'example.com' }, { path: '/app' }] as const;
    for (const options of cases) {
      const error = refusal(() => serializeSetCookie('__Host-sid', '1', options));
      expect(error.code).toBe('X_COOKIE_INVALID');
      expect(error.meta?.['field']).toBe('name');
    }
  });

  test('the prefixes are matched case-insensitively, as browsers enforce them', () => {
    expect(
      refusal(() => serializeSetCookie('__host-sid', '1', { path: '/a' })).meta?.['field'],
    ).toBe('name');
    expect(
      refusal(() => serializeSetCookie('__SECURE-sid', '1', { secure: false })).meta?.['field'],
    ).toBe('name');
  });

  test('a refusal is instructions: a cause naming the field and a fix', () => {
    const error = refusal(() => serializeSetCookie('a b', 'v'));
    expect(error.cause).toContain('"a b"');
    expect(error.fix.length).toBeGreaterThan(0);
  });
});
