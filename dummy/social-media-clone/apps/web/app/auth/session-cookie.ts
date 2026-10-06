// The session cookie onto the response of the request in scope — the only place this app writes
// one. Through `@ultimat3/http`'s `setCookie`/`deleteCookie`, which APPEND a line built by core's one
// serializer: the hand-joined string and `ctx.headers.set` this replaced dropped any other cookie
// already on the response.

import { deleteCookie, setCookie } from '@ultimat3/http';
import { sessionCookieName } from '../../shared/session';

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
