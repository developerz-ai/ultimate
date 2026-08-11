// The session cookie and the token behind it: what the cookie is called, how the token is hashed
// before it is stored, and the `SessionService` the request context carries. `shared/` is a leaf,
// so nothing here reads a database — `app/auth/service.ts` resolves the actor and hands it in.

import type { Ctx } from '@ultimat3/core';
import { createContext, runWithContext, tryUseContext, withChildContext } from '@ultimat3/core';
import type { Actor, SessionService } from './actor';

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

/** One cookie out of a `Cookie:` header. Returns null rather than '' so "absent" has one spelling. */
export const readCookie = (header: string | null, name: string): string | null => {
  if (header === null) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value.length === 0 ? null : decodeURIComponent(value);
  }
  return null;
};

/** Both names are read, because the same browser may hold a cookie set before TLS was in front. */
export const readSessionToken = (header: string | null): string | null =>
  readCookie(header, SESSION_COOKIE_SECURE) ?? readCookie(header, SESSION_COOKIE_PLAIN);

export interface SessionCookieOptions {
  readonly token: string;
  /** `true` in production. Selects the `__Host-` name AND the `Secure` attribute, from one fact. */
  readonly secure: boolean;
  readonly maxAgeSeconds: number;
}

/**
 * `SameSite=Lax` rather than `Strict`: the sign-in flow is a top-level POST from a page on this
 * origin, which Lax allows and Strict would too — but a link followed in from anywhere else must
 * still arrive signed in, or every shared URL logs the reader out.
 */
export const sessionCookie = (options: SessionCookieOptions): string =>
  [
    `${sessionCookieName(options.secure)}=${options.token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    ...(options.secure ? ['Secure'] : []),
  ].join('; ');

/** Same name and attributes, zero lifetime: a browser only drops a cookie it can match exactly. */
export const clearedSessionCookie = (secure: boolean): string =>
  sessionCookie({ token: '', secure, maxAgeSeconds: 0 });

/**
 * The service `ctx.session` is. A closure over an actor that was resolved ONCE, before the render
 * started — `viewer()` is called from synchronous policy predicates, once per subscriber per
 * change on a live query, so it may not await and may not fetch.
 */
export const sessionService = (actor: Actor | null): SessionService => ({
  viewer: () => actor,
});

/**
 * Run `fn` with this viewer installed on the ambient context.
 *
 * The two branches are `@ultimat3/action`'s own idiom (`packages/action/src/invoke.ts:72`): inside
 * a request there is a context to narrow, and outside one — a test, a job — there is not, and
 * `withChildContext` would throw `X_NO_CONTEXT` instead of doing the obvious thing.
 */
export const withSession = <T>(actor: Actor | null, fn: () => T): T => {
  const services = { session: sessionService(actor) };
  const base: Ctx | undefined = tryUseContext();
  return base === undefined
    ? runWithContext(createContext({ services }), fn)
    : withChildContext({ services }, fn);
};

/**
 * A context that is carrying response headers. Read structurally rather than cast, because this is
 * the one thing the app cannot prove: the object the pipeline publishes through ALS is
 * `@ultimat3/http`'s `RequestContext` cast to core's `Ctx` (`packages/http/src/context.ts:102`),
 * and `Ctx` declares no `headers`. A context with none — a job, a unit test — must answer "no",
 * not throw.
 */
const carriesHeaders = (ctx: unknown): ctx is { readonly headers: Headers } =>
  typeof ctx === 'object' && ctx !== null && 'headers' in ctx && ctx.headers instanceof Headers;

/**
 * Put a `Set-Cookie` on the response the pipeline is about to send, and say whether it landed.
 *
 * The pipeline's last stage copies `ctx.headers` onto whatever the handler returned
 * (`packages/http/src/pipeline.ts:341`), so this is how an action — whose return value is JSON and
 * nothing else — sets a cookie. The boolean is not decoration: a caller that silently succeeded
 * off-request would issue a session token nobody can ever present.
 */
export const setResponseCookie = (ctx: unknown, cookie: string): boolean => {
  if (!carriesHeaders(ctx)) return false;
  ctx.headers.set('set-cookie', cookie);
  return true;
};

/** `https` in production only. The same fact picks the cookie name and the `Secure` attribute. */
export const isSecureRequest = (ctx: unknown): boolean =>
  typeof ctx === 'object' && ctx !== null && 'https' in ctx && ctx.https === true;

/** A context that can still reach the request it was built for. Nothing in the framework is one. */
interface RequestCarrier {
  readonly request: { readonly headers: Headers };
}

const carriesRequest = (ctx: unknown): ctx is RequestCarrier => {
  if (typeof ctx !== 'object' || ctx === null || !('request' in ctx)) return false;
  const request: unknown = ctx.request;
  return (
    typeof request === 'object' &&
    request !== null &&
    'headers' in request &&
    request.headers instanceof Headers
  );
};

/**
 * The `Cookie:` header of the request being served — and **today it is always `null`**.
 *
 * That is a framework gap, written as a probe rather than a stub so it starts working the moment
 * the gap closes. The context published through ALS is `@ultimat3/http`'s `RequestContext`
 * (`packages/http/src/context.ts:23`), which carries the RESPONSE headers, the url, the actor and
 * the matched route — and no reference to the `UltimateRequest` beside it. `hooks.authenticate`
 * (`packages/http/src/hooks.ts:20`) is the seam that WOULD read the cookie, and `x dev` hard-wires
 * it to `devHooks()` (`packages/cli/src/dev-roles.ts:131`), which supplies only `authorize`.
 *
 * So an app can SET a session cookie and can never read one back. Everything downstream of this
 * function is written and tested against a token; only its source is missing.
 */
export const requestCookieHeader = (ctx: unknown): string | null =>
  carriesRequest(ctx) ? ctx.request.headers.get('cookie') : null;

export const requestSessionToken = (ctx: unknown): string | null =>
  readSessionToken(requestCookieHeader(ctx));
