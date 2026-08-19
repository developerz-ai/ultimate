// The jar a session carries is every domain the browser touched, so "which cookie may this URL
// see" is an authorization decision. Both directions of the boundary are pinned here: a suffix
// that is not a domain (`evilbank.test` for `bank.test`) and a host-only cookie reaching down into
// a subdomain (`sub.bank.test`).

import { describe, expect, test } from 'bun:test';
import {
  cookieDomainMatches,
  cookieHeaderFor,
  cookiePathMatches,
  cookiesForUrl,
} from './cookie-scope';
import type { ScrapeCookie } from './target';

const cookie = (over: Partial<ScrapeCookie> = {}): ScrapeCookie => ({
  name: 'sid',
  value: 'SECRET',
  domain: 'bank.test',
  path: '/',
  httpOnly: true,
  secure: true,
  ...over,
});

describe('unit · domain-match, RFC 6265 §5.1.3', () => {
  test('a suffix is not a domain — evilbank.test does not match bank.test', () => {
    expect(cookieDomainMatches('evilbank.test', 'bank.test')).toBe(false);
    expect(cookieDomainMatches('evilbank.test', '.bank.test')).toBe(false);
  });

  test('a host-only cookie stays on its host — sub.bank.test does not match bank.test', () => {
    expect(cookieDomainMatches('sub.bank.test', 'bank.test')).toBe(false);
  });

  test('a domain-scoped cookie reaches the apex and its subdomains', () => {
    expect(cookieDomainMatches('bank.test', '.bank.test')).toBe(true);
    expect(cookieDomainMatches('sub.bank.test', '.bank.test')).toBe(true);
    expect(cookieDomainMatches('a.b.bank.test', '.bank.test')).toBe(true);
  });

  test('the exact host always matches, whatever the case', () => {
    expect(cookieDomainMatches('BANK.test', 'bank.TEST')).toBe(true);
  });

  test('an empty domain matches nothing — a jar entry with no scope is not a wildcard', () => {
    expect(cookieDomainMatches('bank.test', '')).toBe(false);
    expect(cookieDomainMatches('bank.test', '.')).toBe(false);
  });
});

describe('unit · path-match, RFC 6265 §5.1.4', () => {
  test('the boundary is a slash, so /admin never covers /administrators', () => {
    expect(cookiePathMatches('/admin', '/admin')).toBe(true);
    expect(cookiePathMatches('/admin/users', '/admin')).toBe(true);
    expect(cookiePathMatches('/administrators', '/admin')).toBe(false);
  });

  test('a trailing slash on the cookie path is its own boundary', () => {
    expect(cookiePathMatches('/admin/users', '/admin/')).toBe(true);
    expect(cookiePathMatches('/admin', '/admin/')).toBe(false);
  });

  test('an absent path is /', () => {
    expect(cookiePathMatches('/anything', '')).toBe(true);
  });
});

describe('unit · the jar a request may see', () => {
  const jar = [
    cookie({ name: 'host-only' }),
    cookie({ name: 'scoped', domain: '.bank.test' }),
    cookie({ name: 'admin', path: '/admin' }),
    cookie({ name: 'plain', secure: false, domain: 'shop.test' }),
  ];

  test('the two leaks this file exists for are refused', () => {
    expect(cookiesForUrl(jar, 'https://evilbank.test/a')).toEqual([]);
    expect(cookiesForUrl(jar, 'https://sub.bank.test/a').map((c) => c.name)).toEqual(['scoped']);
  });

  test('the legitimate cases still carry — the fix cannot pass by refusing everything', () => {
    expect(cookieHeaderFor(jar, 'https://bank.test/')).toBe('host-only=SECRET; scoped=SECRET');
    expect(cookiesForUrl(jar, 'https://bank.test/admin/users').map((c) => c.name)).toEqual([
      'host-only',
      'scoped',
      'admin',
    ]);
  });

  test('a secure cookie is not handed to plaintext, and a plain one is', () => {
    expect(cookiesForUrl(jar, 'http://bank.test/')).toEqual([]);
    expect(cookiesForUrl(jar, 'http://shop.test/').map((c) => c.name)).toEqual(['plain']);
    // Every browser trusts loopback; a fixture on http://localhost keeps working.
    expect(cookiesForUrl([cookie({ domain: 'localhost' })], 'http://localhost:3000/')).toHaveLength(
      1,
    );
  });

  test('a URL that will not parse gets nothing — the same fail-closed rule hostDecision uses', () => {
    expect(cookiesForUrl(jar, 'not a url')).toEqual([]);
    expect(cookieHeaderFor(jar, 'not a url')).toBeUndefined();
  });
});
