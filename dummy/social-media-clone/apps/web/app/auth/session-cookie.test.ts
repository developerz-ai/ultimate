// unit — the session cookie as it lands on a response. Run inside a real request context, because
// the bug this pins lived in the write, not the string: the app's own `ctx.headers.set` replaced
// any cookie already on the response, so a sign-in beside a second cookie reached the browser alone.

import { createContext, isUltimateError, runWithContext } from '@ultimat3/core';
import { asCtx, createRequestContext, defineHttpConfig, setCookie } from '@ultimat3/http';
import { expect, unitTest } from '@ultimat3/testing';
import { SESSION_COOKIE_PLAIN, SESSION_COOKIE_SECURE } from '../../shared/session';
import { clearSessionCookie, writeSessionCookie } from './session-cookie';

const config = defineHttpConfig({ rateLimit: { scope: 'process' } });

/** Every `Set-Cookie` line `fn` leaves on the response of one request. */
const cookiesAfter = (fn: () => void): readonly string[] => {
  const ctx = createRequestContext({
    url: new URL('https://app.test/api/sessions/create'),
    method: 'POST',
    role: 'web',
    config,
  });
  runWithContext(asCtx(ctx), fn);
  return ctx.headers.getSetCookie();
};

unitTest('two cookies on one response both survive — the session never overwrites', () => {
  const lines = cookiesAfter(() => {
    setCookie('x_locale', 'es', { httpOnly: false });
    writeSessionCookie('abc', true, 600);
  });
  expect(lines).toHaveLength(2);
  expect(lines[0]?.startsWith('x_locale=es;')).toBe(true);
  expect(lines[1]?.startsWith(`${SESSION_COOKIE_SECURE}=abc;`)).toBe(true);
});

unitTest('a secure cookie carries every attribute __Host- requires', () => {
  const [cookie = ''] = cookiesAfter(() => writeSessionCookie('abc', true, 600));
  // `__Host-` demands Secure and Path=/ and forbids Domain. All three, or the browser drops it.
  for (const attribute of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax', 'Max-Age=600']) {
    expect(cookie).toContain(attribute);
  }
  expect(cookie).not.toContain('Domain=');
});

unitTest('an insecure cookie is still HttpOnly — the prefix is the only thing that moves', () => {
  const [cookie = ''] = cookiesAfter(() => writeSessionCookie('abc', false, 600));
  expect(cookie.startsWith(`${SESSION_COOKIE_PLAIN}=abc;`)).toBe(true);
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Lax');
  // No `Secure` over http, and therefore no `__Host-` name either. One fact, both effects.
  expect(cookie).not.toContain('Secure');
});

unitTest('clearing keeps the name and the attributes and zeroes the lifetime', () => {
  // A browser only drops a cookie it can match exactly, so a "clear" that changed the name would
  // leave the real cookie in place and look like a sign-out.
  const [cleared = ''] = cookiesAfter(() => clearSessionCookie(false));
  expect(cleared.startsWith(`${SESSION_COOKIE_PLAIN}=;`)).toBe(true);
  expect(cleared).toContain('Max-Age=0');
  expect(cleared).toContain('Path=/');
  const [secure = ''] = cookiesAfter(() => clearSessionCookie(true));
  expect(secure.startsWith(`${SESSION_COOKIE_SECURE}=;`)).toBe(true);
});

unitTest('a session that is about to expire still gets a cookie with a positive lifetime', () => {
  const [cookie = ''] = cookiesAfter(() => writeSessionCookie('abc', true, 0.4));
  expect(cookie).toContain('Max-Age=1');
});

/** The refusal's stable code — a bare `.toThrow()` would pass on an uncoded `TypeError` too. */
const codeOf = (fn: () => void): string => {
  try {
    fn();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not an UltimateError';
  }
  return 'did not throw';
};

unitTest('off-request it refuses rather than issuing a token nobody can present', () => {
  expect(codeOf(() => writeSessionCookie('abc', true, 600))).toBe('X_NO_CONTEXT');
  const job = createContext({ role: 'worker' });
  expect(codeOf(() => runWithContext(job, () => clearSessionCookie(true)))).toBe('X_NO_REQUEST');
});
