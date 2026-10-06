// The golden for moving auth's four `Set-Cookie` builders onto core's `serializeSetCookie`. BEFORE
// is the literal each one spelled until plan 101 sweep 10b, kept here verbatim; AFTER is what the
// serializer writes. A browser must store the same cookie from both — same pair, same attribute set
// (RFC 6265 §5.2 gives attribute ORDER no meaning) — and the exact AFTER bytes are pinned so a
// change to the serializer's output shows up here, named, rather than in a sign-in e2e.
import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import type { OAuthHandshake } from './oauth';
import {
  clearHandshakeCookie,
  handshakeCookie,
  handshakeCookieName,
  sealHandshake,
} from './oauth-cookie';
import { clearSessionCookie, DEFAULT_SESSION_POLICY, sessionCookie } from './session';

const POLICY = { ...DEFAULT_SESSION_POLICY, absoluteTtlMs: 3_600_000 };
const SEAL = { secret: 'a'.repeat(32), clock: frozenClock(new Date('2026-10-06T12:00:00.000Z')) };
const HANDSHAKE: OAuthHandshake = {
  provider: 'github',
  state: 'state-1',
  nonce: 'nonce-1',
  verifier: 'verifier-1',
  redirectUri: 'https://app.test/auth/callback',
  authorizeUrl: 'https://github.com/login/oauth/authorize?client_id=c',
};
const SEALED = sealHandshake(HANDSHAKE, SEAL);
const OAUTH = handshakeCookieName('github');

/** What auth spelled by hand before the migration — the BEFORE side, byte for byte. */
const BEFORE = {
  session: `__Host-x_session=tok_123.abc; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`,
  sessionRotated: `__Host-x_session=tok_123.abc; Path=/; Max-Age=90; HttpOnly; Secure; SameSite=Lax`,
  clearSession: `__Host-x_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  handshake: `${OAUTH}=${SEALED}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
  clearHandshake: `${OAUTH}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
} as const;

const AFTER = {
  session: sessionCookie('tok_123.abc', POLICY),
  sessionRotated: sessionCookie('tok_123.abc', POLICY, { maxAgeSeconds: 90 }),
  clearSession: clearSessionCookie(POLICY),
  handshake: handshakeCookie(HANDSHAKE, SEAL),
  clearHandshake: clearHandshakeCookie('github'),
} as const;

/** What a browser stores: the pair as written, and each attribute by case-insensitive name. */
const stored = (header: string) => {
  const [pair = '', ...attributes] = header.split('; ');
  return {
    pair,
    attributes: attributes
      .map((attribute) => {
        const equals = attribute.indexOf('=');
        return equals === -1
          ? attribute.toLowerCase()
          : `${attribute.slice(0, equals).toLowerCase()}=${attribute.slice(equals + 1)}`;
      })
      .sort(),
  };
};

describe("auth's cookies, before and after the one serializer", () => {
  for (const key of Object.keys(BEFORE) as (keyof typeof BEFORE)[]) {
    test(`${key}: a browser stores the same cookie from both`, () => {
      expect(stored(AFTER[key])).toEqual(stored(BEFORE[key]));
    });
  }

  test("the AFTER bytes are the serializer's: Max-Age before Path, nothing else moved", () => {
    expect(AFTER).toEqual({
      session: '__Host-x_session=tok_123.abc; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax',
      sessionRotated:
        '__Host-x_session=tok_123.abc; Max-Age=90; Path=/; HttpOnly; Secure; SameSite=Lax',
      clearSession: '__Host-x_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
      handshake: `${OAUTH}=${SEALED}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`,
      clearHandshake: `${OAUTH}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
    });
  });

  test('a cookie name a browser would mangle is refused now, where it used to be written', () => {
    const codeOf = (run: () => unknown): string => {
      try {
        run();
      } catch (error) {
        return isUltimateError(error) ? error.code : 'not an UltimateError';
      }
      return 'did not throw';
    };
    expect(codeOf(() => sessionCookie('t', POLICY, { name: 'x session' }))).toBe(
      'X_COOKIE_INVALID',
    );
    expect(codeOf(() => clearSessionCookie(POLICY, 'x;session'))).toBe('X_COOKIE_INVALID');
    expect(codeOf(() => clearHandshakeCookie('github', 'a b'))).toBe('X_COOKIE_INVALID');
  });
});
