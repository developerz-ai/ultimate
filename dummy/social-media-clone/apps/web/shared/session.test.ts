// unit — the cookie and the token. No database and no request: these are string functions, and
// the reason they are string functions is that everything security-relevant about a session cookie
// is decided before any I/O happens.

import { expect, unitTest } from '@ultimat3/testing';
import {
  hashToken,
  newSessionToken,
  readCookie,
  readSessionToken,
  SESSION_COOKIE_PLAIN,
  SESSION_COOKIE_SECURE,
  sessionCookieName,
} from './session';

unitTest('the __Host- prefix is chosen by the same flag that makes it legal', () => {
  // A browser REFUSES a `__Host-` cookie without `Secure`, and `Secure` needs https. Pinning the
  // prefix would mean a dev sign-in that appears to work and keeps no cookie at all.
  expect(sessionCookieName(true)).toBe(SESSION_COOKIE_SECURE);
  expect(sessionCookieName(false)).toBe(SESSION_COOKIE_PLAIN);
  expect(SESSION_COOKIE_SECURE.startsWith('__Host-')).toBe(true);
});

unitTest('the token is stored as a hash, and the hash is not the token', () => {
  const token = newSessionToken();
  const digest = hashToken(token);
  expect(digest).not.toBe(token);
  expect(digest).toHaveLength(64);
  // Deterministic, so a lookup by hash finds the row a sign-in wrote.
  expect(hashToken(token)).toBe(digest);
  // And it fits `sessions.tokenHash`, which is text(128).
  expect(digest.length).toBeLessThanOrEqual(128);
});

unitTest('two tokens are never the same', () => {
  const tokens = new Set(Array.from({ length: 64 }, () => newSessionToken()));
  expect(tokens.size).toBe(64);
  // 256 bits, base64url — long enough that guessing is not a strategy.
  expect([...tokens][0]?.length).toBeGreaterThanOrEqual(43);
});

unitTest('a cookie header is parsed by name, not by position', () => {
  const header = 'x_locale=en; smc_session=abc123; other=1';
  expect(readCookie(header, SESSION_COOKIE_PLAIN)).toBe('abc123');
  expect(readCookie(header, '__Host-smc_session')).toBe(null);
  // A prefix match would return `abc123` for `smc_sess` — the bug this asserts against.
  expect(readCookie(header, 'smc_sess')).toBe(null);
  expect(readCookie(null, SESSION_COOKIE_PLAIN)).toBe(null);
});

// The header is client-authored: `smc_session=%` used to be a bare `URIError` out of the
// authenticator, a 500 on every request that browser sent. Core's reader answers the raw value,
// which then matches no stored hash — an anonymous request, never a crash.
unitTest('a malformed escape is the raw value, and an empty one is absent', () => {
  expect(readCookie('smc_session=%', SESSION_COOKIE_PLAIN)).toBe('%');
  expect(readCookie('smc_session=%ZZ; other=1', SESSION_COOKIE_PLAIN)).toBe('%ZZ');
  expect(readCookie('smc_session=', SESSION_COOKIE_PLAIN)).toBe(null);
});

unitTest('the secure name wins when a browser is holding both', () => {
  const header = `${SESSION_COOKIE_PLAIN}=old; ${SESSION_COOKIE_SECURE}=new`;
  expect(readSessionToken(header)).toBe('new');
  expect(readSessionToken(`${SESSION_COOKIE_PLAIN}=only`)).toBe('only');
  expect(readSessionToken('')).toBe(null);
});
