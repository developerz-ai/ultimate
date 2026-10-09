// The session cookie: its name, its lifetime, reading it off a request and writing it onto the
// response in scope — the only place this app touches one. The token inside is `@ultimat3/auth`'s
// (`login()` mints it, `authenticate()` reads it back); this file owns only the cookie around it.
// Writes go through `@ultimat3/http`'s `setCookie`/`deleteCookie`, which APPEND a line built by
// core's one serializer, so no other cookie on the response is dropped.

import { readCookie } from '@ultimat3/core';
import { deleteCookie, setCookie } from '@ultimat3/http';

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

/** Absolute session lifetime — `appAuth()`'s session policy and the cookie's `Max-Age` both. */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** One cookie through the framework's one reader, which never throws. Absent has one spelling. */
const cookie = (header: string | null, name: string): string | null => {
  const value = readCookie(header, name);
  return value === '' ? null : value;
};

/** Both names are read, because the same browser may hold a cookie set before TLS was in front. */
export const readSessionToken = (header: string | null): string | null =>
  cookie(header, SESSION_COOKIE_SECURE) ?? cookie(header, SESSION_COOKIE_PLAIN);

/** `https` in production only. The same fact picks the cookie name and the `Secure` attribute. */
export const isSecureRequest = (ctx: unknown): boolean =>
  typeof ctx === 'object' && ctx !== null && 'https' in ctx && ctx.https === true;

/**
 * `SameSite=Lax` (the serializer's default) rather than `Strict`: the sign-in flow is a top-level
 * POST from a page on this origin, which Lax allows and Strict would too — but a link followed in
 * from anywhere else must still arrive signed in, or every shared URL logs the reader out.
 * `secure` picks the `__Host-` name AND the `Secure` attribute, from one fact. The lifetime is
 * floored at one second: `maxAge: 0` is a deletion, and a session issued is never one.
 */
export const writeSessionCookie = (token: string, secure: boolean, maxAgeSeconds: number): void =>
  setCookie(sessionCookieName(secure), token, {
    secure,
    maxAge: Math.max(1, Math.floor(maxAgeSeconds)),
  });

/** Same name, Path and flags, zero lifetime: a browser only drops a cookie it can match exactly. */
export const clearSessionCookie = (secure: boolean): void =>
  deleteCookie(sessionCookieName(secure), { secure });
