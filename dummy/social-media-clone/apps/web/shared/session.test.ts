// unit — the cookie and the token. No database and no request: these are string functions, and
// the reason they are string functions is that everything security-relevant about a session cookie
// is decided before any I/O happens.

import { userId } from '@social-media-clone/domain';
import { expect, unitTest } from '@ultimat3/testing';
import type { Actor } from './actor';
import { currentViewer, isBlocked, isFriend } from './actor';
import {
  clearedSessionCookie,
  hashToken,
  newSessionToken,
  readCookie,
  readSessionToken,
  SESSION_COOKIE_PLAIN,
  SESSION_COOKIE_SECURE,
  sessionCookie,
  sessionCookieName,
  setResponseCookie,
  withSession,
} from './session';

unitTest('the __Host- prefix is chosen by the same flag that makes it legal', () => {
  // A browser REFUSES a `__Host-` cookie without `Secure`, and `Secure` needs https. Pinning the
  // prefix would mean a dev sign-in that appears to work and keeps no cookie at all.
  expect(sessionCookieName(true)).toBe(SESSION_COOKIE_SECURE);
  expect(sessionCookieName(false)).toBe(SESSION_COOKIE_PLAIN);
  expect(SESSION_COOKIE_SECURE.startsWith('__Host-')).toBe(true);
});

unitTest('a secure cookie carries every attribute __Host- requires', () => {
  const cookie = sessionCookie({ token: 'abc', secure: true, maxAgeSeconds: 600 });
  expect(cookie.startsWith(`${SESSION_COOKIE_SECURE}=abc`)).toBe(true);
  // `__Host-` demands Secure and Path=/ and forbids Domain. All three, or the browser drops it.
  for (const attribute of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax', 'Max-Age=600']) {
    expect(cookie).toContain(attribute);
  }
  expect(cookie).not.toContain('Domain=');
});

unitTest('an insecure cookie is still HttpOnly — the prefix is the only thing that moves', () => {
  const cookie = sessionCookie({ token: 'abc', secure: false, maxAgeSeconds: 600 });
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Lax');
  // No `Secure` over http, and therefore no `__Host-` name either. One fact, both effects.
  expect(cookie).not.toContain('Secure');
  expect(cookie.startsWith(`${SESSION_COOKIE_PLAIN}=`)).toBe(true);
});

unitTest('clearing keeps the name and the attributes and zeroes the lifetime', () => {
  // A browser only drops a cookie it can match exactly, so a "clear" that changed the name would
  // leave the real cookie in place and look like a sign-out.
  const cleared = clearedSessionCookie(false);
  expect(cleared.startsWith(`${SESSION_COOKIE_PLAIN}=;`)).toBe(true);
  expect(cleared).toContain('Max-Age=0');
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

unitTest('the secure name wins when a browser is holding both', () => {
  const header = `${SESSION_COOKIE_PLAIN}=old; ${SESSION_COOKIE_SECURE}=new`;
  expect(readSessionToken(header)).toBe('new');
  expect(readSessionToken(`${SESSION_COOKIE_PLAIN}=only`)).toBe('only');
  expect(readSessionToken('')).toBe(null);
});

unitTest('setting a cookie off-request reports failure instead of pretending', () => {
  // A job, a scheduler, a unit test: there is no response to put a header on, and silently
  // succeeding would issue a session token nobody can ever present.
  expect(setResponseCookie({}, 'a=b')).toBe(false);
  expect(setResponseCookie(null, 'a=b')).toBe(false);

  const ctx = { headers: new Headers() };
  expect(setResponseCookie(ctx, 'a=b')).toBe(true);
  expect(ctx.headers.get('set-cookie')).toBe('a=b');
});

const ADA = userId('00000000-0000-4000-8000-00000000000a');
const MARA = userId('00000000-0000-4000-8000-00000000000c');

const viewer: Actor = {
  id: ADA,
  role: 'member',
  friendIds: new Set([MARA]),
  blockedIds: new Set([MARA]),
};

unitTest('withSession installs the viewer that `currentViewer()` reads', () => {
  // This is the contract `shared/actor.ts` declares and this file implements: a policy predicate
  // calls `currentViewer()` synchronously, so the actor has to already be on the context.
  const seen = withSession(viewer, () => {
    expect(isFriend(currentViewer(), MARA)).toBe(true);
    expect(isBlocked(currentViewer(), MARA)).toBe(true);
    return currentViewer();
  });
  expect(seen?.id).toBe(ADA);
});

unitTest('withSession installs "nobody" as a value, never as a missing service', () => {
  // A signed-out request still has a session service; it answers null. The alternative is
  // `ctx.session` being undefined, which is a TypeError inside a predicate rather than a denial.
  expect(withSession(null, () => currentViewer())).toBe(null);
});
