// The session cookie and the token behind it: what the cookie is called, how the token is hashed
// before it is stored, and how it is parsed back out of a `Cookie:` header. `shared/` is a leaf, so
// nothing here reads a database or a request — `app/auth/viewer.ts` turns the token into an actor,
// `app/auth/authenticator.ts` is what hands it the header, and `app/auth/session-cookie.ts` writes it.

import { readCookie as readCookieValue } from '@ultimat3/core';

/**
 * Two names for one cookie, chosen by the flag that makes the strong one legal.
 *
 * `__Host-` is the strongest prefix a browser enforces — same origin, `Path=/`, no `Domain`, and
 * **`Secure`** — and a browser silently REFUSES to store a `__Host-` cookie sent over `http`. `x
 * dev` serves `http://localhost`, so pinning the prefix would mean a demo where sign-in appears to
 * work and no cookie is ever kept. The prefix is therefore derived from `secure`, never declared
 * beside it: the two cannot disagree.
 */
export const SESSION_COOKIE_SECURE = '__Host-smc_session';
export const SESSION_COOKIE_PLAIN = 'smc_session';

export const sessionCookieName = (secure: boolean): string =>
  secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN;

/** Absolute expiry, matched by the `expiresAt` column. An idle timeout would be a second clock. */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const TOKEN_BYTES = 32;

const base64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

/** 256 bits from the CSPRNG. Never a uuid: a uuid v7 leaks its own creation time and is guessable. */
export const newSessionToken = (): string =>
  base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));

/**
 * What `sessions.tokenHash` holds. A leaked row must not be a usable cookie, which is the same
 * reason a password never lands in `users` — and it is why the lookup is a hash equality on a
 * unique index rather than a scan plus a comparison: there is nothing to compare in variable time.
 */
export const hashToken = (token: string): string =>
  new Bun.CryptoHasher('sha256').update(token).digest('hex');

/**
 * One cookie out of a `Cookie:` header, through the framework's one reader — which never throws on
 * a malformed escape. Returns null rather than '' so "absent" has one spelling.
 */
export const readCookie = (header: string | null, name: string): string | null => {
  const value = readCookieValue(header, name);
  return value === '' ? null : value;
};

/** Both names are read, because the same browser may hold a cookie set before TLS was in front. */
export const readSessionToken = (header: string | null): string | null =>
  readCookie(header, SESSION_COOKIE_SECURE) ?? readCookie(header, SESSION_COOKIE_PLAIN);

/** `https` in production only. The same fact picks the cookie name and the `Secure` attribute. */
export const isSecureRequest = (ctx: unknown): boolean =>
  typeof ctx === 'object' && ctx !== null && 'https' in ctx && ctx.https === true;
